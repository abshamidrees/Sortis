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
 *      The pool inherits the register and the stake ledger rather than calling
 *      them across contract boundaries. `_updateWith` and `_applyToStake` are
 *      internal by design, and keeping them at one address means the
 *      ciphertext handles they pass around never need cross-contract ACL
 *      grants. Three files, three concerns, one deployed address.
 *
 *      ---------------------------------------------------------------------
 *      ONE CHANGE, APPLIED TWICE
 *      ---------------------------------------------------------------------
 *      A balance change moves a stake's weight line by two deltas: the slope
 *      by the signed amount, the intercept by minus that amount times the
 *      current hour. Both the register and the stake's own copy move by
 *      exactly those numbers, so they are computed ONCE by `_signedDeltas`
 *      and handed to both. Recomputing them per destination would pay the
 *      365,000 scalar multiply twice for no reason, and would risk the two
 *      copies disagreeing if a block timestamp straddled an hour boundary
 *      between the two calls.
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
 *      guarantee is that the two are indistinguishable INSIDE the register:
 *      same node set, same operation count, same execution gas. SortisWrapQueue
 *      is where the link between a public address and a confidential stake
 *      gets attacked.
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
    // Events and errors
    // ---------------------------------------------------------------------

    /**
     * @dev Deliberately carries no amount, not even a ciphertext handle. An
     *      indexed handle would be a stable identifier an observer could
     *      correlate across transactions.
     */
    event Committed(address indexed owner, uint256 indexed leaf);
    event Released(address indexed owner, uint256 indexed leaf);
    event DrawContractSet(address indexed drawContract);
    event WrapQueueSet(address indexed wrapQueue);

    error AssetNotSet();
    error NotOwner();
    error NotDrawContract();
    error NotWrapQueue();

    // ---------------------------------------------------------------------
    // Constructor
    // ---------------------------------------------------------------------

    /**
     * @notice Deploy a pool over `confidentialAsset` with a register of height
     *         `depth`.
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
     * @dev WORST-CASE HCU DEPTH: 0. Plaintext write. The draw is a separate
     *      contract, but the walk is internal, so the pool has to hand it a
     *      door. This is that door and it is the only one.
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
    // Views
    // ---------------------------------------------------------------------

    /**
     * @notice The caller's stake as a ciphertext handle.
     * @dev WORST-CASE HCU DEPTH: 0. Returns a stored handle. The frontend
     *      decrypts this client-side; the grant that makes that possible is
     *      issued in `_applyToStake` and is scoped to the owner alone.
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
     * @dev WORST-CASE HCU DEPTH: 713,000, constant in the size of the
     *      register.
     *
     *          neg(transferred)           131,000  depth 131,000
     *          two selects on isAdd        55,000  depth 186,000, parallel
     *          mul(negSigned, hour)       365,000  depth 551,000
     *          add into intercept         162,000  depth 713,000
     *
     *      The register writes and the stake writes hang off the same two
     *      deltas, so they are parallel branches rather than a longer chain.
     *      The transfer is not in the chain at all: it settles the asset's own
     *      ciphertexts, which nothing here reads.
     *
     *      NO ACCRUAL STEP. The previous implementation folded elapsed time
     *      into an accumulator before applying the change, and had to, because
     *      weight was stored as a point. Weight is a line now, so a commit only
     *      has to move the line. Time is handled by the line itself, which is
     *      why a stake that is never touched again is still worth exactly what
     *      sitting there earns.
     *
     *      A SHORT COMMIT IS ALREADY SAFE. `transferred` is what the asset
     *      actually moved, not what the caller asked for. ERC-7984 returns zero
     *      rather than reverting when the sender is short, so an over-commit
     *      credits zero and costs the caller nothing but gas. No revert, and
     *      no comparison to leak.
     */
    function commit(externalEuint64 amount, bytes calldata inputProof) external {
        euint64 requested = FHE.fromExternal(amount, inputProof);

        uint256 leaf = _leafFor(msg.sender);

        // The asset needs read access for the duration of the call only.
        // Transient, not persistent: nothing should hold a standing grant on
        // a user's amount.
        FHE.allowTransient(requested, address(asset));
        euint64 transferred = asset.confidentialTransferFrom(msg.sender, address(this), requested);

        (euint64 signed, euint64 interceptDelta) = _signedDeltas(transferred, FHE.asEbool(true));
        _updateWith(leaf, signed, interceptDelta);
        _applyToStake(msg.sender, signed, interceptDelta);

        emit Committed(msg.sender, leaf);
    }

    // ---------------------------------------------------------------------
    // Release
    // ---------------------------------------------------------------------

    /**
     * @notice Release funds from the pool back to the caller.
     *
     * @dev WORST-CASE HCU DEPTH: 985,000, constant in the size of the
     *      register.
     *
     *          tryDecrease                217,000  ge and sub in parallel,
     *                                              then one select
     *          select on the payout        55,000  depth 272,000
     *          neg(payout)                131,000  depth 403,000
     *          two selects on isAdd        55,000  depth 458,000
     *          mul(negSigned, hour)       365,000  depth 823,000
     *          add into intercept         162,000  depth 985,000
     *
     *      WHY THIS DOES NOT REVERT ON AN OVER-WITHDRAWAL
     *      ----------------------------------------------
     *      The obvious implementation compares the requested amount against
     *      the balance and reverts if it is too large. That comparison is on
     *      ciphertext, so acting on it in Solidity means decrypting it, and
     *      the revert then publishes the answer: a transaction that reverts on
     *      `release(X)` proves the caller's balance is below X, and one that
     *      succeeds proves it is at or above X. An attacker spends gas on a
     *      binary search and reads any balance out of the revert pattern in
     *      about sixty-four transactions. The balance is the one thing this
     *      protocol exists to hide, so the failure mode has to be
     *      indistinguishable from the success mode.
     *
     *      `FHESafeMath.tryDecrease` returns an ENCRYPTED success flag and
     *      leaves the value untouched when the subtraction would underflow.
     *      tryDecrease and not trySub: both return a flag, but trySub returns
     *      ZERO on failure, which would wipe a stake to nothing the first time
     *      someone fat-fingered a release. An encrypted no-op has to be a
     *      no-op, not a silent liquidation.
     *
     *      The payout is `select(success, requested, 0)`, which is also the
     *      amount the weight line moves by, so the stake and the register
     *      cannot disagree about what happened. An over-withdrawal transfers
     *      zero, moves the line by zero, emits the same event, and costs the
     *      same gas as an honoured release.
     *
     *      The register update runs unconditionally for the same reason.
     *      Skipping it on a refused release would make the refusal visible in
     *      the shape of the transaction.
     */
    function release(externalEuint64 amount, bytes calldata inputProof) external {
        euint64 requested = FHE.fromExternal(amount, inputProof);

        uint256 leaf = _leafFor(msg.sender);

        // Encrypted success flag, no revert. The updated balance it also
        // returns is not used: adding the signed payout to the stake reaches
        // the same value, and doing it that way keeps the stake and the
        // register moving by one number rather than two.
        (ebool success, ) = FHESafeMath.tryDecrease(confidentialBalanceOf(msg.sender), requested);

        euint64 payout = FHE.select(success, requested, FHE.asEuint64(0));

        (euint64 signed, euint64 interceptDelta) = _signedDeltas(payout, FHE.asEbool(false));
        _updateWith(leaf, signed, interceptDelta);
        _applyToStake(msg.sender, signed, interceptDelta);

        FHE.allowTransient(payout, address(asset));
        asset.confidentialTransfer(msg.sender, payout);

        emit Released(msg.sender, leaf);
    }

    // ---------------------------------------------------------------------
    // Privileged peers
    // ---------------------------------------------------------------------

    /**
     * @notice Resolve `lot` to an encrypted leaf index, with weights evaluated
     *         at hour `t`. Draw contract only.
     *
     * @dev WORST-CASE HCU DEPTH: see `_walk`. About 774,500 per level of
     *      `activeHeight()`, and DEPTH is the binding budget: measured, a
     *      shard resolves up to 64 stakes and reverts at 128. A chain that is
     *      too long cannot be checkpointed, so that ceiling is hard.
     *
     *      `t` is passed in rather than read from the clock so the walk
     *      evaluates the tree at exactly the hour the draw committed to. A
     *      walk that re-read the clock could cross an hour boundary between
     *      the two draw transactions and resolve against a different set of
     *      weights than the total that was published.
     *
     *      The resolved index is granted persistently rather than transiently,
     *      because SortisDraw stores it and settles claims in later
     *      transactions. A transient grant would expire before the winner
     *      could claim.
     */
    function walkForDraw(euint64 lot, uint64 t) external returns (euint16 leafIndex) {
        if (msg.sender != drawContract) revert NotDrawContract();
        leafIndex = _walk(lot, t);
        FHE.allow(leafIndex, msg.sender);
    }

    /**
     * @notice Publish the register's total weight at hour `t` and grant the
     *         root handles to the draw. Draw contract only.
     *
     * @dev WORST-CASE HCU DEPTH: 527,000, one scalar multiply and one add.
     *
     *      The total weight becomes publicly decryptable, deliberately. The
     *      lot has to land uniformly in [0, total), and every reduction FHEVM
     *      offers takes a plaintext bound, so the denominator has to be a
     *      number the chain can see. It is an aggregate over every stake and
     *      says nothing about any one of them, and a draw whose denominator
     *      nobody can check is not publicly verifiable, which is the property
     *      the bounty asks for.
     */
    function publishRootForDraw(uint64 t) external returns (euint64 weight) {
        if (msg.sender != drawContract) revert NotDrawContract();

        weight = _rootWeightAt(t);
        FHE.allowThis(weight);
        FHE.allow(weight, msg.sender);
        FHE.makePubliclyDecryptable(weight);

        _allowRoots(msg.sender);
    }

    /**
     * @notice Credit a stake without pulling a transfer. Wrap queue only.
     *
     * @dev WORST-CASE HCU DEPTH: 713,000, the same chain as `commit`.
     *
     *      The queue has already taken public USDT and wrapped it, so the
     *      funds are in hand and there is nothing to pull. Everything else is
     *      identical to a direct commit, which is what makes a queued stake
     *      indistinguishable from a walk-in one once it lands.
     */
    function creditFromQueue(address stakeOwner, euint64 amount) external {
        if (msg.sender != wrapQueue) revert NotWrapQueue();

        uint256 leaf = _leafFor(stakeOwner);

        (euint64 signed, euint64 interceptDelta) = _signedDeltas(amount, FHE.asEbool(true));
        _updateWith(leaf, signed, interceptDelta);
        _applyToStake(stakeOwner, signed, interceptDelta);

        emit Committed(stakeOwner, leaf);
    }
}
