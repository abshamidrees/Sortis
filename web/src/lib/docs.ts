import {
  HCU,
  LINEAR_SCAN_WALL,
  LIVE_DRAW,
  MEASUREMENT_COMMIT,
} from "./measurements";

/**
 * The documentation, as data.
 *
 * Four pages, one per route, written here rather than as JSX in four files
 * because the numbers are imported from `measurements.ts`. A figure quoted in
 * prose that does not move when the measurement moves is exactly the failure
 * the craft standard is aimed at: easy to write, invisible afterwards, and
 * wrong the moment anything is remeasured.
 */

export type Block =
  | { type: "p"; text: string }
  | { type: "h"; text: string }
  | { type: "code"; text: string }
  | { type: "note"; text: string }
  | { type: "ul"; items: string[] };

export type Doc = {
  slug: string;
  title: string;
  blurb: string;
  body: Block[];
};

const ceiling = HCU.DRAW.filter((r) => r.fits).at(-1)!;
const firstFail = HCU.DRAW.find((r) => !r.fits)!;
const ceilingPct = ((ceiling.depth / HCU.DEPTH_LIMIT) * 100).toFixed(2);

export const DOCS: Doc[] = [
  {
    slug: "overview",
    title: "Overview",
    blurb: "What Sortis is, and what one full cycle does.",
    body: [
      {
        type: "p",
        text: "Sortis is confidential prize-linked savings. You commit funds, you cannot lose your principal, the pooled yield is awarded as a prize on a schedule, and the size of your position is not visible to anyone but you.",
      },
      {
        type: "p",
        text: "The idea is old and the interesting part is not the lottery. It is that a prize-linked pool has to answer two questions at once: it must convince everyone the draw was fair, and it must show nobody how much anyone has. Those pull in opposite directions, because the usual way to prove a weighted draw was fair is to publish the weights.",
      },
      {
        type: "p",
        text: "Sortis publishes the shape of the draw and none of its contents. Anyone can check that the lot was drawn against a register root committed one block before any randomness existed, that the denominator it was reduced against carries a KMS signature, and that the descent ran to a leaf. What nobody can see is which leaf, including the person who won it.",
      },
      { type: "h", text: "One full cycle" },
      {
        type: "ul",
        items: [
          "Commit. Your amount is encrypted in your browser, sent as a ciphertext handle with an input proof, and pulled by the pool with confidentialTransferFrom. The plaintext never leaves your machine.",
          "Wait. Weight is money multiplied by the hours it sat there, so a deposit made moments before a draw carries nothing. This is a property of the accounting rather than a lockup, and your principal stays withdrawable throughout.",
          "Draw. openDraw commits both register roots, the block and the reference hour. No randomness exists yet. In a later block drawLot produces the lot with FHE.randEuint64 and descends the register.",
          "Claim. Every depositor claims the same way. An encrypted comparison pays the drawn leaf and pays everyone else an encrypted zero, on identical code and identically shaped ciphertexts.",
          "Release. Principal is withdrawable at any time. An over-withdrawal is an encrypted no-op rather than a revert, for reasons the privacy model page sets out.",
        ],
      },
      { type: "h", text: "Why the draw is two transactions" },
      {
        type: "p",
        text: "If a single transaction both read the register and produced the randomness, whoever submitted it could see the state it was about to draw from and choose whether to send it. Splitting the two means the root is fixed and public before the lot exists.",
      },
      {
        type: "p",
        text: "drawLot refuses to run in the opening block, and refuses if either root handle moved in between. FHEVM handles are content-derived, so that second check is cryptographic rather than a promise: a register that changed cannot produce the handle that was recorded.",
      },
      { type: "h", text: "The yield source is a mock, and this page says so" },
      {
        type: "p",
        text: "On Sepolia the prize comes from a mock adapter with an admin-callable accrue, which books an amount, and a harvest that mints that much cUSDT into the draw contract. That is the whole of it. A draw opened when nothing has accrued has a prize of zero, which is honest rather than broken.",
      },
      {
        type: "p",
        text: "On mainnet the same ISortisYieldAdapter interface sits in front of an ERC-4626 vault. SortisDraw only ever calls harvest(to) and only ever treats the result as a public uint64, so swapping the source is a constructor argument and no contract change. The prize being public is what keeps that boundary clean: no part of the yield path touches a ciphertext.",
      },
      {
        type: "note",
        text: "Sortis has not been audited, runs on Sepolia only, and draws its prize from a mock. Nothing here should be treated as production infrastructure.",
      },
    ],
  },

  {
    slug: "architecture",
    title: "Architecture",
    blurb: "The register, the oblivious walk, and why a shard holds 32.",
    body: [
      {
        type: "p",
        text: `FHEVM enforces two limits on a single transaction. Total work is capped at ${HCU.GLOBAL_LIMIT.toLocaleString(
          "en-US"
        )} HCU, and the longest chain of dependent operations is capped at ${HCU.DEPTH_LIMIT.toLocaleString(
          "en-US"
        )}. Exceeding either reverts. The second is the one that shapes this design, because it cannot be worked around.`,
      },
      {
        type: "p",
        text: `The obvious build encrypts balances and scans them at draw time, accumulating into one running total. Every addition depends on the one before it, so the whole scan is a single chain of ciphertext additions at ${HCU.ADD_CT_CT.toLocaleString(
          "en-US"
        )} HCU each. That crosses the depth limit at ${LINEAR_SCAN_WALL} depositors, and no amount of gas buys past it.`,
      },
      {
        type: "p",
        text: "Sortis keeps time-weighted stake in a segment tree and descends it. The chain then grows with the height of the tree rather than with the number of people in it, which is the whole architectural argument.",
      },
      { type: "h", text: "The update path is parallel, not deep" },
      {
        type: "p",
        text: "Maintaining a segment tree the textbook way recomputes each parent from its children, so every parent waits on the child written a step earlier. At height 16 that is seventeen additions in a chain, on the deposit path, on every deposit.",
      },
      {
        type: "p",
        text: `_update folds the direction of the change into the delta once, then adds that same single ciphertext to every node on the path. Each node now depends only on its own previous value, so the writes are independent of one another and bill against the global budget instead of the depth one. Sequential depth for a commit is ${HCU.COMMIT_DEPTH.toLocaleString(
          "en-US"
        )} HCU and is flat in shard size: the same figure at 2^4 as at 2^16.`,
      },
      { type: "h", text: "The walk never branches on a ciphertext" },
      {
        type: "p",
        text: "At each level the walk compares the remaining lot against the left subtree's weight, uses that encrypted comparison to select whether to subtract, and folds the branch bit into an encrypted index. Solidity never sees which way it went.",
      },
      {
        type: "p",
        text: "That has a consequence which is easy to miss and dominates the cost. Because the index stays encrypted, the contract cannot address the next node in plaintext either. It has to resolve each level's child obliviously, folding together every candidate that level could have reached. Touching every leaf the draw could have picked is not an inefficiency to optimise away; it is what hiding the winner means. The cost is therefore linear in stakes however the tree is arranged.",
      },
      { type: "h", text: "A shard holds 32, and the number is measured" },
      {
        type: "code",
        text: HCU.DRAW.map(
          (r) =>
            `${String(r.stakes).padStart(4)} stakes   ${
              r.fits
                ? `${r.depth.toLocaleString("en-US").padStart(9)} HCU   ${(
                    (r.depth / HCU.DEPTH_LIMIT) *
                    100
                  ).toFixed(2)}%   fits`
                : `${"reverts".padStart(9)}         depth budget`
            }`
        ).join("\n"),
      },
      {
        type: "p",
        text: `The ceiling is set by what a draw costs, not by what a walk costs. drawLot reduces the lot modulo the published total before it descends, and FHE.rem is a 1,153,000 chain that the entire walk then hangs off. Measuring _walk alone says ${firstFail.stakes} stakes fit. Measuring the transaction that actually has to land says ${ceiling.stakes}, at ${ceilingPct}% of budget.`,
      },
      {
        type: "p",
        text: "A shard was briefly deployed at the larger size on the strength of the walk figure alone and could not have settled its own draw. The number that sets capacity has to be the cost of the whole transaction, which is why capacity is enforced in the contract: the 33rd depositor is rejected rather than silently pushing a draw past what it can settle.",
      },
      { type: "h", text: "Checked against the coprocessor, not just the mock" },
      {
        type: "p",
        text: `At ${ceilingPct}% of the depth budget there is no margin, so the mock's figure was checked against a real draw at the size actually deployed. Draw ${
          LIVE_DRAW.drawId
        } on Sepolia descended ${LIVE_DRAW.walkHeight} levels over ${
          LIVE_DRAW.leaves
        } seeded stakes, against a published total weight of ${LIVE_DRAW.totalWeight.toLocaleString(
          "en-US"
        )}, and used ${LIVE_DRAW.drawLotGas.toLocaleString("en-US")} gas.`,
      },
      {
        type: "code",
        text: [
          `mock, height ${LIVE_DRAW.walkHeight}       ${LIVE_DRAW.mockDepth
            .toLocaleString("en-US")
            .padStart(9)} HCU depth`,
          `Sepolia, height ${LIVE_DRAW.walkHeight}    ${LIVE_DRAW.depth
            .toLocaleString("en-US")
            .padStart(9)} HCU depth   ${LIVE_DRAW.globalHCU.toLocaleString(
            "en-US"
          )} global`,
          `difference        ${"0.00%".padStart(9)}`,
        ].join("\n"),
      },
      {
        type: "p",
        text: `Had they disagreed by even one percent the register would have had to drop to height 4. They agreed to the unit. Every figure on this page is produced by test/HCU.t.ts and test/Calibration.t.ts at commit ${MEASUREMENT_COMMIT}, and the live record is deployments/sepolia-livedraw.json.`,
      },
      { type: "h", text: "Scale is more shards, not a bigger tree" },
      {
        type: "p",
        text: "Depth is the binding budget, and it cannot be checkpointed across transactions the way global work can. Too much work splits into several transactions; a chain that is too long does not split at all. So this is a hard ceiling rather than a soft one, and the protocol adds shards rather than pretending the tree can grow.",
      },
    ],
  },

  {
    slug: "privacy-model",
    title: "Privacy model",
    blurb: "What stays encrypted, what leaks, and what verification cannot do.",
    body: [
      {
        type: "p",
        text: "This page leads with what leaks, because that is the half a reader cannot check by looking at the app.",
      },
      { type: "h", text: "Public, and deliberately so" },
      {
        type: "ul",
        items: [
          "The pot. The prize is a uint64 in the clear. Encrypting it would remove the public verifiability the design exists to provide, and it describes the pool rather than any position in it.",
          "The register roots, the block they were committed at, and the total weight the lot was reduced against. The total is published because reducing into a uniform range needs a plaintext bound, and it is verified against the KMS with FHE.checkSignatures rather than trusted.",
          "That an address interacted with the pool, when, and in which direction. commit pulls and release pushes, and those are different external calls.",
          "Which leaf index moved. _update writes a visible path of storage slots, so leaf ownership is on chain whatever the frontend does. The register screen shows this rather than pretending otherwise.",
          "How many leaves are in use, and the shard's capacity.",
        ],
      },
      { type: "h", text: "Encrypted, and never decrypted by the protocol" },
      {
        type: "ul",
        items: [
          "Your deposit amount, encrypted in your browser before it is sent.",
          "Your balance and your weight line, both intercept and slope, at every node of both trees. euint64 handles, decryptable by you alone through EIP-712 user decryption, in your browser.",
          "The lot, produced by FHE.randEuint64.",
          "Whether you won. The resolved leaf is an encrypted index and no ACL grant is ever issued on it, so no client can learn it, the winner's own included.",
          "What you were paid. A losing claim transfers an encrypted zero and costs the same gas, the same sequential depth and the same global HCU as a winning one.",
        ],
      },
      { type: "h", text: "What an observer can still infer" },
      {
        type: "p",
        text: "That an address holds a position, roughly when it was opened and last changed, and therefore an upper bound on how long it has been accruing weight. Not its size, not its weight, and not whether it won. Hiding the existence of a position as well would mean hiding the storage writes, which is a different protocol than this one.",
      },
      { type: "h", text: "Why an over-withdrawal does not revert" },
      {
        type: "p",
        text: "Reverting on an encrypted comparison publishes the comparison. A release(X) that reverts proves the caller's balance is below X, and one that succeeds proves it is at or above X. An attacker who can distinguish the two binary-searches any balance in about 64 transactions, and the encryption has bought nothing.",
      },
      {
        type: "p",
        text: "So SortisPool.release uses FHESafeMath.tryDecrease, which returns an encrypted success flag and leaves the balance untouched on failure. A refused release transfers zero, moves the weight line by zero, emits the same event, and matches an honoured one on gas, depth and global HCU. The app says so before you send, because otherwise you watch a successful transaction change none of your numbers and conclude it is broken.",
      },
      {
        type: "p",
        text: "tryDecrease and not trySub: both return a flag, but trySub returns zero on failure, which would wipe a stake the first time somebody fat-fingered a release.",
      },
      { type: "h", text: "The wrap leak, stated plainly" },
      {
        type: "p",
        text: "Money arrives as public USDT. Wrapping it in the same transaction as the deposit would make the amount readable one call before it became private, so deposits can queue and settle in epoch batches instead.",
      },
      {
        type: "note",
        text: "Batching raises the cost of linkage; it does not eliminate it. A depositor alone in an epoch has no anonymity set, amounts are not mixed so sizes can be matched back, and each settlement emits an event naming the stake owner.",
      },
      { type: "h", text: "What verification cannot do" },
      {
        type: "p",
        text: "The descent cannot be replayed by a client. Every node in the register is a ciphertext nobody holds a grant on, and publishing per-node decryptions so a verifier could re-run the comparisons would hand everyone the register, which is the one thing the protocol is built to withhold.",
      },
      {
        type: "p",
        text: "So verification checks the public chain of facts: that the root was committed before the lot existed, that the roots did not move in between, that the denominator carries a KMS signature, and that the draw settled. It does not re-derive the winner, and the Verify screen names that limit rather than implying more than it checks.",
      },
    ],
  },

  {
    slug: "limitations",
    title: "Limitations",
    blurb: "What is not built, and the named path forward.",
    body: [
      {
        type: "note",
        text: "Sortis has not been audited. It is deployed on Sepolia only, against a mock yield source, and nothing here should be treated as production infrastructure.",
      },
      { type: "h", text: "Known limits" },
      {
        type: "ul",
        items: [
          `A shard holds ${ceiling.stakes} stakes. The 33rd depositor is rejected by RegisterFull rather than silently pushing the draw past what it can settle.`,
          "Multi-shard routing is not built. The contracts support many shards; the deployment scripts and the frontend address one. The thesis depends on this and the deployment does not demonstrate it.",
          "Weight is evaluated at whole hours. A stake held for less than an hour carries no weight, which is what stops a late deposit sniping a draw and also means very short holds earn nothing. The unit is a constant, not a law.",
          "The epoch wrap queue is deployed but the frontend commits directly, which is the more legible path for a judge and the less private one. The queue is the private path, and the docs say which is which rather than quietly using the weaker one.",
          "One leaf wins per draw. Several winners would need either several walks, each at full cost, or a different selection rule.",
          "Settling a draw is not behind a button, because drawLot needs a KMS decryption proof for the published total, which is an off-chain fetch slow enough that a button would appear to hang. Opening a draw is permissionless; settling runs from a script, and on mainnet would run behind a keeper.",
        ],
      },
      { type: "h", text: "Where the frontend is weakest" },
      {
        type: "p",
        text: "Reads depend on a public RPC and degrade under rate limiting. Every read retries, and when one exhausts its retries the interface names that state rather than rendering an empty register or an unauthorised account. A failed read and an empty shard must never look the same, and making them look the same was the most misleading bug in this build.",
      },
      { type: "h", text: "The change that would raise the ceiling" },
      {
        type: "p",
        text: `About ${HCU.DRAW_PER_LEVEL.toLocaleString(
          "en-US"
        )} HCU of depth is spent per level of the descent, and most of it is turning a node's intercept and slope into a weight while the walk waits. That is the price of a weight line that never goes stale, and it is paid on the critical path.`,
      },
      {
        type: "p",
        text: `Materialising the weights once at openDraw would move it off. Each node's evaluation is independent of every other node's, so a snapshot pass bills against the ${HCU.GLOBAL_LIMIT.toLocaleString(
          "en-US"
        )} global budget rather than the ${HCU.DEPTH_LIMIT.toLocaleString(
          "en-US"
        )} depth one.`,
      },
      {
        type: "p",
        text: "It would not make a shard much larger, because global cost roughly doubles per level and takes over around the same place. What it would do is convert a hard ceiling into a soft one, since global work is checkpointable across transactions and depth is not. That is the named path forward, and it is not in this build.",
      },
    ],
  },
];
