# Sortis, build brief for Claude Code

Version 1.0, August 2026. Put this at `docs/BRIEF.md`. It is the source of truth. `CLAUDE.md` at the repo root is the short version that stays loaded.

Target: Zama Developer Program Mainnet Season 4. Deadline September 5 2026, 23:59 AOE (which is September 6, 16:59 PKT). Deploy on Sepolia.

\---

## 0\. What Sortis is

Sortis is confidential prize-linked savings. You deposit, you cannot lose your principal, the pooled yield is drawn as a prize on a schedule, and nothing about your position is visible to anyone: not your deposit, not your balance, not your odds, not whether you won.

The draw itself stays publicly verifiable. Anyone can check that the winning ticket was drawn from the committed tree root at the committed block. They just cannot see what is in the tree.

**The one sentence that matters:** every other entry in this bounty will encrypt the balances and then scan them linearly to pick a winner, which stops working past roughly forty depositors because of the FHEVM sequential depth budget. Sortis draws in O(log N).

**Core primitives (locked, do not redesign):**

|||
|-|-|
|Encrypted weight tree|A Fenwick/segment tree whose nodes are `euint64` sums of time-weighted balances. Draw walks root to leaf, one encrypted comparison per level. Deposits and withdrawals update one path.|
|Encrypted TWAB|Time-weighted average balance observations stored encrypted, so odds reflect how long money sat in the pool, not what was in it at the draw block. Late deposits cannot snipe a draw.|
|Native draw randomness|`FHE.randEuint64()` on the host chain. No oracle, no VRF, no external dependency to defend.|
|Winner-only disclosure|The prize ciphertext gets an ACL grant scoped to the drawn address. The public gets the tree root, the block, and the proof the walk was executed. Only the winner decrypts the number.|
|Epoch-batched wrapping|Wraps into cUSDT are queued and settled in epoch batches so the wrap step does not link a public USDT address to a confidential deposit.|

**Vocabulary. Use these exact words in UI, docs, contracts and errors.** Money is **committed**, not deposited. A user's position is a **stake**. The tree is the **register**. A prize round is a **draw**. The randomness is the **lot**. The winner is **drawn**. Money leaving is **released**. Never say "ticket", "odds", "lottery", "jackpot" or "gamble". This is savings with a prize, and the language has to carry that or the product reads as a casino.

\---

## 1\. The constraint everything is built around

Read this before writing a single line of Solidity.

FHEVM enforces two limits per transaction:

* **Global complexity: 20,000,000 HCU.** Operations that can run in parallel.
* **Sequential depth: 5,000,000 HCU.** The longest chain of operations that must run in order.

Exceeding either reverts the transaction. A dependent `FHE.add(euint64)` costs roughly 133,000 HCU, so the sequential chain caps out around 37 dependent adds. Comparisons cost more.

**Consequences that shape the design:**

1. No loop over depositors in a single transaction. Ever. Not for the draw, not for accounting, not for aggregate calculation.
2. The register must be a tree, and the tree must be updated one path at a time, not rebuilt.
3. Depth is the budget you run out of first. Prefer wide parallel work over deep dependent chains. Two independent 20-op chains cost nothing against the depth limit that one 40-op chain does.
4. Anything that genuinely needs more work than one transaction allows gets **split into checkpointed transactions with the intermediate state stored as ciphertext handles**. The docs name this as the sanctioned escape hatch. Use it for the epoch settlement path, not the draw.
5. Every contract function must have a stated worst-case HCU depth in a comment above it. If you cannot state it, you do not understand it yet.

Write `test/HCU.t.ts` early. It asserts the depth cost of `commit`, `release`, and `draw` at register sizes 2^4, 2^8, 2^12 and 2^16. That test file is a submission asset, not just internal hygiene. It is the proof that the architecture is real.

\---

## 2\. Surfaces

|Surface|Domain|App|
|-|-|-|
|Landing|sortis.xyz|`apps/web`|
|Product|app.sortis.xyz|`apps/app`|
|Docs|docs.sortis.xyz|`apps/docs`|

One Next.js codebase, three hostnames via Host-header middleware. No paths. No fourth surface, no API product, no SDK. Ten days does not fit them and the bounty does not score them.

\---

## 3\. Stack

