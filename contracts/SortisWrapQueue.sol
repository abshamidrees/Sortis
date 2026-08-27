// SPDX-License-Identifier: BSD-3-Clause-Clear
pragma solidity ^0.8.27;

import {FHE, euint64} from "@fhevm/solidity/lib/FHE.sol";
import {ZamaEthereumConfig} from "@fhevm/solidity/config/ZamaConfig.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

import {SortisPool} from "./SortisPool.sol";
import {MockConfidentialUSDT} from "./mocks/MockConfidentialUSDT.sol";

/**
 * @title  SortisWrapQueue
 * @notice Batches public USDT into confidential stakes, so the step from a
 *         public address to a confidential position is one-to-many across an
 *         epoch rather than one-to-one.
 *
 * @dev ---------------------------------------------------------------------
 *      THE PROBLEM THIS SOLVES, AND HOW MUCH OF IT
 *      ---------------------------------------------------------------------
 *      Committing directly means a public USDT transfer of a visible amount
 *      lands in the same transaction as a confidential stake. The amount is
 *      encrypted the instant it is inside the pool and completely public one
 *      call earlier. An observer reads the ERC-20 transfer and knows the stake.
 *
 *      Queueing breaks the pairing in time and in aggregation. Deposits
 *      accumulate for an epoch; at settlement the whole epoch is wrapped and
 *      credited together, so the on-chain link between any one public sender
 *      and any one confidential stake is one-to-many across everyone who
 *      queued in that window.
 *
 *      BE HONEST ABOUT THE LIMIT. Batching raises the cost of linkage, it does
 *      not eliminate it:
 *
 *        - A depositor who is alone in an epoch gets no anonymity set at all.
 *          Their public deposit and their stake are still one-to-one.
 *        - Amounts are not mixed. If the epoch holds deposits of 100, 5,000 and
 *          1,000,000 USDT, the three resulting stakes are trivially matched
 *          back by size.
 *        - Settlement order is visible. `creditFromQueue` emits a Committed
 *          event per entry with the stake owner in it.
 *
 *      What it genuinely buys is unlinkability of TIMING and, when an epoch is
 *      busy with similar amounts, of identity. Anything stronger needs equal
 *      denominations and a real mixer, which is a different protocol. Saying so
 *      plainly is worth more than overclaiming.
 *
 *      ---------------------------------------------------------------------
 *      WHY SETTLEMENT IS PAGINATED
 *      ---------------------------------------------------------------------
 *      Each credit is a full pool commit: an accrual, a register update, a
 *      balance write. That is roughly 2,760,000 global HCU, so about seven
 *      entries exhaust the 20,000,000 per-transaction budget.
 *
 *      `settleEpoch` therefore processes a bounded batch and advances a cursor,
 *      and is called repeatedly until the epoch drains. This is exactly the
 *      checkpointed-transaction escape hatch that docs/BRIEF.md section 1 point
 *      4 sanctions, and section 4 explicitly points at the epoch settlement
 *      path as the place to use it. The draw does NOT get to use it; that one
 *      has to fit in a single transaction.
 */
