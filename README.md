# Sortis

Confidential prize-linked savings. You commit, you cannot lose your principal,
the pooled yield is drawn as a prize on a schedule, and nothing about your
position is visible to anyone.

Built for the Zama Developer Program, Mainnet Season 4. See [docs/BRIEF.md](docs/BRIEF.md)
for the full design.

## The thesis, in one paragraph

Every other entry will encrypt balances and scan them, which reverts at 30
depositors because of the FHEVM sequential depth budget. Sortis descends an
encrypted tree instead. That draws from 64 stakes in a single transaction, and
scales by adding shards rather than by growing the tree. The 64 is not a
target, it is measured: hiding the winner forces the search to touch every leaf
it could have picked, so the cost is linear in stakes however the tree is
arranged, and depth runs out at 128.

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

| stakes | seq depth | of budget | global HCU | of budget | result |
| --- | --- | --- | --- | --- | --- |
| 16 | 3,098,000 | 61.96% | 5,269,896 | 26.35% | fits |
| 32 | 3,826,000 | 76.52% | 7,958,888 | 39.79% | fits |
| 64 | 4,647,000 | 92.94% | 12,408,904 | 62.04% | fits, and this is the shard |
| 128 | reverts | | | | depth budget |

**Depth binds, not global work.** That distinction decides what can be done
about it: too much work splits across checkpointed transactions, a chain that
is too long does not. So 64 is a hard ceiling, and the protocol shards rather
than pretending otherwise.

The cost per level is about 774,500 HCU, and 527,000 of that is turning a
node's intercept and slope into a weight. That is the price of a weight line
that never goes stale, and it is why this ceiling is lower than an earlier
single-tree version's.

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

One shard, deployed at register height 6 so capacity enforces the measured
ceiling: the 65th depositor is rejected rather than silently pushing the draw
past what it can settle.

| contract | address |
| --- | --- |
| SortisPool | `0xe797Ce8f0F642045d93F329054BDF8895A6A505D` |
| SortisDraw | `0x4D319809028802278620E06e9FC46414ccAec57A` |
| SortisWrapQueue | `0x8ef3E4BA6Fd255Afb1e900E24bbDB188E8efBb46` |
| cUSDT (mock) | `0xa31A85CD14cc1405870a5662d0EFfd11022D8BcE` |
| USDT (mock) | `0x34Eb4cFEcc10902995C6041037EE2dad94f22dea` |
| Yield adapter (mock) | `0x225BdbFa3694936DdCef1885BE2451dE92eAE6b4` |

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
