// SPDX-License-Identifier: BSD-3-Clause-Clear
pragma solidity ^0.8.27;

import {FHE, euint64} from "@fhevm/solidity/lib/FHE.sol";
import {SortisPool} from "../SortisPool.sol";

/**
 * @title  SortisPoolHarness
 * @notice Test-only reader for pool internals.
 *
 * @dev Adds no encrypted logic. It exists so a test can grant itself a view of
 *      the register root and confirm that the weight the pool wrote is the TWAB
 *      it claims to have written. In production the root is read by SortisDraw,
 *      which will carry its own grant.
 */
contract SortisPoolHarness is SortisPool {
    /**
     * @dev WORST-CASE HCU DEPTH: 0. Forwards to the base constructor.
     */
    constructor(address confidentialAsset, uint8 depth) SortisPool(confidentialAsset, depth) {}

    /**
     * @notice Grant `account` the right to decrypt the register root.
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
}
