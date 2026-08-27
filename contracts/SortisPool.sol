// SPDX-License-Identifier: BSD-3-Clause-Clear
pragma solidity ^0.8.27;

import {FHE, euint64, euint16, ebool, externalEuint64} from "@fhevm/solidity/lib/FHE.sol";
import {IERC7984} from "@openzeppelin/confidential-contracts/interfaces/IERC7984.sol";
import {FHESafeMath} from "@openzeppelin/confidential-contracts/utils/FHESafeMath.sol";

import {SortisRegister} from "./SortisRegister.sol";
import {SortisTwab} from "./SortisTwab.sol";

/**
 * @title  SortisPool
 * @notice The user-facing contract. Money is committed, held as a stake, and
 *         released. Nothing about the size of a position is visible to anyone
 *         but its owner.
 *
 * @dev ---------------------------------------------------------------------
 *      COMPOSITION
 *      ---------------------------------------------------------------------
 *      The pool inherits the register and the TWAB rather than calling them
 *      across contract boundaries. `_update` and `_accrue` are internal by
 *      design, and keeping them in one address means the ciphertext handles
 *      they pass around never need cross-contract ACL grants. Three files,
 *      three concerns, one deployed address.
 *
 *      ---------------------------------------------------------------------
 *      WHAT IS AND IS NOT HIDDEN
 *      ---------------------------------------------------------------------
 *      Hidden: every amount. How much was committed, how much was released,
 *      what a stake holds, what weight it carries, whether a release was
 *      honoured or silently refused.
 *
 *      Not hidden: that an address interacted with the pool, when, and in
 *      which direction. `commit` pulls with `confidentialTransferFrom` and
 *      `release` pushes with `confidentialTransfer`, and those are different
 *      external calls. Claiming otherwise would be false. What the design does
 *      guarantee is that the two are indistinguishable INSIDE the register --
 *      identical node set, identical operation count, identical execution gas
 *      -- which is what keeps the draw honest. SortisWrapQueue is where the
 *      linkage between a public address and a confidential stake gets attacked.
 */
