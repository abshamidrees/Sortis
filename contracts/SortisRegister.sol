// SPDX-License-Identifier: BSD-3-Clause-Clear
pragma solidity ^0.8.27;

import {FHE, euint64, euint16, ebool} from "@fhevm/solidity/lib/FHE.sol";
import {ZamaEthereumConfig} from "@fhevm/solidity/config/ZamaConfig.sol";

/**
 * @title  SortisRegister
 * @notice The encrypted weight register. An implicit segment tree whose nodes
 *         hold time-weighted stake, exact at any moment, with no accrual pass.
 *
 * @dev ---------------------------------------------------------------------
 *      THE LINE, AND WHY THERE ARE TWO TREES
 *      ---------------------------------------------------------------------
 *      A stake's weight is how much money sat in the pool and for how long.
 *      The obvious way to track that is to accrue `balance * elapsed` into an
 *      accumulator every time the balance changes. That is what this contract
 *      used to do, and it was wrong in a way that mattered: weight only moved
 *      when the stake was touched, so a depositor who committed once and left
 *      the position alone carried the weight they had at their last balance
 *      change. Which, for a stake that has never changed since it opened, is
 *      zero. Safe against sniping, and useless to an honest saver.
 *
 *      The fix is to stop storing a point and start storing a line. Weight
 *      over time is piecewise linear, so write it as one:
 *
 *          weight(T) = intercept + slope * T
 *
 *      When a balance changes by delta at time t, the line the stake follows
 *      changes by exactly:
 *
 *          slope     += delta
 *          intercept -= delta * t
 *
 *      Check it. A stake that commits X at t0 has slope X and intercept
 *      -X*t0, so weight(T) = X * (T - t0). X held for T minus t0. Release Y at
 *      t1 and the slope becomes X-Y and the intercept -X*t0 + Y*t1, so
 *      weight(T) = X*(T-t0) - Y*(T-t1), which is the same money-seconds. The
 *      identity holds for any sequence of changes.
 *
 *      Both terms are additive over a subtree, so a segment tree of intercepts
 *      and a segment tree of slopes gives the exact time-weighted total of any
 *      subtree at any T, for one scalar multiply and one add. Nothing is ever
 *      stale, no keeper has to poke anything, and a stake that has not been
 *      touched in a year is worth exactly what a year of sitting there earns.
 *
 *      The cost is that the walk now reads two values per level instead of
 *      one, which doubles the part of the draw that was already the expensive
 *      part. See the note above `_walk`.
 *
 *      ---------------------------------------------------------------------
 *      TIME IS COUNTED IN WHOLE HOURS SINCE DEPLOYMENT
 *      ---------------------------------------------------------------------
 *      `slope * T` has to fit in a euint64. With T as a unix timestamp in
 *      seconds it does not: a $10M pool of a 6-decimal token is 1e13 base
 *      units, and 1e13 * 1.8e9 is 1.8e22 against a ceiling of 1.8e19.
 *
 *      T is therefore whole hours since this contract was deployed. A decade
 *      is 87,600 of them, so the same pool reaches 8.8e17 and keeps a factor
 *      of twenty in hand. Hourly granularity is also the anti-snipe property
 *      doing its job: a stake committed minutes before a draw has been in the
 *      pool for zero whole hours and is worth zero.
 *
 *      ---------------------------------------------------------------------
 *      LAYOUT
 *      ---------------------------------------------------------------------
 *      Both trees are 1-indexed heaps:
 *
 *          node 1                    = root
 *          children of j             = 2j (left) and 2j+1 (right)
 *          leaf i in [0, 2^DEPTH)    = node (2^DEPTH + i)
 *
 *      Mappings rather than arrays: a dynamic array of 2^17 entries would have
 *      to be sized in the constructor, which is a 131,072-iteration write loop
 *      and cannot be deployed.
 *
 *      ---------------------------------------------------------------------
 *      THE HCU BUDGET (see docs/BRIEF.md section 1)
 *      ---------------------------------------------------------------------
 *          global complexity  20,000,000 HCU   work that may run in parallel
 *          sequential depth    5,000,000 HCU   longest dependent chain
 *
 *      euint64 unit costs, from the HCUByOperator table in fhevm mock-utils:
 *
 *          FheAdd (ct, ct)       162,000       FheNeg           131,000
 *          FheSub (ct, ct)       162,000       FheIfThenElse     55,000
 *          FheMul (ct, scalar)   365,000       TrivialEncrypt        32
 *          FheLt  (ct, ct)       146,000       FheRand           24,000
 *
 *      A linear scan over encrypted balances accumulates into one ciphertext,
 *      so the whole scan is a single chain of ciphertext additions and
 *      5,000,000 / 162,000 puts the wall at 30 depositors. That is what this
 *      design exists to walk around.
 *
 *      ---------------------------------------------------------------------
 *      WHY THE UPDATE PATH IS PARALLEL, NOT DEEP
 *      ---------------------------------------------------------------------
 *      Recomputing each parent from its children after writing a leaf makes
 *      every parent depend on the child written one step earlier: DEPTH+1 adds
 *      in a chain, 2,754,000 HCU of sequential depth at DEPTH 16.
 *
 *      Instead the sign is folded into the delta once and the same two
 *      ciphertexts are added to every node on the path. Each node depends only
 *      on its own previous value and on those deltas, so the writes are
 *      independent of each other and bill against the global budget rather
 *      than the depth budget. Depth becomes a short fixed chain whatever the
 *      height of the tree.
 */
