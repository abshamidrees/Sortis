# Sortis

Confidential prize-linked savings. You commit, you cannot lose your principal,
the pooled yield is drawn as a prize on a schedule, and nothing about your
position is visible to anyone.

Built for the Zama Developer Program, Mainnet Season 4. See [docs/BRIEF.md](docs/BRIEF.md)
for the full design.

## For judges

**Live app:** not yet published. See [Deploying the frontend](#deploying-the-frontend)
below, then put the URL here. Everything else works against the Sepolia
deployment already listed under [Sepolia](#sepolia), from any browser with a
wallet.

Sepolia ETH is the only thing you need to bring. The pool's test token has an
open faucet in the app.

### Trying every feature, in order

1. Open `/app/register` and connect a wallet on Sepolia.
2. Press **Mint 5 cUSDT**. This mints the pool's ERC-7984 test token to you and
   authorises the pool as an ERC-7984 operator in the same step, because a
   commit fails without that authorisation and a judge should never hit that
   for a reason the UI never mentioned.
3. Enter an amount and press **Commit**. The amount is encrypted in your
   browser by the relayer SDK, sent as a ciphertext handle with an input proof,
   and pulled with `confidentialTransferFrom`. Nothing readable leaves your
   machine.
4. Press **decrypt** next to STAKE. Your wallet signs an EIP-712 grant scoped to
   the pool and a one-day window, and the relayer returns the plaintext to this
   browser only. That is the user-decryption flow.
5. Wait for the stake to cross an hour boundary, then open `/app` to see the
   register, the current draw and the history.
6. Press **Release** to withdraw. Principal is withdrawable at any time. Try an
   amount larger than your stake: the transaction succeeds, moves nothing, and
   costs the same gas as one that does, because reverting on an encrypted
   comparison would leak the balance.
7. Open `/app/verify` and verify a draw. This works with no wallet connected.

### Triggering a draw

Draws are operator-triggered on Sepolia, and the flow is two transactions on
purpose. From a clone with `PRIVATE_KEY` set to the deployer:

```bash
npx hardhat run scripts/live.ts --network sepolia
```

That runs a full commit, hold, release, over-release, `openDraw`, `drawLot` and
`claimPrize` against the live contracts and prints every gas figure. It takes
about ninety minutes end to end, most of it the hour the stake has to sit to
carry weight. `LIVE_SKIP_COMMIT=1 LIVE_HOLD_SECONDS=0` resumes from the release
if a stake already exists.

### The yield source is a mock, and here is exactly how

`MockYieldAdapter` has an admin-callable `accrue(uint64)` that books a prize,
and `harvest(address)` mints that much cUSDT into the draw contract and resets.
That is the whole of it. Sepolia has no real yield and building a convincing
fake one would cost days and prove nothing about the part of this that is hard.

The mainnet path is the same `ISortisYieldAdapter` interface in front of an
ERC-4626 vault. `SortisDraw` only ever calls `harvest(address)` and only ever
treats the result as a public `uint64`, so swapping the adapter is a
constructor argument and no contract change.

## Deploying the frontend

The Next app lives in `web/`, and the repository root is the Hardhat project.
A Vercel build pointed at the root fails with `No Next.js version detected`,
because the root `package.json` has no `next` in it and should not.

`vercel.json` at the root fixes this by building from `web/` explicitly. If you
would rather use the dashboard, set **Root Directory** to `web` in project
settings, which makes `web/vercel.json` the one that applies. Either works;
both are committed so it does not matter which you pick.

### Environment variables

Set these on the Vercel project, for Production and Preview. Without them the
footer reads "Not deployed", the stat strip has nothing to show, and Verify has
no contract to read. None of them are secret.

```
NEXT_PUBLIC_POOL_ADDRESS    0xa57F6D5FC7780cbE5324EeC26d5a6BA88D22AeBa
NEXT_PUBLIC_DRAW_ADDRESS    0xBB39Fd2c061A138940dfC3aC182B5847d163EC57
NEXT_PUBLIC_CUSDT_ADDRESS   0x0ADfC89408f91aA3da2bac550Da87E1c6d08e989
NEXT_PUBLIC_YIELD_ADDRESS   0xBeb04ad88B411661D15742dbE1a659a6CEbB96Ae
NEXT_PUBLIC_DEPLOY_BLOCK    11578000
```

Two more are optional. `NEXT_PUBLIC_SEPOLIA_RPC_URL` replaces the public
fallback, which is rate limited and will be the first thing to break under a
judge's traffic. `NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID` adds WalletConnect to
the wallet list; without it the app offers injected wallets only, which is
deliberate rather than a gap. RainbowKit initialises WalletConnect on page load
whether or not anyone uses it, and with a placeholder id that means a 403 and a
400 in the console of every visitor.

`NEXT_PUBLIC_DEPLOY_BLOCK` is the earliest block worth scanning for this
deployment's logs. Public RPCs reject an unbounded `fromBlock: 0` range, which
is what made the draw history render empty while every direct read on the same
page succeeded. Update it if you redeploy the contracts.

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

`test/HCU.t.ts` measures everything below and is a submission asset, not
internal hygiene. It does not assume where the ceiling is, it sweeps until the
transaction reverts.

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

**Verified against the chain, not just the mock.** A real draw on Sepolia at
active height 2 reported 2,199,000 HCU of depth. The mock reports 2,199,000 for
the same call. They agree exactly, which is what makes the table above
trustworthy. `test/Calibration.t.ts` pins that comparison so it cannot drift.

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
in a `euint64` and a ten million dollar pool against a unix timestamp is 1.8e22
against a ceiling of 1.8e19. Hourly granularity is also the anti-snipe
property, and for a better reason than before. A stake committed minutes before
a draw is worth zero because it has genuinely been in the pool for no time, not
because an accrual pass missed it.

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
that reverts proves the caller's balance is below X and one that succeeds
proves it is at or above X, so an attacker binary-searches any balance in about
64 transactions. `SortisPool.release` uses `FHESafeMath.tryDecrease`, which
returns an encrypted success flag and leaves the balance untouched on failure.
A refused release transfers zero, moves the weight line by zero, emits the same
event, and matches an honoured one on gas, HCU depth and global HCU. All of it
is asserted in `test/Pool.t.ts`.

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
power of two. So the total is published and verified with `FHE.checkSignatures`
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
| SortisPool | `0xa57F6D5FC7780cbE5324EeC26d5a6BA88D22AeBa` |
| SortisDraw | `0xBB39Fd2c061A138940dfC3aC182B5847d163EC57` |
| SortisWrapQueue | `0xF492f9b8e9dC86F6d6CDad46BaF66A332029c3Cc` |
| cUSDT (mock) | `0x0ADfC89408f91aA3da2bac550Da87E1c6d08e989` |
| USDT (mock) | `0x6fa6daC32f9065Ab1caE413ae9726fD55E0F420A` |
| Yield adapter (mock) | `0xBeb04ad88B411661D15742dbE1a659a6CEbB96Ae` |

### Running against Sepolia

Copy `.env.example` to `.env` and set `PRIVATE_KEY` to a funded account.

```bash
npm run deploy:sepolia
```

One live commit, hold, release and draw in a single process:

```bash
npm run live:sepolia
```

**Budget about ninety minutes.** `initializeCLIApi` downloads the 4.6MB PKE CRS
from S3 in eu-west-1 and does not cache it between processes, which takes about
twenty minutes on a slow link. Each encrypted input costs roughly forty
seconds. The hold has to cross an hour boundary for the stake to carry weight.
That is why the cycle and the draw run in one script rather than two.

## Frontend

One Next.js app in [`web/`](web) serving all three surfaces by Host header. See
[`web/README.md`](web/README.md).

## Status

Built: all five contracts, the HCU suite, one Sepolia shard, and the landing
page with the draw column.

Not built: the Verify screen, the Register screen, the six docs pages, and
wiring the draw column to live Sepolia instead of its local simulation.
