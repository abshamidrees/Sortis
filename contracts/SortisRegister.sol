// SPDX-License-Identifier: BSD-3-Clause-Clear
pragma solidity ^0.8.27;

import {FHE, euint64, euint16, ebool} from "@fhevm/solidity/lib/FHE.sol";
import {ZamaEthereumConfig} from "@fhevm/solidity/config/ZamaConfig.sol";

/**
 * @title  SortisRegister
 * @notice The encrypted weight register. An implicit segment tree whose nodes are
 *         `euint64` sums of time-weighted stake. A commit or release updates one
 *         path; a draw walks it root to leaf, one encrypted comparison per level.
 *
 *         Read the note above `_walk` before quoting an O(log N) draw. The
 *         comparisons are O(log N), but resolving which node to compare against
 *         without decrypting the path costs O(N), and that is a property of
 *         hiding the winner rather than of this implementation.
 *
 * @dev ---------------------------------------------------------------------
 *      LAYOUT
 *      ---------------------------------------------------------------------
 *      `_nodes` is a 1-indexed heap:
 *
 *          node 1                    = root, the total encrypted weight
 *          children of j             = 2j (left) and 2j+1 (right)
 *          leaf i in [0, 2^DEPTH)    = node (2^DEPTH + i)
 *          logical size              = 2^DEPTH * 2 slots
 *
 *      The brief calls this a "Fenwick/segment tree". It is built in the segment
 *      tree (heap) layout deliberately: a Fenwick tree supports prefix sums and
 *      point updates but has no root-to-leaf descent, and the descent is the
 *      whole point. `_walk` needs to read a node's LEFT CHILD sum at every level
 *      to decide a branch, and only the heap layout has that node addressable.
 *
 *      `_nodes` is a mapping, not the `euint64[]` the brief sketches. A dynamic
 *      array of 2^17 entries would have to be sized in the constructor, which is
 *      a 131,072-iteration write loop and cannot be deployed. The mapping has
 *      identical indexing semantics and materializes slots lazily.
 *
 *      ---------------------------------------------------------------------
 *      THE HCU BUDGET (see docs/BRIEF.md section 1)
 *      ---------------------------------------------------------------------
 *      FHEVM enforces two per-transaction limits:
 *
 *          global complexity  20,000,000 HCU   (work that may run in parallel)
 *          sequential depth    5,000,000 HCU   (longest dependent chain)
 *
 *      euint64 unit costs, from the coprocessor's own table
 *      (the HCUByOperator table in fhevm mock-utils):
 *
 *          FheAdd  (ct, ct)      162,000        FheNeg          131,000
 *          FheAdd  (ct, scalar)  133,000        FheIfThenElse    55,000
 *          FheSub  (ct, ct)      162,000        TrivialEncrypt       32
 *          FheLt   (ct, ct)      146,000        FheRand          24,000
 *
 *      The naive competitor to this contract scans depositors and accumulates:
 *      N dependent adds, one per depositor, so the whole scan is one chain.
 *      The accumulator and the balance are both ciphertext, which is the
 *      162,000 add, and 5,000,000 / 162,000 puts the wall at 30 depositors.
 *      Even the friendlier scalar add at 133,000 -- which a scan cannot
 *      actually use, since the balances are encrypted -- only reaches 37.
 *      That is the wall Sortis is built to walk around, and test/HCU.t.ts
 *      prints the exact figure next to the measured cost of this contract.
 *
 *      ---------------------------------------------------------------------
 *      WHY THE UPDATE PATH IS PARALLEL, NOT DEEP
 *      ---------------------------------------------------------------------
 *      The obvious way to maintain a segment tree is to recompute each parent
 *      from its children after writing the leaf:
 *
 *          _nodes[j] = FHE.add(_nodes[2j], _nodes[2j+1]);   // WRONG here
 *
 *      Every parent then depends on the child written one step earlier, so the
 *      path is a dependent chain: DEPTH+1 adds = 17 * 162,000 = 2,754,000 HCU
 *      of *sequential depth*, 55% of the budget, and it stops scaling around
 *      DEPTH 30.
 *
 *      Sortis instead folds the sign into the delta once and adds that single
 *      ciphertext to every node on the path:
 *
 *          signed    = select(isAdd, delta, neg(delta))     // computed ONCE
 *          _nodes[j] = add(_nodes[j], signed)               // for each j
 *
 *      Each node's new value depends only on its own previous value and on
 *      `signed`. The DEPTH+1 adds do not depend on each other, so they are
 *      parallel work: they bill against the 20M global budget, not the 5M
 *      depth budget. Sequential depth becomes a constant three operations
 *      (neg, select, add) = 348,000 HCU, independent of DEPTH.
 *
 *      That is the whole trick, and it is section 1 point 3 of the brief taken
 *      literally: two independent chains cost nothing against depth that one
 *      long chain does.
 */
