# Sortis

Confidential prize-linked savings. You commit, you cannot lose your principal,
the pooled yield is drawn as a prize on a schedule, and nothing about your
position is visible to anyone.

Built for the Zama Developer Program, Mainnet Season 4. See
[docs/BRIEF.md](docs/BRIEF.md) for the full design.

**Live app: https://sortis.vercel.app**

One shard is deployed on Sepolia, holding 24 stakes of a 32 stake capacity, and
one draw has been opened, settled and claimed on it. That draw descended five
levels of an encrypted tree over a published total weight of 124,000,000 and
cost 4,476,000 HCU of sequential depth against a budget of 5,000,000. Every
figure in this file comes from a transaction that landed, and each one says
where to check it.

## For judges

Bring Sepolia ETH. That is the only thing you need that the app cannot give
you: the pool's token has an open faucet on the register screen, but signing a
transaction that moves an encrypted amount still costs gas like any other. If
the wallet is empty the app says so before you press anything, with a link to a
faucet, rather than letting a wallet error arrive that reads like a contract
bug.

### Trying every feature, in order

1. Open [`/app/register`](https://sortis.vercel.app/app/register) and connect a
   wallet on Sepolia. Wallet only, through Privy, with no email step.
2. Press **Mint 5 cUSDT**. This mints the pool's ERC-7984 test token to you and
   authorises the pool as an ERC-7984 operator in the same transaction pair,
   because a commit fails without that authorisation and you should never hit
   that for a reason the interface never mentioned.
3. Enter an amount and press **Commit**. The amount is encrypted in your
   browser by the relayer SDK, sent as a ciphertext handle with an input proof,
   and pulled with `confidentialTransferFrom`. Nothing readable leaves your
   machine.
4. Press **decrypt** next to STAKE. Your wallet signs an EIP-712 grant scoped
   to the pool and a one day window, and the relayer returns the plaintext to
   this browser only. That is the user-decryption flow.
5. Press **Release** to withdraw. Principal is withdrawable at any time. Try an
   amount larger than your stake: the transaction succeeds, moves nothing, and
   costs the same gas as one that does, because reverting on an encrypted
   comparison would leak the balance. The app tells you this before you send.
6. Open [`/app`](https://sortis.vercel.app/app) for the register, the current
   draw and the history, and press **Open draw** to trigger one yourself. See
   below.
7. Open [`/app/verify`](https://sortis.vercel.app/app/verify) and verify a
   draw. This works with no wallet connected.

Your stake carries no weight until it has been in the pool a full hour, so a
deposit made minutes before a draw cannot win. That is a property of the design
rather than a delay bolted on, and it is stated on the draw screen next to the
control it would otherwise appear to break. If you want to see a weighted
position immediately, read the 24 already seeded on the register.

### Triggering a draw

`openDraw` has no owner check and never had one. The rules ask that a judge be
able to connect a wallet and try every feature, and an owner-gated draw fails
that: the central mechanism would be the one thing you could only read about.
The only gate is a minimum interval since the last draw, currently **10
minutes**, because a draw can otherwise be opened in every block and the
history stops meaning anything.

Press **Open draw** on [`/app`](https://sortis.vercel.app/app). Note that the
prize will be zero unless yield has accrued since the last claim, which is
honest rather than broken: the pot is what the yield source has produced, and
on Sepolia that is whatever the mock adapter was last told to book.

Settling is the second transaction and is not behind a button. `drawLot` needs
a KMS decryption proof for the published total, which is an off-chain fetch
through the relayer that takes long enough that a button would appear to hang.
It runs from a script:

```bash
npx hardhat run scripts/draw.ts --network sepolia
```

**On mainnet this would run behind a keeper**, on the same two-transaction
split, for the same reason the split exists: the root must be committed before
any randomness is known. Nothing about the contract changes; the caller does.

## What is encrypted, and what is not

The honest version of this section is the one that lists what leaks, so here it
is first.

**Public, and unavoidably so:**

- **Who has a leaf, and which one.** `_update` writes a visible path of storage
  slots, so which leaf moved is on chain whatever the frontend does. The
  register screen shows this rather than pretending otherwise.
- **That you committed, and when.** The transaction and its `Committed` event
  are public, as is the block.
- **The total weight of the register at a draw.** Published on purpose:
  reducing the lot into `[0, total)` needs a plaintext bound, and it is
  verified against the KMS with `FHE.checkSignatures` rather than trusted.
- **The prize.** A `uint64` in the clear. It is the pot, not a position.
- **The number of leaves in use, and the register's capacity.**

**Encrypted, and never decrypted by the protocol:**

- **Every balance.** `euint64`, readable only by its owner through an EIP-712
  grant, in their browser.
- **Every weight line**, both intercept and slope, at every node of both trees.
- **The lot**, produced by `FHE.randEuint64`.
- **The winner.** The walk resolves to an encrypted leaf index. No grant is
  ever issued on it, so no client can learn it, including the winner's own.
  `claimPrize` compares your leaf against that encrypted result under
  encryption and transfers either the prize or an encrypted zero. Every
  claimant runs identical code and moves an identically shaped ciphertext.

**What an observer can infer:** that an address holds a position, roughly when
it was opened and last changed, and therefore an upper bound on how long it has
been accruing. Not its size, not its weight, not whether it won. Hiding the
existence of a position as well would mean hiding the storage writes, which is
a different protocol.

## Error handling

The rules name four states by hand: missing approvals, insufficient balance,
network mismatch, and unsupported tokens. Each is a **named state checked
before a transaction is built**, not an exception caught after one reverts,
because a revert surfaced from a wallet is a hex string and a stack, and none
of these are the user doing something wrong. They live in
[`web/src/lib/guards.ts`](web/src/lib/guards.ts) as pure functions and are
asserted in [`test/Guards.t.ts`](test/Guards.t.ts), 21 assertions, no chain and
no wallet required.

| state | what the app does |
| --- | --- |
| wrong network | Names the chain the wallet is on and offers a switch. |
| pool not authorised | Explains the ERC-7984 operator grant and points at Mint, which does it. |
| insufficient cUSDT | Names the shortfall and offers the faucet. |
| no Sepolia ETH | Stated once above all three forms, with a faucet link. |
| release above stake | Says the transaction will succeed and move nothing. Not blocking, because that is the design. |

The last two are worth explaining.

An over-release is **not an error**. It is an encrypted no-op, and saying so
before the send is the point: otherwise you watch a successful transaction
change none of your numbers and conclude the app is broken.

No Sepolia ETH was the state that produced the worst failure in this build. A
wallet with no gas is refused at `eth_sendRawTransaction`, before any node
simulates anything, but viem wraps every write failure as `The contract
function "mint" reverted with the following reason`, and a fixed length slice
cut the rest off mid-word. The screen therefore blamed `SortisPool` for an
empty wallet. `readTxError` now names the real cause from the whole error
chain, and `guardGas` states it before the send.

Reads are held to the same rule. A rate limited RPC used to leave the position
panel rendering `no leaf yet`, `not set` and `not authorised` in red, which is
a confident description of an empty account that in fact had a stake. There are
three states, not two: reading, read, and could not read.

## The yield source is a mock, and here is exactly how

`MockYieldAdapter` has an admin-callable `accrue(uint64)` that books a prize,
and `harvest(address)` which mints that much cUSDT into the draw contract and
resets. That is the whole of it. Sepolia has no real yield, and building a
convincing fake one would cost days and prove nothing about the part of this
that is hard.

The mainnet path is the same `ISortisYieldAdapter` interface in front of an
ERC-4626 vault. `SortisDraw` only ever calls `harvest(address)` and only ever
treats the result as a public `uint64`, so swapping the adapter is a
constructor argument and no contract change. The prize being public is what
makes that clean: no part of the yield path touches a ciphertext.

## The thesis, in one paragraph

Every other entry will encrypt balances and scan them, which reverts at 30
depositors because of the FHEVM sequential depth budget. Sortis descends an
encrypted tree instead. That draws from 32 stakes in a single transaction, and
scales by adding shards rather than by growing the tree. The 32 is not a
target, it is measured: hiding the winner forces the search to touch every leaf
it could have picked, so the cost is linear in stakes however the tree is
arranged, and a draw runs out of depth at 64.

## The budgets

FHEVM enforces two limits per transaction. Exceeding either reverts.

| budget | limit | what it measures |
| --- | --- | --- |
| global complexity | 20,000,000 HCU | work that can run in parallel |
| sequential depth | 5,000,000 HCU | the longest dependent chain |

[`test/HCU.t.ts`](test/HCU.t.ts) measures everything below and is a submission
asset, not internal hygiene. It does not assume where the ceiling is, it sweeps
until the transaction reverts.

```bash
npm test
```

### Commit and release: flat, whatever the register size

The obvious way to maintain a segment tree recomputes each parent from its
children, so every parent depends on the child written a step earlier: 17 adds
in a chain. `_update` folds the sign into the delta once and adds the same two
ciphertexts to every node on the path, so the writes are independent of each
other and bill against the global budget instead.

| register | seq depth | of budget | global HCU | of budget |
| --- | --- | --- | --- | --- |
| 2^4 | 713,000 | 14.26% | 2,226,000 | 11.13% |
| 2^8 | 713,000 | 14.26% | 3,522,000 | 17.61% |
| 2^12 | 713,000 | 14.26% | 4,818,000 | 24.09% |
| 2^16 | 713,000 | 14.26% | 6,114,000 | 30.57% |

Measured by `test/HCU.t.ts` at commit `c234b6a`.

### The draw: where the ceiling is, and why

A draw is more than a walk. `drawLot` reduces the lot modulo the published
total before it descends, and `FHE.rem` is a 1,153,000 chain that the whole
walk then hangs off. Measuring `_walk` alone says 64 stakes fit. Measuring the
transaction that actually has to land says otherwise.

| stakes | drawLot depth | of budget | result |
| --- | --- | --- | --- |
| 4 | 2,199,000 | 43.98% | fits |
| 8 | 3,020,000 | 60.40% | fits |
| 16 | 3,748,000 | 74.96% | fits |
| 32 | 4,476,000 | 89.52% | fits, and this is the shard |
| 64 | reverts | | depth budget |

A shard was briefly deployed at 64 on the strength of the walk figure and could
not have settled its own draw. The number that sets capacity has to be the cost
of the whole transaction.

### Verified against the chain, not just the mock

This is the measurement the shard size rests on, so it was checked on Sepolia
at the size actually deployed rather than only in the mock.

| | sequential depth | global HCU |
| --- | --- | --- |
| mock, height 5 | 4,476,000 | |
| **Sepolia, draw 1, height 5** | **4,476,000** | **9,134,672** |
| difference | 0.00% | |

Draw 1 descended five levels over 24 seeded stakes with a published total
weight of 124,000,000, opened at block 11597931, and `drawLot` used 2,566,618
gas. The record is [`deployments/sepolia-livedraw.json`](deployments/sepolia-livedraw.json),
written by [`scripts/draw.ts`](scripts/draw.ts), which refuses to open a draw
at all unless `activeHeight()` reports 5 and at least 20 leaves carry weight.
An earlier comparison at height 2 agreed exactly too, at 2,199,000 both ways,
and [`test/Calibration.t.ts`](test/Calibration.t.ts) pins that so it cannot
drift silently (commit `fae6fbf`).

At 89.52% of the depth budget there is no margin, which is why the comparison
matters: had the chain disagreed with the mock by even one percent, the shard
would have had to drop to height 4.

**Depth binds, not global work.** That distinction decides what can be done
about it: too much work splits across checkpointed transactions, a chain that
is too long does not. So this is a hard ceiling, and the protocol shards rather
than pretending otherwise.

The cost is about 728,000 HCU per level of the descent, and most of it is
turning a node's intercept and slope into a weight on the critical path. That
is the price of a weight line that never goes stale.

**The named path to raising it**, if there is ever slack: materialise the
weights once at `openDraw` instead of evaluating intercept and slope at every
level. Each node's evaluation is independent, so a snapshot pass bills against
the 20,000,000 global budget rather than the 5,000,000 depth one. That does not
make a shard much larger, but it converts a hard ceiling into a soft one,
because global work is checkpointable and depth is not.

## Weight is a line, not a stale point

A stake's weight is money multiplied by the hours it sat there. Accruing
`balance * elapsed` into an accumulator on every balance change looks right and
is wrong: weight then only moves when the stake is touched, so a depositor who
commits once and leaves the position alone carries the weight they had at their
last change. For a stake that never changed, that is zero. Safe against
sniping, and useless to an honest saver.

Weight over time is piecewise linear, so store the line:

```
weight(T) = intercept + slope * T
```

A balance change of `delta` at hour `t` moves it by `slope += delta` and
`intercept -= delta * t`. Both terms are additive over a subtree, so the exact
time-weighted total of any subtree at any T is one scalar multiply and one add.
No accrual pass, no keeper, nothing stale.

Time is whole hours since deployment, not unix seconds: `slope * T` has to fit
in a `euint64`, and a ten million dollar pool against a unix timestamp is
1.8e22 against a ceiling of 1.8e19. Hourly granularity is also the anti-snipe
property, and for a better reason than an accrual pass would give. A stake
committed minutes before a draw is worth zero because it has genuinely been in
the pool for no time, not because a keeper missed it.

## Contracts

| file | what it does |
| --- | --- |
| [`SortisRegister.sol`](contracts/SortisRegister.sol) | Two encrypted segment trees, intercept and slope. `_update` and the oblivious `_walk`. |
| [`SortisTwab.sol`](contracts/SortisTwab.sol) | A stake's own copy of its weight line. Scalar `FHE.mul` for the time term. |
| [`SortisPool.sol`](contracts/SortisPool.sol) | `commit` and `release`. Over-withdrawal is an encrypted no-op, never a revert. |
| [`SortisDraw.sol`](contracts/SortisDraw.sol) | `openDraw` then `drawLot`, two transactions. Native randomness, winner never revealed. |
| [`SortisWrapQueue.sol`](contracts/SortisWrapQueue.sol) | Epoch-batched wrapping of public USDT into confidential stakes. |

Every function states its worst-case HCU depth in a comment above it.

### Why an over-withdrawal does not revert

Reverting on an encrypted comparison publishes the comparison. A `release(X)`
that reverts proves the caller's balance is below X, and one that succeeds
proves it is at or above X, so an attacker binary-searches any balance in about
64 transactions. `SortisPool.release` uses `FHESafeMath.tryDecrease`, which
returns an encrypted success flag and leaves the balance untouched on failure.
A refused release transfers zero, moves the weight line by zero, emits the same
event, and matches an honoured one on gas, HCU depth and global HCU. All of it
is asserted in [`test/Pool.t.ts`](test/Pool.t.ts).

`tryDecrease` and not `trySub`: both return a flag, but `trySub` returns zero
on failure, which would wipe a stake the first time someone fat-fingered a
release.

### The draw is two transactions, and the order is the argument

`openDraw` captures the reference hour, publishes the register's total weight
at it, and records both root handles and the block. No randomness exists yet.
`drawLot` produces the lot in a later block with `FHE.randEuint64`, refuses to
run in the opening block, and refuses if either root handle moved in between.
Handles are content-derived, so that check is cryptographic rather than a
promise.

The lot must land uniformly in `[0, total)`, and every reduction FHEVM offers
takes a plaintext bound: there is no ciphertext-ciphertext remainder, and
`FHE.randEuint64(bound)` reverts with `NotPowerOfTwo` unless the bound is a
power of two. So the total is published, verified with `FHE.checkSignatures`
against the KMS, and decoded from the bytes that were verified.

### The prize is claimed, not pushed

`FHE.allow` takes a plaintext address and the walk resolves to an encrypted
index, so granting from `drawLot` would mean decrypting the winner.
`claimPrize` compares the caller's own leaf against the encrypted result under
encryption and transfers the prize or an encrypted zero. Every claimant runs
identical code and moves an identically shaped ciphertext.

## Sepolia

One shard, deployed at register height 5 so capacity enforces the measured
ceiling: the 33rd depositor is rejected rather than silently pushing the draw
past what it can settle.

| contract | address |
| --- | --- |
| SortisPool | [`0xa57F6D5FC7780cbE5324EeC26d5a6BA88D22AeBa`](https://sepolia.etherscan.io/address/0xa57F6D5FC7780cbE5324EeC26d5a6BA88D22AeBa) |
| SortisDraw | [`0x11625163932a8FD0cdB224B440c1C51C36Da0281`](https://sepolia.etherscan.io/address/0x11625163932a8FD0cdB224B440c1C51C36Da0281) |
| SortisWrapQueue | [`0xF492f9b8e9dC86F6d6CDad46BaF66A332029c3Cc`](https://sepolia.etherscan.io/address/0xF492f9b8e9dC86F6d6CDad46BaF66A332029c3Cc) |
| cUSDT (mock) | [`0x0ADfC89408f91aA3da2bac550Da87E1c6d08e989`](https://sepolia.etherscan.io/address/0x0ADfC89408f91aA3da2bac550Da87E1c6d08e989) |
| USDT (mock) | [`0x6fa6daC32f9065Ab1caE413ae9726fD55E0F420A`](https://sepolia.etherscan.io/address/0x6fa6daC32f9065Ab1caE413ae9726fD55E0F420A) |
| Yield adapter (mock) | [`0xBeb04ad88B411661D15742dbE1a659a6CEbB96Ae`](https://sepolia.etherscan.io/address/0xBeb04ad88B411661D15742dbE1a659a6CEbB96Ae) |

`SortisDraw` was redeployed on 2026-08-30 to add the minimum draw interval that
makes `openDraw` safe to leave permissionless. The addresses of record are
[`deployments/sepolia.json`](deployments/sepolia.json).

### Scripts

Copy `.env.example` to `.env` and set `PRIVATE_KEY` to a funded account.

| script | what it does |
| --- | --- |
| `scripts/deploy.ts` | Deploys all six contracts and writes `deployments/sepolia.json`. |
| `scripts/redeploy-draw.ts` | Replaces `SortisDraw` alone, keeping the register and its stakes. |
| `scripts/seed.ts` | Fills the shard with stakes. Resumable, because a dropped socket should not cost the run. |
| `scripts/draw.ts` | Opens, settles and claims one draw, gated on `activeHeight()` and weighted leaves. Prints the HCU. |
| `scripts/weights.ts` | Read-only report of every leaf's weight line. Changes nothing. |
| `scripts/calibrate.ts` | Compares mock HCU against the chain at the deployed height. |
| `scripts/live.ts` | One full commit, hold, release, over-release, draw and claim end to end. |

```bash
npm run deploy:sepolia
npm run live:sepolia
```

**Budget about ninety minutes for `live`.** `initializeCLIApi` downloads the
4.6MB PKE CRS from S3 in eu-west-1 and does not cache it between processes,
which takes about twenty minutes on a slow link. Each encrypted input costs
roughly forty seconds. The hold has to cross an hour boundary for the stake to
carry weight. That is why the cycle and the draw run in one script rather than
two.

## Frontend

One Next.js app in [`web/`](web) serving all three surfaces by Host header. See
[`web/README.md`](web/README.md). Wallets are connected through Privy, wallet
only, with no email step.

### Deploying it

The Next app lives in `web/`, and the repository root is the Hardhat project.
A Vercel build pointed at the root fails with `No Next.js version detected`,
because the root `package.json` has no `next` in it and should not.

The fix is the project's **Root Directory** setting, which is `web`. Vercel
then treats `web/package.json` as the manifest, finds `next` where it actually
is, and reads `web/vercel.json`.

There is no `vercel.json` at the repository root, and there should not be. An
earlier one carried `npm install --prefix web` so that a build from the root
would work, and once Root Directory moved to `web` that command resolved to
`web/web` and every deploy failed with exit 254. One place decides where the
app lives.

### Environment variables

Set these on the Vercel project, for Production and Preview. Without them the
footer reads "Not deployed", the stat strip has nothing to show, and Verify has
no contract to read. None of them are secret.

```
NEXT_PUBLIC_POOL_ADDRESS    0xa57F6D5FC7780cbE5324EeC26d5a6BA88D22AeBa
NEXT_PUBLIC_DRAW_ADDRESS    0x11625163932a8FD0cdB224B440c1C51C36Da0281
NEXT_PUBLIC_CUSDT_ADDRESS   0x0ADfC89408f91aA3da2bac550Da87E1c6d08e989
NEXT_PUBLIC_YIELD_ADDRESS   0xBeb04ad88B411661D15742dbE1a659a6CEbB96Ae
NEXT_PUBLIC_DEPLOY_BLOCK    11578000
NEXT_PUBLIC_PRIVY_APP_ID    cmtf6vqxw01zj0cl1wag5zru2
```

`NEXT_PUBLIC_SEPOLIA_RPC_URL` replaces the public fallback, which is rate
limited hard enough to be the first thing that breaks under a judge's traffic.

A free Infura key serves this app, but only because every read retries. The
register's `LeafAssigned` scan is the read that suffers first, and it was
failing often enough that the register rendered empty and the draw screen
printed "Chain unreachable" beside a header showing live data. I took that for
a hard tier limit and it was not: `resilientRead` had been wired into exactly
one call out of six. Retrying the rest fixed it. When a read does exhaust its
retries the app names that state rather than drawing an empty register, because
a failed read and an empty shard must never look the same.

`NEXT_PUBLIC_DEPLOY_BLOCK` is the earliest block worth scanning for this
deployment's logs. Public RPCs reject an unbounded `fromBlock: 0` range, which
is what made the draw history render empty while every direct read on the same
page succeeded. Update it if you redeploy the contracts.

`PRIVY_APP_SECRET` is server-side only and is not prefixed `NEXT_PUBLIC_`. It
must never be.

## Status

**Built and live:** all six contracts on Sepolia, the HCU suite, one shard
seeded to 24 of 32, one draw opened, settled and claimed on it, the register,
draw and verify screens, permissionless draw opening, the five named error
states, and the landing page.

**Not built:** the four docs pages under `/docs` are a placeholder. The yield
source is a mock, described above. There is one shard, so the multi-shard
routing the thesis depends on is designed and not deployed.