contract SortisPool is SortisRegister, SortisTwab {
    // ---------------------------------------------------------------------
    // Storage
    // ---------------------------------------------------------------------

    /// @notice The confidential asset the pool holds. cUSDT on Sepolia.
    IERC7984 public immutable asset;

    /// @notice Governance. Sets the two privileged peers below, nothing else.
    /// @dev Named governor rather than owner because every inherited view takes
    ///      an `owner` parameter and the shadowing reads badly.
    address public governor;

    /// @notice The only address allowed to walk the register.
    address public drawContract;

    /// @notice The only address allowed to credit a stake without a transfer.
    address public wrapQueue;

    // ---------------------------------------------------------------------
    // Events
    // ---------------------------------------------------------------------

    /**
     * @dev Deliberately carries no amount, not even a ciphertext handle. An
     *      indexed handle would be a stable identifier an observer could
     *      correlate across transactions.
     */
    event Committed(address indexed owner, uint256 indexed leaf);
    event Released(address indexed owner, uint256 indexed leaf);

    error AssetNotSet();
    error NotOwner();
    error NotDrawContract();
    error NotWrapQueue();

    event DrawContractSet(address indexed drawContract);
    event WrapQueueSet(address indexed wrapQueue);

    // ---------------------------------------------------------------------
    // Constructor
    // ---------------------------------------------------------------------

    /**
     * @notice Deploy a pool over `confidentialAsset` with a register of height
     *         `depth`. Production is depth 16.
     * @dev WORST-CASE HCU DEPTH: 0. No FHE operation.
     */
    constructor(address confidentialAsset, uint8 depth) SortisRegister(depth) {
        if (confidentialAsset == address(0)) revert AssetNotSet();
        asset = IERC7984(confidentialAsset);
        governor = msg.sender;
    }

    // ---------------------------------------------------------------------
    // Governance
    // ---------------------------------------------------------------------

    /**
     * @notice Authorise the draw contract to walk the register.
     * @dev WORST-CASE HCU DEPTH: 0. Plaintext write.
     *
     *      The draw is a separate contract because the brief separates them,
     *      but `_walk` is internal, so the pool has to hand it a door. This is
     *      that door and it is the only one.
     */
    function setDrawContract(address newDrawContract) external {
        if (msg.sender != governor) revert NotOwner();
        drawContract = newDrawContract;
        emit DrawContractSet(newDrawContract);
    }

    /**
     * @notice Authorise the wrap queue to credit stakes on settlement.
     * @dev WORST-CASE HCU DEPTH: 0. Plaintext write.
     */
    function setWrapQueue(address newWrapQueue) external {
        if (msg.sender != governor) revert NotOwner();
        wrapQueue = newWrapQueue;
        emit WrapQueueSet(newWrapQueue);
    }

    // ---------------------------------------------------------------------
    // Privileged peers
    // ---------------------------------------------------------------------

    /**
     * @notice Resolve `lot` to an encrypted leaf index. Draw contract only.
     *
     * @dev WORST-CASE HCU DEPTH: see `_walk`. About 240,250 per level of the
     *      ACTIVE subtree, which is `activeHeight()` levels, not DEPTH.
     *
     *      The returned index is granted persistently to the caller rather than
     *      transiently, because SortisDraw stores it and settles the prize in a
     *      later transaction. A transient grant would expire before the winner
     *      could claim.
     */
    function walkForDraw(euint64 lot) external returns (euint16 leafIndex) {
        if (msg.sender != drawContract) revert NotDrawContract();
        leafIndex = _walk(lot);
        FHE.allow(leafIndex, msg.sender);
    }

    /**
     * @notice Credit a stake without pulling a transfer. Wrap queue only.
     *
     * @dev WORST-CASE HCU DEPTH: 713,000, the same chain as `commit`.
     *
     *      The queue has already taken public USDT and wrapped it, so the funds
     *      are in hand and there is nothing to pull. Everything else -- the
     *      accrual, the register update, the ACL grant to the owner -- is
     *      identical to a direct commit, which is what makes a queued stake
     *      indistinguishable from a walk-in one once it lands.
     */
    function creditFromQueue(address stakeOwner, euint64 amount) external {
        if (msg.sender != wrapQueue) revert NotWrapQueue();

        uint256 leaf = _leafFor(stakeOwner);
        _startClock(stakeOwner);

        euint64 accruedWeight = _accrue(stakeOwner);
        _update(leaf, accruedWeight, FHE.asEbool(true));

        euint64 balance = confidentialBalanceOf(stakeOwner);
        _setBalance(stakeOwner, FHE.isInitialized(balance) ? FHE.add(balance, amount) : amount);

        emit Committed(stakeOwner, leaf);
    }

    /**
     * @notice Make the register root publicly decryptable, and grant it to the
     *         draw contract. Draw contract only.
     *
     * @dev WORST-CASE HCU DEPTH: 0. ACL operations only.
     *
     *      The total weight becomes public. That is deliberate and it is what
     *      the brief means by publishing the tree root: a draw nobody can
     *      verify the denominator of is not verifiable at all. The total is an
     *      aggregate over every stake and says nothing about any one of them.
     */
    function publishRootForDraw() external returns (euint64 currentRoot) {
        if (msg.sender != drawContract) revert NotDrawContract();
        currentRoot = root();
        FHE.allow(currentRoot, msg.sender);
        FHE.makePubliclyDecryptable(currentRoot);
    }

    // ---------------------------------------------------------------------
    // Views
    // ---------------------------------------------------------------------

    /**
     * @notice The caller's stake as a ciphertext handle.
     * @dev WORST-CASE HCU DEPTH: 0. Returns a stored handle. The frontend
     *      decrypts this client-side; the grant that makes that possible is
     *      issued in `_setBalance` and is scoped to the owner alone.
     */
    function stakeOf(address owner) public view returns (euint64) {
        return confidentialBalanceOf(owner);
    }

    // ---------------------------------------------------------------------
    // Commit
    // ---------------------------------------------------------------------

    /**
     * @notice Commit confidential funds to the pool.
     *
     * @dev WORST-CASE HCU DEPTH: 713,000 measured (14.3% of the 5,000,000
     *      budget), constant in the size of the register.
     *
     *      The chain is shorter than adding the two components suggests, and
     *      the reason is worth knowing:
     *
     *          FHE.mul(balance, units)     365,000   the accrual
     *          FHE.neg(accrued)            131,000   _update, depth   496,000
     *          FHE.select(isAdd, ...)       55,000   _update, depth   551,000
     *          FHE.add(node, signed)       162,000   _update, depth   713,000
     *
     *      `_accrue` also folds the accrued amount into the stake's own
     *      accumulator, which is a second 162,000 add -- but `_update` consumes
     *      the MULTIPLY's output, not the accumulator's. The two branches run
     *      in parallel off the same multiply, so the accumulator add never
     *      lands on the critical path.
     *
     *      The transfer is not in the chain either: `confidentialTransferFrom`
     *      settles the asset's own ciphertexts, which nothing here depends on
     *      until `_setBalance`, and that is a storage write, not an operation.
     *
     *      Measured on the register at 2^8: 713,000 depth, 2,757,064 global.
     *      test/Pool.t.ts prints both on every run.
     *
     *      ORDER MATTERS. The accrual runs BEFORE the balance changes, so the
     *      time just elapsed is weighted against the OLD balance. Accruing
     *      afterwards would credit the incoming money for time it was not in
     *      the pool, which is precisely the snipe the TWAB exists to prevent.
     *
     *      A SHORT COMMIT IS ALREADY SAFE. `transferred` is what the asset
     *      actually moved, not what the caller asked for. ERC-7984 returns zero
     *      rather than reverting when the sender is short, so an over-commit
     *      credits zero and costs the caller nothing but gas. No revert, no
     *      comparison to leak.
     */
    function commit(externalEuint64 amount, bytes calldata inputProof) external {
        euint64 requested = FHE.fromExternal(amount, inputProof);

        uint256 leaf = _leafFor(msg.sender);
        _startClock(msg.sender);

        // Weight the time already served against the balance that served it,
        // before that balance moves.
        euint64 accruedWeight = _accrue(msg.sender);
        _update(leaf, accruedWeight, FHE.asEbool(true));

        // The asset needs read access to the handle for the duration of the
        // call only. Transient, not persistent: nothing should hold a standing
        // grant on a user's amount.
        FHE.allowTransient(requested, address(asset));
        euint64 transferred = asset.confidentialTransferFrom(msg.sender, address(this), requested);

        euint64 balance = confidentialBalanceOf(msg.sender);
        _setBalance(
            msg.sender,
            FHE.isInitialized(balance) ? FHE.add(balance, transferred) : transferred
        );

        emit Committed(msg.sender, leaf);
    }

    // ---------------------------------------------------------------------
    // Release
    // ---------------------------------------------------------------------

    /**
     * @notice Release funds from the pool back to the caller.
     *
     * @dev WORST-CASE HCU DEPTH: 713,000 measured (14.3% of the 5,000,000
     *      budget), constant in the size of the register.
     *
     *      Identical to `commit`, and not by coincidence. The critical path is
     *      the accrual feeding `_update`, exactly as it is on the commit side.
     *      `tryDecrease` and the payout select hang off the caller's balance
     *      and the freshly verified input, neither of which depends on the
     *      accrual, so that whole branch runs in parallel and never lengthens
     *      the chain.
     *
     *      Measured on the register at 2^8: 713,000 depth, 3,181,096 global.
     *      The extra global over `commit` is the tryDecrease branch; the depth
     *      is unchanged. test/Pool.t.ts prints both on every run and asserts
     *      that a refused release matches an honoured one on both numbers.
     *
     *      WHY THIS DOES NOT REVERT ON AN OVER-WITHDRAWAL
     *      ----------------------------------------------
     *      The obvious implementation compares the requested amount against the
     *      balance and reverts if it is too large. That comparison is on
     *      ciphertext, so the only way to act on it in Solidity is to decrypt
     *      it, and the revert itself then publishes the answer: a transaction
     *      that reverts on `release(X)` proves the caller's balance is below X,
     *      and one that succeeds proves it is at or above X. An attacker
     *      spends gas on a binary search and reads the balance out of the
     *      revert pattern in about 64 transactions. The balance is the one
     *      thing this protocol exists to hide, so the failure mode has to be
     *      indistinguishable from the success mode.
     *
     *      `FHESafeMath.trySub` returns an ENCRYPTED success flag alongside the
     *      updated value, and leaves the value untouched when the subtraction
     *      would underflow. The payout is then `select(success, requested, 0)`.
     *      An over-withdrawal transfers zero, writes back the balance
     *      unchanged, emits the same event, and costs the same gas as a
     *      successful release. Nothing separates the two from outside, and the
     *      caller learns which happened by decrypting their own balance --
     *      which only they can do.
     *
     *      The same reasoning is why the accrual and the register update run
     *      unconditionally. Skipping them on a failed release would make the
     *      failure visible in the transaction's shape.
     */
    function release(externalEuint64 amount, bytes calldata inputProof) external {
        euint64 requested = FHE.fromExternal(amount, inputProof);

        uint256 leaf = _leafFor(msg.sender);
        _startClock(msg.sender);

        // Time served is earned whether or not the release succeeds.
        euint64 accruedWeight = _accrue(msg.sender);
        _update(leaf, accruedWeight, FHE.asEbool(true));

        // Encrypted success flag, no revert. `updated` equals the OLD balance
        // when the subtraction would have underflowed.
        //
        // tryDecrease, not trySub. Both return an encrypted success flag, but
        // trySub returns ZERO on failure while tryDecrease returns the value
        // untouched. Using trySub here would wipe a stake to nothing the first
        // time someone fat-fingered a release -- an encrypted no-op has to be a
        // no-op, not a silent liquidation.
        (ebool success, euint64 updated) = FHESafeMath.tryDecrease(
            confidentialBalanceOf(msg.sender),
            requested
        );

        // Pay out what was actually deducted: the request on success, zero on
        // failure. The transfer runs either way.
        euint64 payout = FHE.select(success, requested, FHE.asEuint64(0));

        _setBalance(msg.sender, updated);

        FHE.allowTransient(payout, address(asset));
        asset.confidentialTransfer(msg.sender, payout);

        emit Released(msg.sender, leaf);
    }
}