* Contracts: Solidity 0.8.27, Hardhat, `@fhevm/solidity`, `@openzeppelin/confidential-contracts` (ERC-7984, `FHESafeMath`), `@fhevm/hardhat-plugin`
* Config: inherit `ZamaConfig.getSepoliaConfig()` in every FHE contract constructor
* Frontend: Next.js 15 App Router, TypeScript, Tailwind v4, `@zama-fhe/relayer-sdk` for client-side encryption and user decryption
* Wallet: wagmi + viem + RainbowKit. Not Privy. This audience expects a raw wallet connect and Privy adds a signup step that reads as consumer-app friction to a protocol judge.
* Docs: Fumadocs
* Deploy: Vercel, three projects, one repo
* Yield: a mock ERC-4626 vault on Sepolia with an admin-callable `accrue()`. Do not chase a live yield source. Sepolia has no real yield and faking depth here wastes days. Say plainly in the docs that the yield adapter is an interface with a Sepolia mock behind it, and show the Morpho/Steakhouse adapter as the mainnet path.

\---

## 4\. Contract architecture

Five contracts. Keep them small.

### `SortisRegister.sol`

The encrypted Fenwick tree. This is the core and the thing worth reading.

```
euint64\[] private \_nodes;        // 1-indexed, size 2^DEPTH \* 2
uint256 public constant DEPTH = 16;
mapping(address => uint256) private \_leafOf;
```

* `\_update(uint256 leaf, euint64 delta, ebool isAdd)` walks leaf to root, `FHE.select` on `isAdd` to add or subtract. DEPTH dependent ops. State the HCU cost.
* `\_walk(euint64 lot) returns (uint256 leafIndex)` walks root to leaf. At each level, one `FHE.lt(lot, leftChildSum)` producing an `ebool`, then `FHE.select` to pick the branch and `FHE.select` to subtract the left sum from the lot when going right. **The branch index itself must stay encrypted until the end**, so accumulate it as an `euint16` built from the level bits rather than branching in Solidity. Solidity cannot branch on an `ebool` and attempting to is the single most common FHEVM mistake.
* `root()` returns `\_nodes\[1]`, the encrypted total weight.

The walk is the submission. Comment it line by line, explain the HCU accounting inline, and make it the thing a judge lands on first when they open the repo.

### `SortisTwab.sol`

Encrypted time-weighted balance observations.

* Per stake: `euint64 balance`, `euint64 twabAccumulator`, `uint48 lastUpdate` (plaintext, timestamps are not secret).
* On any balance change, accrue `balance \* (now - lastUpdate)` into the accumulator before applying the change. One multiply, one add. The multiplier is plaintext so it is `FHE.mul(euint64, uint64)`, which is far cheaper than ciphertext-ciphertext multiply. Use the scalar overload everywhere you can, it matters.
* The weight written into the register is the TWAB, not the raw balance.

### `SortisPool.sol`

The user-facing contract.

* `commit(externalEuint64 amount, bytes proof)` pulls cUSDT via `confidentialTransferFrom`, updates TWAB, updates the register.
* `release(externalEuint64 amount, bytes proof)` the reverse. Uses `FHESafeMath` so an over-withdrawal produces an encrypted failure flag and a no-op rather than a revert, because reverting on an encrypted comparison would itself leak the balance. Write a comment saying exactly that, it is a detail that shows you understand the threat model.
* `stakeOf(address)` returns the ciphertext handle. The frontend decrypts client-side for the owner only.

### `SortisDraw.sol`

* `openDraw()` snapshots `register.root()`, emits `DrawOpened(drawId, rootHandle, block.number)`.
* `drawLot(uint256 drawId)` calls `FHE.randEuint64()`, reduces it modulo the root via `FHE.rem`, walks the register, resolves a leaf, grants the prize ciphertext to that leaf's owner via `FHE.allow`, emits `Drawn(drawId, lotHandle, resolvedLeafHandle)`.
* Two transactions, not one. Opening commits the root before the lot exists, which is what makes the draw honest: the pool operator cannot see the lot and then reshape the register.
* The prize amount comes from `yieldAdapter.harvest()` and is public. **The prize size is not a secret. Who won it is.** Do not encrypt the pot; encrypting it removes the public verifiability the bounty explicitly asks for and gains nothing.

### `SortisWrapQueue.sol`