contract SortisRegister is ZamaEthereumConfig {
    // ---------------------------------------------------------------------
    // Constants and storage
    // ---------------------------------------------------------------------

    /// @notice Largest tree height the register will accept.
    uint8 public constant MAX_DEPTH = 16;

    /// @notice Granularity of the time axis. See the overflow note above.
    uint48 public constant TIME_UNIT = 1 hours;

    /**
     * @notice Height of the tree. 2^DEPTH leaf slots.
     * @dev Immutable rather than constant so test/HCU.t.ts can measure the
     *      same compiled code at several register sizes. A test that measures
     *      a different contract than the one shipped proves nothing.
     */
    uint8 public immutable DEPTH;

    /// @notice Time zero for the weight line. Deployment.
    uint48 public immutable GENESIS;

    /// @dev Index of leaf 0. Leaf i lives at node (_LEAF_BASE + i).
    uint256 private immutable _LEAF_BASE;

    /// @dev Subtree sums of the intercept term. 1-indexed heap.
    mapping(uint256 => euint64) private _intercept;

    /// @dev Subtree sums of the slope term, which is just balance. 1-indexed.
    mapping(uint256 => euint64) private _slope;

    /// @dev Leaf index per owner, offset by one so zero means "no leaf yet".
    mapping(address => uint256) private _leafOf;

    /// @dev Leaves handed out. Plaintext: how many stakes exist is not secret.
    uint256 private _leafCount;

    /**
     * @dev One past the highest leaf index ever written.
     *
     *      Leaves are handed out from zero upward, so everything carrying
     *      weight lives in [0, _leafHighWater). The subtree covering that
     *      range is the only part `_walk` has to descend, which makes a draw
     *      cost O(stakes) rather than O(capacity).
     */
    uint256 private _leafHighWater;

    // ---------------------------------------------------------------------
    // Errors and events
    // ---------------------------------------------------------------------

    error DepthOutOfRange(uint8 depth);
    error LeafOutOfRange(uint256 leaf);
    error RegisterFull();
    error NoLeafAssigned(address owner);

    event LeafAssigned(address indexed owner, uint256 indexed leaf);

    // ---------------------------------------------------------------------
    // Constructor
    // ---------------------------------------------------------------------

    /**
     * @notice Build a register of height `depth`.
     * @dev WORST-CASE HCU DEPTH: 0. No FHE operation. The tree is not
     *      materialized; every node is an uninitialized handle that `_update`
     *      trivially encrypts to zero on first touch.
     */
    constructor(uint8 depth) {
        if (depth == 0 || depth > MAX_DEPTH) revert DepthOutOfRange(depth);
        DEPTH = depth;
        GENESIS = uint48(block.timestamp);
        _LEAF_BASE = 1 << depth;
    }

    // ---------------------------------------------------------------------
    // Time
    // ---------------------------------------------------------------------

    /**
     * @notice Whole hours since deployment. The T in intercept + slope * T.
     * @dev WORST-CASE HCU DEPTH: 0. Plaintext arithmetic. Public because the
     *      time axis is not a secret and a caller needs it to reproduce a
     *      weight off chain.
     */
    function timeUnitsNow() public view returns (uint64) {
        return uint64((uint48(block.timestamp) - GENESIS) / TIME_UNIT);
    }

    // ---------------------------------------------------------------------
    // Views
    // ---------------------------------------------------------------------

    /**
     * @notice Root of the intercept tree.
     * @dev WORST-CASE HCU DEPTH: 0. Returns a stored handle. Handles are
     *      content-derived, so this doubles as a fingerprint of the whole
     *      intercept tree and SortisDraw uses it that way.
     */
    function rootIntercept() public view returns (euint64) {
        return _intercept[1];
    }

    /**
     * @notice Root of the slope tree, which is the pool's total balance.
     * @dev WORST-CASE HCU DEPTH: 0. Returns a stored handle.
     */
    function rootSlope() public view returns (euint64) {
        return _slope[1];
    }

    /**
     * @notice Number of leaves this register can hold.
     * @dev WORST-CASE HCU DEPTH: 0. Plaintext arithmetic.
     */
    function capacity() public view returns (uint256) {
        return 1 << DEPTH;
    }

    /**
     * @notice Leaves assigned so far.
     * @dev WORST-CASE HCU DEPTH: 0. Plaintext read. Public on purpose: the
     *      size of the anonymity set is something a depositor should be able
     *      to check before relying on it.
     */
    function leafCount() public view returns (uint256) {
        return _leafCount;
    }

    /**
     * @notice One past the highest leaf index ever written.
     * @dev WORST-CASE HCU DEPTH: 0. Plaintext read.
     */
    function leafHighWater() public view returns (uint256) {
        return _leafHighWater;
    }

    /**
     * @notice Height of the subtree a draw actually has to descend.
     *
     * @dev WORST-CASE HCU DEPTH: 0. Plaintext arithmetic.
     *
     *      The smallest h with 2^h >= the leaves in use. Because leaves are
     *      allocated from zero upward, the subtree covering [0, 2^h) holds the
     *      entire weight of the register, so the walk can start there and skip
     *      DEPTH - h levels. The capacity a pool was deployed with is free
     *      until it is filled.
     */
    function activeHeight() public view returns (uint8) {
        uint256 inUse = _leafHighWater;
        if (inUse <= 1) return 0;

        uint8 height = 0;
        while ((uint256(1) << height) < inUse) height++;
        return height;
    }

    /**
     * @notice Leaf index assigned to `owner`.
     * @dev WORST-CASE HCU DEPTH: 0. Plaintext read.
     */
    function leafOf(address owner) public view returns (uint256) {
        uint256 slot = _leafOf[owner];
        if (slot == 0) revert NoLeafAssigned(owner);
        return slot - 1;
    }

    /**
     * @notice Whether `owner` holds a leaf.
     * @dev WORST-CASE HCU DEPTH: 0. Plaintext read.
     */
    function hasLeaf(address owner) public view returns (bool) {
        return _leafOf[owner] != 0;
    }

    // ---------------------------------------------------------------------
    // Internal: leaf allocation
    // ---------------------------------------------------------------------

    /**
     * @notice Assign `owner` the next free leaf, or return the one they hold.
     * @dev WORST-CASE HCU DEPTH: 0. Plaintext bookkeeping only, so a
     *      first-time commit pays no encrypted cost for setup.
     */
    function _leafFor(address owner) internal returns (uint256 leaf) {
        uint256 slot = _leafOf[owner];
        if (slot != 0) return slot - 1;

        if (_leafCount >= capacity()) revert RegisterFull();
        leaf = _leafCount;
        _leafCount = leaf + 1;
        _leafOf[owner] = leaf + 1;
        emit LeafAssigned(owner, leaf);
    }

    // ---------------------------------------------------------------------
    // Internal: the update path
    // ---------------------------------------------------------------------

    /**
     * @notice Move the weight line at `leaf` by `delta`, in the direction
     *         `isAdd`, without revealing which direction that was.
     *
     * @dev WORST-CASE HCU DEPTH: 713,000, CONSTANT IN DEPTH.
     *
     *          neg(delta)                     131,000  depth  131,000
     *          select(isAdd, delta, neg)       55,000  depth  186,000
     *          select(isAdd, neg, delta)       55,000  depth  186,000, parallel
     *          mul(negSigned, t)              365,000  depth  551,000
     *          add(_intercept[j], .)          162,000  depth  713,000
     *          add(_slope[j], signed)         162,000  depth  348,000, parallel
     *
     *      The two selects run off the same negation, and the slope branch
     *      never touches the intercept branch, so the chain is the intercept
     *      side alone. Every node on the path adds the SAME two ciphertexts,
     *      so the 2*(DEPTH+1) writes are independent of each other and bill
     *      against the global budget rather than the depth budget.
     *
     *      WORST-CASE GLOBAL HCU: 606,000 + (DEPTH + 1) * 324,000, plus a
     *      32 HCU trivial encrypt per cold slot.
     *
     *          DEPTH  4   2,226,000   (11.1% of 20,000,000)
     *          DEPTH  8   3,522,000   (17.6%)
     *          DEPTH 12   4,818,000   (24.1%)
     *          DEPTH 16   6,114,000   (30.6%)
     *
     *      SIGN HANDLING. There is no signed euint. `FHE.neg` is the wrapping
     *      two's-complement negation, and euint64 addition wraps, so adding a
     *      negation is exact modular subtraction. The intercept term is
     *      genuinely negative for a growing pool and lives in the top half of
     *      the range as a two's-complement value; `weightAt` adds slope * T
     *      back and the result comes out positive, which is why nothing here
     *      needs a bias.
     *
     *      PRIVACY. `isAdd` stays encrypted end to end. Solidity never
     *      branches on it. A commit and a release write the same node set with
     *      the same operation count and the same execution gas, so an observer
     *      learns that a leaf moved and nothing else.
     *
     * @param leaf   Leaf index in [0, 2^DEPTH).
     * @param delta  Encrypted magnitude of the balance change.
     * @param isAdd  Encrypted direction. True adds, false subtracts.
     */
    function _update(uint256 leaf, euint64 delta, ebool isAdd) internal {
        (euint64 signed, euint64 interceptDelta) = _signedDeltas(delta, isAdd);
        _updateWith(leaf, signed, interceptDelta);
    }

    /**
     * @notice Turn an encrypted magnitude and direction into the two deltas
     *         the weight line moves by.
     *
     * @dev WORST-CASE HCU DEPTH: 551,000.
     *
     *          neg(delta)                 131,000  depth 131,000
     *          select(isAdd, delta, neg)   55,000  depth 186,000
     *          select(isAdd, neg, delta)   55,000  depth 186,000, parallel
     *          mul(negSigned, t)          365,000  depth 551,000
     *
     *      Split out from `_update` so a caller that has to apply the same
     *      change in two places, which SortisPool does when it mirrors a stake
     *      into the TWAB, pays for the 365,000 multiply once rather than twice.
     */
    function _signedDeltas(
        euint64 delta,
        ebool isAdd
    ) internal returns (euint64 signed, euint64 interceptDelta) {
        euint64 negated = FHE.neg(delta);

        // The signed change, and its negation. Both hang off `negated`, so
        // they cost one operation of depth between them rather than two.
        signed = FHE.select(isAdd, delta, negated);
        euint64 negSigned = FHE.select(isAdd, negated, delta);

        // slope += delta, intercept -= delta * t. The multiplier is the
        // plaintext hour count, so this is the SCALAR overload at 365,000
        // rather than the ciphertext-ciphertext one at 596,000.
        interceptDelta = FHE.mul(negSigned, timeUnitsNow());
    }

    /**
     * @notice Apply precomputed deltas along the path from `leaf` to the root.
     * @dev WORST-CASE HCU DEPTH: 162,000 on top of its inputs, because every
     *      node on the path adds the same two ciphertexts and the writes are
     *      therefore independent of each other.
     */
    function _updateWith(uint256 leaf, euint64 signed, euint64 interceptDelta) internal {
        if (leaf >= capacity()) revert LeafOutOfRange(leaf);
        if (leaf >= _leafHighWater) _leafHighWater = leaf + 1;

        uint256 node = _LEAF_BASE + leaf;
        while (node != 0) {
            euint64 interceptNow = _intercept[node];
            euint64 slopeNow = _slope[node];

            // A cold slot holds handle 0, which is not a ciphertext.
            if (!FHE.isInitialized(interceptNow)) interceptNow = FHE.asEuint64(0);
            if (!FHE.isInitialized(slopeNow)) slopeNow = FHE.asEuint64(0);

            euint64 nextIntercept = FHE.add(interceptNow, interceptDelta);
            euint64 nextSlope = FHE.add(slopeNow, signed);

            _intercept[node] = nextIntercept;
            _slope[node] = nextSlope;

            // ACL grants are billed in gas, not HCU, and do not extend the
            // dependent chain.
            FHE.allowThis(nextIntercept);
            FHE.allowThis(nextSlope);

            node >>= 1;
        }
    }

    // ---------------------------------------------------------------------
    // Internal: reading a weight
    // ---------------------------------------------------------------------

    /**
     * @notice Time-weighted total held under `node`, evaluated at `t`.
     *
     * @dev WORST-CASE HCU DEPTH: 527,000 on top of its inputs.
     *
     *          mul(slope, t)   365,000   scalar, t is the plaintext hour count
     *          add(intercept)  162,000
     *
     *      Exact at any t, which is the whole point of storing a line. There
     *      is no accrual pass and nothing goes stale.
     */
    function _weightAt(uint256 node, uint64 t) internal returns (euint64) {
        euint64 intercept = _nodeOrZero(_intercept, node);
        euint64 slope = _nodeOrZero(_slope, node);
        return FHE.add(intercept, FHE.mul(slope, t));
    }

    /**
     * @notice Total encrypted weight of the register at `t`.
     * @dev WORST-CASE HCU DEPTH: 527,000. See `_weightAt`.
     */
    function _rootWeightAt(uint64 t) internal returns (euint64) {
        return _weightAt(1, t);
    }

    // ---------------------------------------------------------------------
    // Internal: the walk
    // ---------------------------------------------------------------------

    /**
     * @notice Resolve `lot` to a leaf, evaluating weights at `t`. The index
     *         comes back encrypted.
     *
     * @dev WORST-CASE HCU DEPTH: about 767,000 per level of `activeHeight()`.
     *
     *      GLOBAL HCU is the binding budget, not depth, and the term that
     *      dominates is the oblivious read. See below.
     *
     *      ---------------------------------------------------------------------
     *      THE GAP IN THE SPEC, AND WHAT IT COSTS
     *      ---------------------------------------------------------------------
     *      docs/BRIEF.md section 4 describes the walk as three encrypted
     *      operations per level: one `FHE.lt` against the left child's sum,
     *      one `FHE.select` to pick the branch, one `FHE.select` to subtract.
     *      Those three are here. What the spec does not say is where the left
     *      child's sum comes from.
     *
     *      Writing the descent the obvious way needs a plaintext node index:
     *
     *          uint256 node = 1;
     *          euint64 left = _slope[2 * node];        // needs plaintext node
     *          ebool goesLeft = FHE.lt(remaining, left);
     *          node = goesLeft ? 2 * node : 2 * node + 1;   // IMPOSSIBLE
     *
     *      That last line is the mistake the brief itself warns about, and
     *      deleting it does not help: without it the contract does not know
     *      which node it is standing on at the next level, so it cannot
     *      address the tree either. Keeping the index encrypted and reading
     *      storage at a plaintext index are the same requirement pulling in
     *      opposite directions.
     *
     *      The resolution is an oblivious read: at level k the descent could
     *      be on any of 2^k nodes, so the contract loads every candidate and
     *      collapses them with a reduction driven by the branch bits it has
     *      already decided. Correct, never branches on a ciphertext, and the
     *      leaf index it produces is genuinely encrypted.
     *
     *      It is also Omega(N), and that is not an artifact of this code. A
     *      computation that hides which leaf it chose has to touch every leaf
     *      it could have chosen: if some node were never read, an observer
     *      would know the answer is not under it. Two trees means two reads
     *      per level.
     *
     *      ---------------------------------------------------------------------
     *      WHAT BINDS, AND WHY IT IS DEPTH
     *      ---------------------------------------------------------------------
     *      Measured by test/HCU.t.ts, sweeping until the transaction reverts:
     *
     *          stakes    seq depth    of 5,000,000    global    of 20,000,000
     *              16    3,098,000          62.0%     5,269,896     26.4%
     *              32    3,826,000          76.5%     7,958,888     39.8%
     *              64    4,647,000          92.9%    12,408,904     62.0%
     *             128      reverts             -             -          -
     *
     *      DEPTH is the binding budget, at about 774,500 HCU per level, and
     *      that is a change from the single-tree version, which was stopped by
     *      the global budget. The reason is the weight line: turning a node's
     *      intercept and slope into a weight costs a scalar multiply and an add
     *      ON THE CRITICAL PATH at every level, 527,000 of the 774,500.
     *
     *      The distinction matters. Too much WORK can be split across
     *      checkpointed transactions. A chain that is too LONG cannot. So 64
     *      stakes is a hard ceiling on a single-transaction winner-hiding
     *      draw, and it is what the sharded design is built around: many small
     *      registers that each draw in one transaction, rather than one large
     *      register that cannot.
     *
     *      Getting back above 64 means getting the per-level multiply off the
     *      critical path. The way to do it is to store weight at a scheduled
     *      reference hour instead of a line, and rebase every node between
     *      draws in checkpointed transactions. That is a real option and it is
     *      deliberately not taken here: it trades a hard ceiling for an
     *      operational one, and the sharded design does not need it.
     *
     * @param lot Encrypted draw value, expected in [0, total weight at t).
     * @param t   Hour count the weights are evaluated at. Must be the same t
     *            the total was computed with, or the walk is drawing against
     *            a different tree than the one that was committed.
     */
    function _walk(euint64 lot, uint64 t) internal returns (euint16 leafIndex) {
        uint8 height = activeHeight();

        // An empty register, or a single leaf that must be the answer.
        if (height == 0) {
            leafIndex = FHE.asEuint16(0);
            FHE.allowThis(leafIndex);
            return leafIndex;
        }

        uint256 subtreeRoot = uint256(1) << (DEPTH - height);

        // Branch decisions, most significant first. These stay ebool for the
        // entire descent; nothing here is decrypted or branched on.
        ebool[] memory goesLeft = new ebool[](height);

        euint64 remaining = lot;

        for (uint256 level = 0; level < height; level++) {
            // The current node's left child, resolved without knowing which
            // node the current node is. This is the expensive part.
            euint64 leftIntercept = _obliviousLeftChild(_intercept, subtreeRoot, level, goesLeft);
            euint64 leftSlope = _obliviousLeftChild(_slope, subtreeRoot, level, goesLeft);
            euint64 leftWeight = FHE.add(leftIntercept, FHE.mul(leftSlope, t));

            // ONE FHE.lt per level. The lot falls in the left subtree exactly
            // when what remains of it is smaller than that subtree's total.
            goesLeft[level] = FHE.lt(remaining, leftWeight);

            // ONE FHE.select per level, to subtract when going right. The
            // subtraction is computed unconditionally and discarded by the
            // select if we went left. Computing only the taken side would
            // require knowing which side was taken.
            remaining = FHE.select(goesLeft[level], remaining, FHE.sub(remaining, leftWeight));
        }

        // ONE FHE.select per level, to fold each branch bit into the index.
        leafIndex = _packLeafIndex(goesLeft);
        FHE.allowThis(leafIndex);
    }

    /**
     * @notice The left-child value of the level-`level` node the descent is
     *         standing on, without learning which node that is.
     *
     * @dev WORST-CASE HCU DEPTH: `level` * 55,000 on top of the most recent
     *      branch bit. WORST-CASE GLOBAL HCU: (2^level - 1) * 55,000.
     *
     *      At level k the descent could be on any of the 2^k nodes at that
     *      level, whose left children are the even-indexed nodes one level
     *      down. The contract loads all of them and folds the array in half
     *      once per branch bit already decided, OLDEST BIT FIRST.
     *
     *      Oldest first is deliberate. Every fold is one select, so the array
     *      collapses in `level` steps whatever the order, but the newest bit
     *      was produced a moment ago and sits at the deepest point of the
     *      chain while the oldest has been available since the first
     *      comparison. Consuming the old ones first lets those folds run while
     *      the chain is still shallow, so only the final fold extends the
     *      critical path. Newest first would stack every fold on the newest
     *      bit and turn a 55,000 tail into `level` * 55,000.
     */
    function _obliviousLeftChild(
        mapping(uint256 => euint64) storage tree,
        uint256 subtreeRoot,
        uint256 level,
        ebool[] memory goesLeft
    ) private returns (euint64) {
        uint256 width = uint256(1) << level;
        // Left children of this level's nodes, relative to the subtree root.
        uint256 base = subtreeRoot << (level + 1);

        euint64[] memory candidates = new euint64[](width);
        for (uint256 j = 0; j < width; j++) {
            candidates[j] = _nodeOrZero(tree, base + 2 * j);
        }

        for (uint256 i = 0; i < level; i++) {
            width >>= 1;
            for (uint256 s = 0; s < width; s++) {
                // Left keeps the lower half: a left branch contributes a 0 bit.
                candidates[s] = FHE.select(goesLeft[i], candidates[s], candidates[s + width]);
            }
        }

        return candidates[0];
    }

    /**
     * @notice Assemble the encrypted leaf index from the per-level branch bits.
     *
     * @dev WORST-CASE HCU DEPTH: 55,000 for the bit plus ceil(log2(levels)) *
     *      93,000 for the reduction. WORST-CASE GLOBAL HCU: levels * 55,000 +
     *      (levels - 1) * 93,000.
     *
     *      A right branch at level k contributes 2^(levels-1-k), a left branch
     *      nothing. The contributions are mutually independent, so they cost
     *      depth once rather than once each, and they are summed as a balanced
     *      tree rather than a running total: a running total would chain the
     *      adds and cost levels * 93,000 of depth instead of log2 of that.
     *      The bits are disjoint, so addition is exact. This is a bitwise OR
     *      written as a sum because addition reduces more cheaply.
     */
    function _packLeafIndex(ebool[] memory goesLeft) private returns (euint16) {
        uint256 levels = goesLeft.length;
        euint16[] memory parts = new euint16[](levels);
        euint16 zero = FHE.asEuint16(0);

        for (uint256 k = 0; k < levels; k++) {
            euint16 weight = FHE.asEuint16(uint16(1 << (levels - 1 - k)));
            parts[k] = FHE.select(goesLeft[k], zero, weight);
        }

        uint256 n = levels;
        while (n > 1) {
            uint256 half = (n + 1) >> 1;
            for (uint256 s = 0; s + half < n; s++) {
                parts[s] = FHE.add(parts[s], parts[s + half]);
            }
            n = half;
        }

        return parts[0];
    }

    /**
     * @notice A node's value, substituting a trivial zero for a cold slot.
     * @dev WORST-CASE HCU DEPTH: 32, one TrivialEncrypt, and only when the
     *      slot has never been written. A warm node costs nothing.
     */
    function _nodeOrZero(
        mapping(uint256 => euint64) storage tree,
        uint256 node
    ) private returns (euint64) {
        euint64 value = tree[node];
        return FHE.isInitialized(value) ? value : FHE.asEuint64(0);
    }

    /**
     * @notice Grant `account` the right to decrypt both tree roots.
     * @dev WORST-CASE HCU DEPTH: 0. ACL grants are not coprocessor operations.
     */
    function _allowRoots(address account) internal {
        FHE.allow(_intercept[1], account);
        FHE.allow(_slope[1], account);
    }
}