contract SortisWrapQueue is ZamaEthereumConfig {
    using SafeERC20 for IERC20;

    // ---------------------------------------------------------------------
    // Types and storage
    // ---------------------------------------------------------------------

    struct Entry {
        address depositor;
        uint256 amount;
    }

    struct Epoch {
        /// Entries queued in this epoch.
        Entry[] entries;
        /// How many have been credited so far. The checkpoint cursor.
        uint256 settled;
        /// Total public USDT queued.
        uint256 total;
        /// Set when the cursor reaches the end.
        bool closed;
    }

    IERC20 public immutable usdt;
    MockConfidentialUSDT public immutable cUSDT;
    SortisPool public immutable pool;

    /// @notice Epoch length. Public parameter, 4 hours on Sepolia so a demo can
    ///         actually show one turning over. Mainnet would run longer, which
    ///         is strictly better for the anonymity set.
    uint256 public immutable epochLength;

    /// @notice When epoch 0 began.
    uint256 public immutable genesis;

    /// @notice Entries credited per settleEpoch call. Bounded by the 20M global
    ///         HCU budget at roughly 2,760,000 per credit.
    uint256 public constant MAX_SETTLE_BATCH = 6;

    mapping(uint256 => Epoch) private _epochs;

    // ---------------------------------------------------------------------
    // Events
    // ---------------------------------------------------------------------

    event Enqueued(uint256 indexed epoch, address indexed depositor, uint256 amount);
    event EpochSettled(uint256 indexed epoch, uint256 from, uint256 to, uint256 remaining);
    event EpochClosed(uint256 indexed epoch, uint256 entries, uint256 total);

    // ---------------------------------------------------------------------
    // Errors
    // ---------------------------------------------------------------------

    error ZeroAmount();
    error EpochStillOpen(uint256 epoch, uint256 endsAt);
    error EpochAlreadyClosed(uint256 epoch);
    error NothingQueued(uint256 epoch);

    // ---------------------------------------------------------------------
    // Constructor
    // ---------------------------------------------------------------------

    /**
     * @notice Wire the queue to the public asset, the confidential asset and
     *         the pool.
     * @dev WORST-CASE HCU DEPTH: 0. No FHE operation.
     */
    constructor(address usdtAddress, address cUsdtAddress, address poolAddress, uint256 epochSeconds) {
        usdt = IERC20(usdtAddress);
        cUSDT = MockConfidentialUSDT(cUsdtAddress);
        pool = SortisPool(poolAddress);
        epochLength = epochSeconds;
        genesis = block.timestamp;
    }

    // ---------------------------------------------------------------------
    // Views
    // ---------------------------------------------------------------------

    /// @notice The epoch currently accepting deposits.
    /// @dev WORST-CASE HCU DEPTH: 0. Plaintext arithmetic.
    function currentEpoch() public view returns (uint256) {
        return (block.timestamp - genesis) / epochLength;
    }

    /// @notice When `epoch` stops accepting deposits.
    /// @dev WORST-CASE HCU DEPTH: 0. Plaintext arithmetic.
    function epochEndsAt(uint256 epoch) public view returns (uint256) {
        return genesis + (epoch + 1) * epochLength;
    }

    /**
     * @notice Queue state for `epoch`.
     * @dev WORST-CASE HCU DEPTH: 0. Plaintext reads. The number of participants
     *      is public on purpose: a depositor deserves to know how large their
     *      anonymity set is before they rely on it.
     */
    function epochInfo(
        uint256 epoch
    ) external view returns (uint256 entries, uint256 settled, uint256 total, bool closed) {
        Epoch storage e = _epochs[epoch];
        return (e.entries.length, e.settled, e.total, e.closed);
    }

    // ---------------------------------------------------------------------
    // Enqueue
    // ---------------------------------------------------------------------

    /**
     * @notice Queue public USDT for confidential deposit at the end of the
     *         current epoch.
     *
     * @dev WORST-CASE HCU DEPTH: 0. This function performs no FHE operation at
     *      all -- it takes public tokens and writes a plaintext row. The
     *      encryption happens at settlement, which is the entire point: the
     *      public leg and the confidential leg are in different transactions,
     *      in different blocks, mixed with everyone else who queued.
     */
    function enqueue(uint256 usdtAmount) external {
        if (usdtAmount == 0) revert ZeroAmount();

        uint256 epoch = currentEpoch();
        Epoch storage e = _epochs[epoch];
        if (e.closed) revert EpochAlreadyClosed(epoch);

        usdt.safeTransferFrom(msg.sender, address(this), usdtAmount);

        e.entries.push(Entry({depositor: msg.sender, amount: usdtAmount}));
        e.total += usdtAmount;

        emit Enqueued(epoch, msg.sender, usdtAmount);
    }

    // ---------------------------------------------------------------------
    // Settlement
    // ---------------------------------------------------------------------

    /**
     * @notice Wrap and credit up to MAX_SETTLE_BATCH entries of a finished
     *         epoch. Call repeatedly until `closed`.
     *
     * @dev WORST-CASE HCU DEPTH: 713,000. One credit is one commit-shaped chain
     *      and the batch's credits are independent of each other, so the batch
     *      is as DEEP as a single credit no matter how many it processes.
     *
     *      WORST-CASE GLOBAL HCU: MAX_SETTLE_BATCH * ~2,760,000, which at six
     *      is about 16,560,000 and fits under the 20,000,000 cap with room for
     *      the wrap. That is what sets the batch size; raising it past seven
     *      reverts with HCUTransactionLimitExceeded.
     *
     *      Permissionless on purpose. Anyone can settle an epoch that has
     *      ended, so a depositor is never waiting on an operator to release
     *      their own money.
     */
    function settleEpoch(uint256 epoch) external returns (uint256 credited, bool closed) {
        Epoch storage e = _epochs[epoch];

        if (e.closed) revert EpochAlreadyClosed(epoch);
        if (block.timestamp < epochEndsAt(epoch)) revert EpochStillOpen(epoch, epochEndsAt(epoch));
        if (e.entries.length == 0) revert NothingQueued(epoch);

        uint256 from = e.settled;
        uint256 to = from + MAX_SETTLE_BATCH;
        if (to > e.entries.length) to = e.entries.length;

        for (uint256 i = from; i < to; i++) {
            Entry storage entry = e.entries[i];

            // Wrap: public USDT in, confidential USDT out. On Sepolia the mock
            // mints 1:1; mainnet routes through ERC7984ERC20Wrapper against the
            // real confidential USDT. Either way the public amount stops being
            // public here.
            uint64 amount = uint64(entry.amount);
            cUSDT.mint(address(pool), amount);

            euint64 encrypted = FHE.asEuint64(amount);
            FHE.allowThis(encrypted);
            FHE.allowTransient(encrypted, address(pool));

            pool.creditFromQueue(entry.depositor, encrypted);
        }

        e.settled = to;
        credited = to - from;
        closed = to == e.entries.length;

        if (closed) {
            e.closed = true;
            emit EpochClosed(epoch, e.entries.length, e.total);
        }

        emit EpochSettled(epoch, from, to, e.entries.length - to);
    }
}