* `enqueue(uint256 usdtAmount)` takes public USDT, holds it.
* `settleEpoch()` wraps the whole epoch's USDT into cUSDT in one call and credits stakes in a single batch, so onchain the link between a public USDT sender and a confidential stake is one-to-many across the epoch rather than one-to-one.
* Epoch length is a public parameter. Default 4 hours on Sepolia so it is demonstrable, and document that mainnet would run longer.
* Include a short honest note in the docs: batching raises the cost of linkage, it does not eliminate it, and a depositor who is the only participant in an epoch gets no anonymity set. Stating the limitation is worth more to a judge than overclaiming.

\---

## 5\. Brand

**Name:** Sortis. Latin *sors, sortis*, the lot cast to decide a matter.

**Visual anchor: the kleroterion.** The Athenian stone slab with columns of slots, used to select citizens by lot. Tokens went into the slots, a tube of black and white balls decided which row was chosen, and nobody could see the outcome in advance. It is the exact mechanism of this product, it is two and a half thousand years old, and it is a far better anchor than anything from the fintech vocabulary.

Do not build a "lottery" aesthetic. No confetti, no ticket stubs, no gold coins, no slot-machine motion. This is civic infrastructure for savings.

### Palette

Weathered limestone and brass. Stone because the kleroterion was carved stone; brass because the tokens were bronze.

```
--stone:    #E8EAE5   page ground, cool pale limestone
--slab:     #F3F4F1   raised surfaces, cards
--chalk:    #FBFCFA   input fields, the highest surface
--ink:      #1A1E1B   primary text
--graphite: #565C56   secondary text, labels
--rule:     #CDD2C9   hairlines, card borders, slot outlines
--seal:     #2F3E6B   encrypted state, ciphertext values, the sealed slot
--brass:    #A87A2E   accent, the drawn token, primary buttons
--gleam:    #D9A94A   brass highlight, focus rings, the moment of resolution
--fault:    #8C3A28   errors only, oxidised iron
```

Semantic mapping, use it consistently: **seal = encrypted, brass = drawn, gleam = decrypting right now, graphite = public and unremarkable.** A user should be able to learn the entire privacy model from colour alone.

### Type

* Display: **Archivo**, weights 600 and 800. Tight, institutional, civic. Set headlines at `-0.03em` tracking.
* Body: **Inter**, 400 and 500.
* Data: **IBM Plex Mono**, 400. Every ciphertext handle, every address, every number.

Both Archivo and Inter are in the design zips you already have. Do not add a fourth face.

**Type rule that carries the brand:** any value that is encrypted renders in IBM Plex Mono, in `--seal`, as its truncated ciphertext handle. Not a lock icon, not asterisks, not a blurred number. The actual handle, `0x7f2a…c091`. Encryption is the default visual state of this product and the interface should look encrypted at rest.

### Logo

The kleroterion plate: a rounded rectangle, a channel bar down the left edge, three slot rows on the right, top slot filled brass. Provided as `brand/sortis-mark.svg`. It reads at 24px because there are only five shapes in it.

\---

## 6\. Design direction and the signature element

Take **fd** (Archivo, light ground, monochrome with a single accent, restraint) as the structural reference at about 50 percent, and **pro** (light, expressive spring motion, confident scale) at about 20 percent for the motion vocabulary. The remaining 30 percent is Sortis-specific and comes from the kleroterion.

Do not reference t54 or agentpassport here. Those are Warrant's language and reusing them across products makes the portfolio read as one template.

### The signature: the draw column

A vertical kleroterion column on the landing hero and again as the centrepiece of the app's draw screen.

* A stone plate with a column of slots. Each slot is a stake in the register.
* Every slot displays a ciphertext handle in `--seal`. Nothing legible. That is the point, and it should be slightly uncomfortable to look at.
* The lot descends the channel on the left as a brass token, one slot per level, sixteen steps for a full-depth register. Each step is the tree walk made physical: the token pauses, one slot row dims out, the token continues. You are watching an O(log N) search and it takes sixteen beats, not four hundred.
* On resolution, one slot turns brass. Its handle stays encrypted for everyone except the drawn address, whose session decrypts it in place with a `--gleam` flash.

This is the entire product argument in one object: the mechanism is public and auditable, the contents are not, and the search is logarithmic. Build this well and it does the job of the pitch, the demo video and the landing hero at once.

