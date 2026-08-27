// SPDX-License-Identifier: BSD-3-Clause-Clear
pragma solidity ^0.8.27;

import {FHE, euint64, euint16, ebool, externalEuint64, externalEbool} from "@fhevm/solidity/lib/FHE.sol";
import {SortisRegister} from "../SortisRegister.sol";

/**
 * @title  SortisRegisterHarness
 * @notice Test-only external surface over SortisRegister.
 *
 * @dev This contract exists so that test/HCU.t.ts can bill a single `_update`
 *      as its own transaction and read the coprocessor's HCU accounting for it
 *      in isolation. It adds no encrypted logic: every function here forwards
 *      to the base and the measured cost is the base's cost.
 *
 *      It is NOT deployed to Sepolia. In production `_update` is internal and
 *      reachable only through SortisPool, which owns the TWAB accrual and the
 *      confidential transfer that must happen alongside it.
 */
contract SortisRegisterHarness is SortisRegister {
    /**
     * @dev WORST-CASE HCU DEPTH: 0. Forwards to the base constructor, which
     *      performs no FHE operation.
     */
    constructor(uint8 depth) SortisRegister(depth) {}

    /**
     * @notice Assign a leaf to `owner` and return it.
     * @dev WORST-CASE HCU DEPTH: 0. Plaintext bookkeeping only.
     */
    function assignLeaf(address owner) external returns (uint256) {
        return _leafFor(owner);
    }

    /**
     * @notice Apply one signed update at `leaf` from ciphertext inputs.
     *
     * @dev WORST-CASE HCU DEPTH: 348,000 + 0 = 348,000, constant in DEPTH.
     *
     *      `FHE.fromExternal` verifies the input proof and materializes the
     *      handle. Proof verification is a KMS/coprocessor input check, not a
     *      symbolic operation, so it contributes 0 to the HCU depth chain and
     *      the measured depth is exactly `_update`'s.
     *
     *      This is the function test/HCU.t.ts measures.
     */
    function update(
        uint256 leaf,
        externalEuint64 delta,
        externalEbool isAdd,
        bytes calldata inputProof
    ) external {
        euint64 d = FHE.fromExternal(delta, inputProof);
        ebool add = FHE.fromExternal(isAdd, inputProof);
        _update(leaf, d, add);
    }

    /**
     * @notice Apply one update from a plaintext amount, for seeding a tree.
     *
     * @dev WORST-CASE HCU DEPTH: 348,032, constant in DEPTH.
     *
     *      One extra `TrivialEncrypt` (32 HCU) each for the amount and the
     *      direction sits in front of the 348,000 chain. Used only to populate
     *      a register cheaply before a measurement; the number that the HCU
     *      suite asserts comes from `update` above, which takes real ciphertext.
     */
    function seed(uint256 leaf, uint64 amount, bool isAdd) external {
        _update(leaf, FHE.asEuint64(amount), FHE.asEbool(isAdd));
    }

    /**
     * @notice Resolve a plaintext lot to an encrypted leaf index.
     *
     * @dev WORST-CASE HCU DEPTH: 32 (one TrivialEncrypt for the lot) on top of
     *      `_walk`, so about 217,000 per level. See `_walk` for the global HCU,
     *      which is the number that actually constrains this function.
     *
     *      The lot is plaintext here only so the suite can drive the walk to a
     *      known leaf and check the answer. SortisDraw produces it with
     *      FHE.randEuint64 and FHE.rem against the root, and it is never
     *      plaintext in production.
     *
     *      The resolved index is stored, not returned: it is a ciphertext
     *      handle, and a transaction that mutates coprocessor state cannot be
     *      read back through a call. Read it with `lastWalkResult`.
     */
    function walk(uint64 lot) external {
        _lastWalkResult = _walk(FHE.asEuint64(lot), timeUnitsNow());
        FHE.allow(_lastWalkResult, msg.sender);
    }

    /**
     * @notice Resolve an encrypted lot to an encrypted leaf index.
     * @dev WORST-CASE HCU DEPTH: identical to `_walk`. `FHE.fromExternal` is an
     *      input proof check, not a symbolic operation, so it adds nothing to
     *      the chain. This is the shape SortisDraw will use.
     */
    function walkEncrypted(externalEuint64 lot, bytes calldata inputProof) external {
        _lastWalkResult = _walk(FHE.fromExternal(lot, inputProof), timeUnitsNow());
        FHE.allow(_lastWalkResult, msg.sender);
    }

    /// @dev Result of the most recent walk. See `walk`.
    euint16 private _lastWalkResult;

    /**
     * @notice The encrypted leaf index resolved by the most recent walk.
     * @dev WORST-CASE HCU DEPTH: 0. Returns a stored handle.
     */
    function lastWalkResult() external view returns (euint16) {
        return _lastWalkResult;
    }

    /**
     * @notice Grant `account` decryption rights on the root.
     * @dev WORST-CASE HCU DEPTH: 0. ACL grant only.
     */
    function allowRoots(address account) external {
        _allowRoots(account);
    }

    /**
     * @notice Total encrypted weight at hour `t`, granted to the caller.
     * @dev WORST-CASE HCU DEPTH: 527,000. One scalar multiply, one add.
     */
    function weightAt(uint64 t) external returns (euint64 weight) {
        weight = _rootWeightAt(t);
        FHE.allowThis(weight);
        FHE.allow(weight, msg.sender);
    }

    /**
     * @notice Grant `account` decryption rights on an arbitrary node.
     * @dev WORST-CASE HCU DEPTH: 0. ACL grant only. Lets a test verify subtree
     *      sums, which is how the update path is checked for correctness.
     */
    function allowNodeWeight(uint256 node, uint64 t, address account) external returns (euint64 w) {
        w = _weightAt(node, t);
        FHE.allowThis(w);
        FHE.allow(w, account);
    }
}
