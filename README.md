# Sortis

Confidential prize-linked savings. You commit, you cannot lose your principal,
the pooled yield is drawn as a prize on a schedule, and nothing about your
position is visible to anyone.

Built for the Zama Developer Program, Mainnet Season 4. See [docs/BRIEF.md](docs/BRIEF.md)
for the full design.

## Where the interesting part is

Everything turns on two FHEVM limits, enforced per transaction:

| budget | limit | what it measures |
| --- | --- | --- |
| global complexity | 20,000,000 HCU | work that can run in parallel |
| sequential depth | 5,000,000 HCU | the longest dependent chain |

A confidential prize pool built the obvious way encrypts balances and scans
them, which is N dependent adds and dies at about 30 depositors. Sortis keeps
the weights in an encrypted segment tree instead.

`test/HCU.t.ts` measures the real cost of every operation against those budgets
at register sizes 2^4 through 2^16 and prints the numbers. It is the proof the
architecture is real, and it is worth reading before the contracts.

```bash
npm test
```

### The update path is parallel, not deep

Maintaining a segment tree the obvious way recomputes each parent from its
children, so every parent depends on the child written a step earlier: a chain
of 17 adds, 2,754,000 HCU of sequential depth, 55% of the budget.

`SortisRegister._update` folds the sign into the delta once and adds that single
ciphertext to every node on the path. Each node then depends only on itself and
that delta, so the adds are mutually independent and bill against the global
budget instead. **Sequential depth is a flat 348,000 regardless of tree height:**

| register | seq depth | of budget | global HCU | of budget |
| --- | --- | --- | --- | --- |
| 2^4 | 348,000 | 6.96% | 996,000 | 4.98% |
| 2^8 | 348,000 | 6.96% | 1,644,000 | 8.22% |
| 2^12 | 348,000 | 6.96% | 2,292,000 | 11.46% |
| 2^16 | 348,000 | 6.96% | 2,940,000 | 14.70% |

### The draw cannot be both O(log N) and winner-hiding

This is the finding the HCU suite surfaced, and it constrains the product.

Descending the tree needs the left-child sum at each level. Reading it requires
a plaintext node index; keeping the winner secret requires the index to stay
encrypted. `SortisRegister._walk` resolves this with an oblivious read: at level
k the descent could be on any of 2^k nodes, so it loads every candidate and
folds them with the branch bits already decided.

That is correct and never branches on a ciphertext, but it is Ω(N) — and not
because of how it is written. A computation that hides which leaf it chose must
touch every leaf it could have chosen.

| register | seq depth | of budget | global HCU | of budget | |
| --- | --- | --- | --- | --- | --- |
| 2^4 | 1,038,032 | 20.76% | 2,556,192 | 12.78% | measured |
| 2^8 | 1,999,032 | 39.98% | 17,585,952 | 87.93% | measured |
| 2^12 | ~2,960,032 | 59.20% | ~230,604,000 | 1153% | reverts |
| 2^16 | ~3,921,032 | 78.42% | ~3,611,628,000 | 18058% | reverts |

Depth is comfortable everywhere. The **global** budget is what binds, and it
caps a single-transaction winner-hiding draw at roughly 2^8 = 256 stakes. The
reverts are `HCUTransactionLimitExceeded`, never `HCUTransactionDepthLimitExceeded`
— a distinction the test asserts, because too much work is splittable across
checkpointed transactions and a chain that is too long is not.

## Contracts

| file | what it does |
| --- | --- |
| [`SortisRegister.sol`](contracts/SortisRegister.sol) | Encrypted segment tree. `_update` (O(log N), flat depth) and `_walk` (oblivious descent). |
| [`SortisTwab.sol`](contracts/SortisTwab.sol) | Time-weighted balance observations. Scalar `FHE.mul` for the time multiplier. |
| [`SortisPool.sol`](contracts/SortisPool.sol) | `commit` and `release`. Over-withdrawal is an encrypted no-op, never a revert. |

Every function states its worst-case HCU depth in a comment above it.

### Why an over-withdrawal does not revert

Reverting on an encrypted comparison publishes the comparison. A `release(X)`
that reverts proves the caller's balance is below X and one that succeeds proves
it is at or above X, so an attacker binary-searches any balance in about 64
transactions. `SortisPool.release` uses `FHESafeMath.tryDecrease`, which returns
an encrypted success flag and leaves the balance untouched on failure. A refused
release transfers zero, writes back the same balance, emits the same event, and
matches an honoured one on gas, HCU depth and global HCU — all asserted in
`test/Pool.t.ts`.

## Running it

```bash
npm install
npm test
```

Deploy and run a full commit / wait / release cycle:

```bash
npm run deploy:sepolia
```

```bash
npm run cycle:sepolia
```

Both need a funded deployer. Copy `.env.example` to `.env` and set `PRIVATE_KEY`
or `MNEMONIC`; the default is the public Hardhat test phrase, which never has
Sepolia ETH.

## Status

Built: the register, the walk, the TWAB, the pool, and the HCU suite.
Not yet built: `SortisDraw`, `SortisWrapQueue`, the yield adapter, and the three
frontends.

The TWAB has a known gap documented at the top of [`SortisTwab.sol`](contracts/SortisTwab.sol):
weight accrues only when a balance changes, so a stake that is committed and left
alone carries stale weight. The fix — keeping an intercept and a slope per
register node so any subtree's exact weight at time T is one scalar multiply —
is described there and deliberately deferred until the draw is being wired up.