Everything else stays quiet. Hairline rules, generous whitespace, no gradients, no glass, no glow. Spend the boldness on the column.

\---

## 7\. Landing page, section by section

1. **Hero.** Headline in Archivo 800: "Save. Never lose. Nobody sees." Subhead one sentence. The draw column running on loop to the right on desktop, below the fold copy on mobile. One primary button in brass, "Open the app". One ghost link, "Read the architecture".
2. **The wall.** The section that wins the bounty. A two-column comparison: linear draw versus tree draw, with the real numbers. Depositor count on the x axis, sequential HCU on the y, the 5,000,000 limit drawn as a red line the linear curve crosses at around forty and the log curve never approaches. Label the line "transaction reverts here". No other entry will have this section.
3. **How a draw works.** Four steps, because it is genuinely a sequence: commit, root is snapshotted, the lot is drawn, one slot resolves. Use numbered markers here, they encode a real order.
4. **What stays private and what does not.** A plain two-column table. Private: your deposit, your balance, your weight, whether you won. Public: the pot size, the tree root, the block, the fact that a draw happened. Honesty as a design feature.
5. **The wrap leak, addressed.** Short. Explain epoch batching and state the limitation.
6. **Footer.** Repo, docs, Sepolia addresses, the Zama Season 4 tag. No legal section, no lawyer.

\---

## 8\. App

Three screens. No more.

* **Register.** Your stake as a ciphertext handle with a "decrypt" action that runs the relayer SDK user-decryption flow and reveals it in place for your session only. Commit and release forms. Your current TWAB weight, also encrypted, also decryptable by you.
* **Draw.** The kleroterion column, live. Current draw id, the committed root handle, the block, the pot size in plaintext, a countdown. History of past draws with their root handles and block numbers, all publicly checkable.
* **Verify.** The screen most entries will not build. Paste a draw id, and it re-runs the tree walk client-side against the public root handle and the public lot handle, and shows you that the resolved leaf matches what the contract emitted. Public verifiability is one of five things the bounty explicitly asks for, so give it its own screen rather than burying it in the docs.

\---

## 9\. Docs

Fumadocs, six pages, no more.

`overview`, `architecture` (the register and the walk, with the HCU accounting), `privacy-model` (threat model, what leaks, what does not, the wrap caveat), `contracts` (Sepolia addresses, ABIs), `verify-a-draw` (how to check a draw yourself), `limitations` (mock yield on Sepolia, anonymity set sizing, what mainnet would change).

The `limitations` page is not a weakness. Write it well and it is the page that separates a production-minded submission from a demo.

\---

## 10\. Build order

Ten days. Contracts first, always. A beautiful frontend over a linear-scan draw loses to an ugly frontend over a working tree.

|Day|Work|
|-|-|
|Aug 26|Register on the Zama Guild (connect GitHub, star `zama-ai/fhevm`, verify email). Do it today, not on submission day. Hardhat scaffold, FHEVM plugin, Sepolia config, a hello-world `euint64` contract deployed and verified.|
|Aug 27|`SortisRegister`, update path only. `test/HCU.t.ts` measuring update depth at four register sizes.|
|Aug 28|The walk. This is the hard day. Encrypted branch accumulation, no Solidity branching on `ebool`. Depth measured and asserted.|
|Aug 29|`SortisTwab` and `SortisPool`. `FHESafeMath` on release. Full commit/release/weight cycle green on Sepolia.|
|Aug 30|`SortisDraw` two-phase, `randEuint64`, ACL grant to the drawn address, `SortisWrapQueue`. Contracts done.|
|Aug 31|Frontend scaffold, three hostnames, tokens, wagmi, relayer SDK wired. Encrypt a value from the browser and commit it.|
|Sep 1|The draw column component. Take the day. It is the signature.|
|Sep 2|Three app screens including Verify.|
|Sep 3|Landing page, all six sections, including the HCU chart.|
|Sep 4|Docs, README, deploy all three, seed the register with 200 test stakes so the demo is not five wallets.|
|Sep 5|Demo video, submission form, X post. Submit by 12:00 PKT with five hours of margin, not at the deadline.|

Cairn starts Sep 1 in parallel and takes its own 5 to 7 days. Sortis days 1 through 5 are frontend work, which is the part you are fastest at. If something has to give after Aug 30, it is the landing page polish, never the contracts.