contract SortisRegister is ZamaEthereumConfig {
    // ---------------------------------------------------------------------
    // Constants and storage
    // ---------------------------------------------------------------------

    /// @notice Largest tree height the register will accept. 2^16 = 65,536 stakes.
    uint8 public constant MAX_DEPTH = 16;

    /**
     * @notice Height of the tree. 2^DEPTH leaves, one per stake.
     * @dev Production deploys at MAX_DEPTH (16). This is `immutable` rather than
     *      `constant` for exactly one reason: test/HCU.t.ts measures the *same*
     *      compiled code path at register sizes 2^4, 2^8, 2^12 and 2^16, and a
     *      test that measures a different contract than the one shipped proves
     *      nothing. Nothing outside the constructor can change it.
     */
    uint8 public immutable DEPTH;

    /// @dev Index of leaf 0. Leaf i lives at node (_LEAF_BASE + i).
    uint256 private immutable _LEAF_BASE;

    /// @dev 1-indexed heap of encrypted subtree sums. Slot 0 is unused.
    mapping(uint256 => euint64) private _nodes;

    /// @dev Leaf index assigned to a stake owner, offset by one so that
    ///      zero means "no leaf yet" and leaf 0 stays usable.
    mapping(address => uint256) private _leafOf;

    /// @dev Number of leaves handed out so far. Plaintext: how many stakes exist
    ///      is not a secret, only what is in them.
    uint256 private _leafCount;

    /**
     * @dev One past the highest leaf index ever written by `_update`.
     *
     *      Leaves are handed out from zero upward, so every leaf carrying
     *      weight lives in [0, _leafHighWater). That makes the subtree covering
     *      [0, 2^h) for the smallest such h a complete container for the whole
     *      register, and it is the only part `_walk` has to descend. Tracking
     *      it costs one plaintext SSTORE on the rare update that extends the
     *      range and turns the walk's cost from O(capacity) into O(stakes).
     *
     *      Not a secret: `_update` writes a visible path of storage slots, so
     *      which leaves are in use is already public. See the note above
     *      `_walk`.
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
     * @dev WORST-CASE HCU DEPTH: 0. No FHE operation is performed. The tree is
     *      not materialized; every node is an uninitialized handle that `_update`
     *      trivially encrypts to zero on first touch (32 HCU, unmeasurable).
     *      Deployment gas is therefore flat in DEPTH.
     */
    constructor(uint8 depth) {
        if (depth == 0 || depth > MAX_DEPTH) revert DepthOutOfRange(depth);
        DEPTH = depth;
        _LEAF_BASE = 1 << depth;
    }

    // ---------------------------------------------------------------------
    // Views
    // ---------------------------------------------------------------------

    /**
     * @notice The encrypted total weight of the register.
     * @dev WORST-CASE HCU DEPTH: 0. Returns a stored handle; performs no FHE
     *      operation. A draw snapshots this before the lot exists, which is what
     *      makes the draw honest.
     *
     *      Returns an uninitialized handle while the register is empty. Callers
     *      that must tolerate an empty register should check FHE.isInitialized.
     */
    function root() public view returns (euint64) {
        return _nodes[1];
    }

    /**
     * @notice Number of leaves this register can hold.
     * @dev WORST-CASE HCU DEPTH: 0. Plaintext arithmetic only.
     */
    function capacity() public view returns (uint256) {
        return 1 << DEPTH;
    }

    /**
     * @notice Number of leaves assigned so far.
     * @dev WORST-CASE HCU DEPTH: 0. Plaintext read. Deliberately public: the
     *      size of the anonymity set is not a secret, and hiding it would be
     *      false comfort since leaf assignment emits an event anyway.
     */
    function leafCount() public view returns (uint256) {
        return _leafCount;
    }

    /**
     * @notice Height of the subtree a draw actually has to descend.
     *
     * @dev WORST-CASE HCU DEPTH: 0. Plaintext arithmetic.
     *
     *      The smallest h with 2^h >= the number of leaves in use. Because
     *      leaves are allocated from zero upward, the subtree covering
     *      [0, 2^h) holds the entire weight of the register, so `_walk` can
     *      start there instead of at the root and skip DEPTH - h levels
     *      entirely.
     *
     *      This is what makes a draw affordable on a production-sized register.
     *      The walk's global HCU is O(2^activeHeight), NOT O(2^DEPTH): a pool
     *      deployed at DEPTH 16 with 200 stakes descends a height-8 subtree and
     *      costs what a 2^8 register costs. The capacity you deployed with is
     *      free until you fill it.
     */
    function activeHeight() public view returns (uint8) {
        uint256 inUse = _leafHighWater;
        if (inUse <= 1) return 0;

        uint8 height = 0;
        while ((uint256(1) << height) < inUse) height++;
        return height;
    }

    /**
     * @notice One past the highest leaf index ever written.
     * @dev WORST-CASE HCU DEPTH: 0. Plaintext read.
     */
    function leafHighWater() public view returns (uint256) {
        return _leafHighWater;
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
     * @notice Whether `owner` already holds a leaf.
     * @dev WORST-CASE HCU DEPTH: 0. Plaintext read.
     */
    function hasLeaf(address owner) public view returns (bool) {
        return _leafOf[owner] != 0;
    }

    /**
     * @notice The encrypted subtree sum stored at heap index `node`.
     * @dev WORST-CASE HCU DEPTH: 0. Returns a stored handle. Exposed so that
     *      SortisDraw can read left-child sums during the walk and so tests can
     *      check tree invariants; reading a handle discloses nothing without an
     *      ACL grant.
     */
    function nodeAt(uint256 node) public view returns (euint64) {
        return _nodes[node];
    }

    // ---------------------------------------------------------------------
    // Internal: leaf allocation
    // ---------------------------------------------------------------------

    /**
     * @notice Assign `owner` the next free leaf, or return the one they hold.
     * @dev WORST-CASE HCU DEPTH: 0. Plaintext bookkeeping only. No FHE operation
     *      is performed, so a first-time commit pays no encrypted cost for setup.
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
     * @notice Add or subtract `delta` at `leaf` and repair every subtree sum
     *         above it, without revealing which of the two happened.
     *
     * @dev WORST-CASE HCU DEPTH: 348,000 (7.0% of the 5,000,000 budget),
     *      CONSTANT IN DEPTH.
     *
     *      The dependent chain is exactly three operations long, whatever the
     *      height of the tree:
     *
     *          neg(delta)                    131,000   depth 131,000
     *          select(isAdd, delta, neg)      55,000   depth 186,000
     *          add(_nodes[j], signed)        162,000   depth 348,000
     *
     *      The DEPTH+1 adds all sit at depth 348,000 rather than stacking,
     *      because each reads a different `_nodes[j]` and the same `signed`.
     *      They are independent, so the coprocessor may run them in parallel and
     *      they bill against the global budget instead.
     *
     *      WORST-CASE GLOBAL HCU: 186,000 + (DEPTH + 1) * 162,000 + cold-slot
     *      trivial encrypts (32 each, at most DEPTH+1).
     *
     *          DEPTH  4    996,000    (5.0% of 20,000,000)
     *          DEPTH  8  1,644,000    (8.2%)
     *          DEPTH 12  2,292,000   (11.5%)
     *          DEPTH 16  2,940,000   (14.7%)
     *
     *      Global cost grows as O(log N) in the number of stakes; sequential
     *      depth does not grow at all. Headroom at production DEPTH is 14.4x on
     *      depth and 6.8x on global, which is what leaves room for the TWAB
     *      accrual and the confidential transfer in the same commit transaction.
     *
     *      SIGN HANDLING. There is no signed euint. `FHE.neg` is the wrapping
     *      two's-complement negation 2^64 - delta, and euint64 addition wraps,
     *      so `add(node, neg(delta))` is exact modular subtraction. The result
     *      is the true difference for every node on the path as long as no node
     *      is driven below zero. That invariant is upstream's job: SortisPool
     *      clamps a release with FHESafeMath before calling here, so an
     *      over-release becomes an encrypted no-op rather than a wrapped node.
     *      Reverting on an encrypted comparison would itself leak the balance.
     *
     *      PRIVACY. `isAdd` stays encrypted end to end. Solidity never branches
     *      on it; the branch is `FHE.select`. A commit and a release therefore
     *      produce transaction shapes that are identical from the outside: same
     *      node set written, same operation count, same gas. An observer learns
     *      that leaf `leaf` moved, and nothing else. Leaf identity is public by
     *      construction here -- hiding *which* leaf is the walk's problem, not
     *      the update's.
     *
     * @param leaf   Leaf index in [0, 2^DEPTH).
     * @param delta  Encrypted magnitude of the change.
     * @param isAdd  Encrypted direction. True adds, false subtracts.
     */
    function _update(uint256 leaf, euint64 delta, ebool isAdd) internal {
        if (leaf >= capacity()) revert LeafOutOfRange(leaf);

        // Plaintext bookkeeping, no HCU. Keeps the walk proportional to the
        // number of stakes rather than the capacity of the tree.
        if (leaf >= _leafHighWater) _leafHighWater = leaf + 1;

        // Fold the direction into the value. This is the only part of the
        // update that is a dependent chain, and it runs once per call rather
        // than once per level.
        euint64 signed = FHE.select(isAdd, delta, FHE.neg(delta));

        // Walk leaf to root. Every iteration is independent of every other.
        uint256 node = _LEAF_BASE + leaf;
        while (node != 0) {
            euint64 current = _nodes[node];

            // A cold slot holds handle 0, which is not a ciphertext. Trivially
            // encrypt zero instead: 32 HCU, and it keeps the first commit at a
            // leaf the same shape as every commit after it.
            if (!FHE.isInitialized(current)) {
                current = FHE.asEuint64(0);
            }

            euint64 updated = FHE.add(current, signed);
            _nodes[node] = updated;

            // Persist access for later transactions. ACL grants are billed in
            // gas, not HCU, and do not extend the dependent chain.
            FHE.allowThis(updated);

            node >>= 1;
        }
    }

    // ---------------------------------------------------------------------
    // Internal: the walk
    // ---------------------------------------------------------------------

    /**
     * @notice Resolve the lot to a leaf. Descends root to leaf, one encrypted
     *         comparison per level, and returns the leaf index still encrypted.
     *
     * @dev WORST-CASE HCU DEPTH: 240,250 per level, measured. Of the 5,000,000
     *      budget:
     *
     *          DEPTH  4     1,038,032   (20.8%)   measured
     *          DEPTH  8     1,999,032   (40.0%)   measured
     *          DEPTH 12    ~2,960,032   (59.2%)   projected
     *          DEPTH 16    ~3,921,032   (78.4%)   projected
     *
     *      The depth budget holds at every size. The GLOBAL budget does not,
     *      and the reason is the single most important thing in this file.
     *      The two larger sizes are projected rather than measured because the
     *      global cap stops the transaction before it finishes; the projection
     *      is a straight line because per-level depth is a fixed chain, which
     *      test/HCU.t.ts confirms by measuring the slope.
     *
     *      ---------------------------------------------------------------------
     *      THE GAP IN THE SPEC
     *      ---------------------------------------------------------------------
     *      docs/BRIEF.md section 4 describes the walk as three encrypted
     *      operations per level: one `FHE.lt(lot, leftChildSum)`, one
     *      `FHE.select` to pick the branch, one `FHE.select` to subtract the
     *      left sum when going right. Those three are here and they are the
     *      whole of the arithmetic.
     *
     *      What the spec does not say is where `leftChildSum` comes from.
     *      Writing the descent the obvious way:
     *
     *          uint256 node = 1;
     *          for (level...) {
     *              euint64 leftSum = _nodes[2 * node];   // needs plaintext node
     *              ebool goesLeft  = FHE.lt(remaining, leftSum);
     *              node = goesLeft ? 2 * node : 2 * node + 1;   // IMPOSSIBLE
     *          }
     *
     *      The last line is the mistake the brief itself warns about: Solidity
     *      cannot branch on an `ebool`. But without that branch the contract
     *      does not know which node it is standing on at level k+1, so it
     *      cannot address `_nodes[2 * node]` either. Keeping the index
     *      encrypted and reading storage at a plaintext index are the same
     *      requirement pulling in opposite directions.
     *
     *      The resolution is an oblivious read: at level k the current node is
     *      one of 2^k possibilities, so the contract loads all 2^k candidate
     *      left-child sums and collapses them to one with a reduction driven by
     *      the branch bits it has already decided. `_obliviousLeftChildSum`
     *      does this. It is correct, it never branches on a ciphertext, and the
     *      leaf index it produces is genuinely encrypted.
     *
     *      It is also Omega(N), and that is not an artifact of this
     *      implementation. A computation that hides which leaf it selected must
     *      touch every leaf it could have selected: if some node were never
     *      read, an observer would know the answer is not under it. So the
     *      walk reads 2^DEPTH - DEPTH - 1 nodes and pays one `FHE.select`
     *      (55,000 HCU) for each. Whole-walk global HCU against the 20,000,000
     *      cap:
     *
     *          DEPTH  4         11 selects      2,556,192   12.8%   measured
     *          DEPTH  8        247 selects     17,585,952   87.9%   measured
     *          DEPTH 12      4,083 selects   ~230,604,000   1,153%  reverts
     *          DEPTH 16     65,519 selects ~3,611,628,000  18,058%  reverts
     *
     *      2^12 and 2^16 revert with HCUTransactionLimitExceeded, which is the
     *      GLOBAL error. They never reach HCUTransactionDepthLimitExceeded.
     *      That distinction decides what can be done about it: too much work is
     *      splittable across checkpointed transactions, a chain that is too
     *      long is not.
     *
     *      The 20,000,000 global cap puts the ceiling at roughly 2^8, or 256
     *      stakes, for a single-transaction winner-hiding draw.
     *
     *      This does not sink the register. `_update` remains O(log N) at
     *      constant depth and scales to 2^16 exactly as measured. It is the
     *      DRAW that cannot be both O(log N) and winner-hiding, and no encoding
     *      of the tree changes that, because the bound is on the information,
     *      not on the data structure. test/HCU.t.ts measures all four sizes and
     *      reports which ones a real transaction can carry.
     *
     * @param lot Encrypted draw value, expected in [0, root()).
     * @return leafIndex The resolved leaf, still encrypted. Grant it with
     *         FHE.allow before anyone can learn anything from it.
     */
    function _walk(euint64 lot) internal returns (euint16 leafIndex) {
        // Descend only the subtree that actually holds stakes. Everything to
        // the right of leaf `_leafHighWater` is empty, so the levels above the
        // active subtree can only ever branch one way and cost nothing to skip.
        uint8 height = activeHeight();

        // Nothing to resolve: an empty register, or a single leaf that must be
        // the answer. Either way the index is zero and no comparison is needed.
        if (height == 0) {
            leafIndex = FHE.asEuint16(0);
            FHE.allowThis(leafIndex);
            return leafIndex;
        }

        uint256 subtreeRoot = uint256(1) << (DEPTH - height);

        // Branch decisions, most significant first. `goesLeft[k]` is true when
        // the lot landed in the left subtree at level k. These stay ebool for
        // the entire descent; nothing here is ever decrypted or branched on.
        ebool[] memory goesLeft = new ebool[](height);

        // How much of the lot is left after skipping the subtrees to our left.
        euint64 remaining = lot;

        for (uint256 level = 0; level < height; level++) {
            // The current node's left child, resolved without knowing which
            // node the current node is. This is the expensive part.
            euint64 leftSum = _obliviousLeftChildSum(subtreeRoot, level, goesLeft);

            // ONE FHE.lt per level. The lot falls in the left subtree exactly
            // when what remains of it is smaller than the left subtree's total.
            goesLeft[level] = FHE.lt(remaining, leftSum);

            // ONE FHE.select per level, to subtract the left sum when going
            // right. The subtraction is computed unconditionally and then
            // discarded by the select if we went left -- that is what it means
            // for the branch to be encrypted. Computing only the taken side
            // would require knowing which side was taken.
            remaining = FHE.select(goesLeft[level], remaining, FHE.sub(remaining, leftSum));
        }

        // ONE FHE.select per level, to fold each branch bit into the index.
        leafIndex = _packLeafIndex(goesLeft);
        FHE.allowThis(leafIndex);
    }

    /**
     * @notice The left-child sum of the level-`level` node the descent is
     *         standing on, without learning which node that is.
     *
     * @dev WORST-CASE HCU DEPTH: `level` * 55,000, on top of the depth of the
     *      most recent branch bit. WORST-CASE GLOBAL HCU: (2^level - 1) *
     *      55,000, plus 32 per cold node.
     *
     *      At level k the descent could be standing on any of the 2^k nodes at
     *      that level, whose left children are the even-indexed nodes at level
     *      k+1: node (2^(k+1) + 2j) for j in [0, 2^k). The contract loads all
     *      of them and folds the array in half once per branch bit already
     *      decided, oldest bit first.
     *
     *      Oldest bit first is deliberate and it is worth a sentence. Every
     *      fold is one `FHE.select`, so the array collapses in `level` steps
     *      whatever the order. But `goesLeft[level-1]` was only produced a
     *      moment ago and sits at the deepest point of the chain, while
     *      `goesLeft[0]` has been available since the first comparison.
     *      Consuming the old bits first lets those folds run while the chain is
     *      still shallow, so only the final fold extends the critical path.
     *      Folding newest-first would stack all `level` selects on top of the
     *      newest bit and turn a 55,000 tail into a `level` * 55,000 tail.
     */
    function _obliviousLeftChildSum(
        uint256 subtreeRoot,
        uint256 level,
        ebool[] memory goesLeft
    ) private returns (euint64) {
        uint256 width = uint256(1) << level;
        // Left children of the level's nodes, relative to the subtree root.
        // For subtreeRoot == 1 this is the plain heap indexing.
        uint256 base = subtreeRoot << (level + 1);

        euint64[] memory candidates = new euint64[](width);
        for (uint256 j = 0; j < width; j++) {
            candidates[j] = _nodeOrZero(base + 2 * j);
        }

        // Fold. After consuming bit i the surviving half is the one consistent
        // with every branch taken so far, and `candidates[0]` is the answer.
        for (uint256 i = 0; i < level; i++) {
            width >>= 1;
            for (uint256 t = 0; t < width; t++) {
                // Left keeps the lower half: the index bit contributed by a
                // left branch is 0.
                candidates[t] = FHE.select(goesLeft[i], candidates[t], candidates[t + width]);
            }
        }

        return candidates[0];
    }

    /**
     * @notice Assemble the encrypted leaf index from the per-level branch bits.
     *
     * @dev WORST-CASE HCU DEPTH: 55,000 for the bit, plus ceil(log2(DEPTH)) *
     *      93,000 for the reduction. At DEPTH 16 that is 55,000 + 4 * 93,000 =
     *      427,000. WORST-CASE GLOBAL HCU: DEPTH * 55,000 + (DEPTH - 1) *
     *      93,000.
     *
     *      A right branch at level k contributes 2^(DEPTH-1-k) to the index, a
     *      left branch contributes nothing. Each contribution is one
     *      `FHE.select` and they are mutually independent, so they cost depth
     *      once rather than DEPTH times.
     *
     *      The contributions are summed as a balanced tree, not a running
     *      total. A running total would chain DEPTH adds and cost 16 * 93,000 =
     *      1,488,000 of depth; the tree costs 4 * 93,000. Identical global HCU,
     *      logarithmic depth instead of linear. The bits are disjoint so addition is exact -- this is a
     *      bitwise OR written as a sum because addition reduces more cheaply.
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
            for (uint256 t = 0; t + half < n; t++) {
                parts[t] = FHE.add(parts[t], parts[t + half]);
            }
            n = half;
        }

        return parts[0];
    }

    /**
     * @notice A node's sum, substituting a trivial zero for a cold slot.
     * @dev WORST-CASE HCU DEPTH: 32, one TrivialEncrypt, and only when the slot
     *      has never been written. A warm node costs nothing at all.
     */
    function _nodeOrZero(uint256 node) private returns (euint64) {
        euint64 value = _nodes[node];
        return FHE.isInitialized(value) ? value : FHE.asEuint64(0);
    }

    /**
     * @notice Grant `account` the right to decrypt the register root.
     * @dev WORST-CASE HCU DEPTH: 0. ACL grants are not coprocessor operations.
     *      Used by SortisDraw so the committed root can be published alongside
     *      the draw proof. The root is the *total* weight; publishing it reveals
     *      the size of the pool, which the brief treats as public, and nothing
     *      about any individual stake.
     */
    function _allowRoot(address account) internal {
        FHE.allow(_nodes[1], account);
    }
}