\---

## 11\. Paste-ready phase prompts

Give Claude Code one phase at a time. Attach this brief, `brand/sortis-mark.svg`, and `tokens.css`.

**Phase 1**

> Read docs/BRIEF.md sections 1 and 4. Scaffold a Hardhat project with @fhevm/solidity, @fhevm/hardhat-plugin and @openzeppelin/confidential-contracts. Implement SortisRegister.sol: an encrypted Fenwick tree of euint64 with DEPTH 16, exposing \_update and root(). Do not implement the walk yet. Write test/HCU.t.ts asserting the sequential HCU depth of a single update at register sizes 2^4, 2^8, 2^12 and 2^16, and print the numbers. Above every function, comment the worst-case HCU depth.

**Phase 2**

> Read section 4. Implement \_walk(euint64 lot) in SortisRegister. Constraints: Solidity must never branch on an ebool. Accumulate the resolved leaf index as an encrypted value built from per-level bits using FHE.select. One FHE.lt per level, one FHE.select to pick the branch, one FHE.select to conditionally subtract the left subtree sum from the remaining lot. Extend test/HCU.t.ts to assert walk depth at the same four sizes and confirm it stays under 5,000,000.

**Phase 3**

> Read section 4. Implement SortisTwab and SortisPool. Use the scalar FHE.mul overload for the time multiplier, never ciphertext-ciphertext. Use FHESafeMath on release so an over-withdrawal is an encrypted no-op rather than a revert, and comment why reverting would leak the balance. Deploy to Sepolia and run a full commit, wait, release cycle.

**Phase 4**

> Read section 4. Implement SortisDraw as two transactions, openDraw and drawLot, and SortisWrapQueue with epoch settlement. openDraw must commit the root before any randomness exists. drawLot uses FHE.randEuint64, walks the register, and grants the prize ciphertext to the resolved leaf owner with FHE.allow.

**Phase 5**

> Read sections 5, 6 and 8. Scaffold the Next.js app with three hostnames via Host-header middleware, apply tokens.css, wire wagmi and @zama-fhe/relayer-sdk. Build the draw column component described in section 6 as the first UI work. Sixteen discrete steps, brass token descending a channel, slots showing truncated ciphertext handles in --seal, one slot resolving to --brass. Respect prefers-reduced-motion by jumping to the resolved state.after each component pass, screenshot at 390px and 1440px, view the screenshot, critique against section 6, and iterate before moving on. Screenshot-driven self-critique is worth more on this build than on a normal one, because the signature element is motion and colour semantics, not layout.

\---

## 12\. Submission checklist

* \[ ] Guild verification done (GitHub connected, `zama-ai/fhevm` starred, email verified)
* \[ ] Public repo, MIT, real commit history across the window
* \[ ] All five contracts verified on Sepolia Etherscan, addresses in the README header
* \[ ] `test/HCU.t.ts` passing, with the printed depth table pasted into the README
* \[ ] Register seeded with 200+ stakes so the tree depth is not theoretical
* \[ ] Three sites live
* \[ ] Demo video, 3 to 5 minutes: the wall (30s), a commit (30s), a draw with the column running (90s), the Verify screen re-deriving the result (45s), the HCU table (30s)
* \[ ] Application form submitted via the Season 4 page
* \[ ] X post tagging @zama with `#ZamaDeveloperProgram`, leading with the HCU chart, not the logo

\---

## 13\. Craft standard

Non-negotiable. These are the tells that make work read as vibe-coded, and a judge with 100 submissions in front of them uses tells to sort.

* **No em dashes anywhere.** Not in copy, not in comments, not in commit messages, not in docs. Use a period or a comma.
* No "not just X, but Y" constructions. No "it's worth noting". No "in today's world". No sentence that opens with "Whether you're".
* No emoji in the UI, the README or the contracts.
* No placeholder or mock data anywhere a real value should be. If the register is empty, say the register is empty.
* Do not claim mainnet readiness, audits, users or TVL. The `limitations` page exists so the rest of the site can be confident without overclaiming.
* Error messages state what happened and what to do. They do not apologise.
* Every number on the site must be derived from a real call. If the HCU chart is drawn from measurements, say which commit produced them.

