// SPDX-License-Identifier: BSD-3-Clause-Clear
pragma solidity ^0.8.27;

import {ISortisYieldAdapter} from "../interfaces/ISortisYieldAdapter.sol";
import {MockConfidentialUSDT} from "./MockConfidentialUSDT.sol";

/**
 * @title  MockYieldAdapter
 * @notice Sepolia stand-in for a yield source. `accrue` is admin-callable and
 *         mints the prize on harvest.
 *
 * @dev Deliberately not an ERC-4626 vault. Sepolia has no real yield, and
 *      building a convincing fake one costs days and proves nothing about the
 *      part of this protocol that is hard. The mainnet path is the same
 *      interface in front of a real vault; this is the interface honoured
 *      cheaply so the draw has a pot to pay out.
 */
contract MockYieldAdapter is ISortisYieldAdapter {
    MockConfidentialUSDT public immutable asset;
    address public admin;
    uint64 private _pending;

    event Accrued(uint64 amount, uint64 total);
    event Harvested(address indexed to, uint64 amount);

    error NotAdmin();

    constructor(address assetAddress) {
        asset = MockConfidentialUSDT(assetAddress);
        admin = msg.sender;
    }

    /// @notice Yield waiting to be harvested.
    /// @dev WORST-CASE HCU DEPTH: 0. Plaintext read.
    function pending() external view returns (uint64) {
        return _pending;
    }

    /**
     * @notice Book `amount` of yield. Stands in for time passing in a vault.
     * @dev WORST-CASE HCU DEPTH: 0. Plaintext arithmetic.
     */
    function accrue(uint64 amount) external {
        if (msg.sender != admin) revert NotAdmin();
        _pending += amount;
        emit Accrued(amount, _pending);
    }

    /**
     * @notice Mint the pending yield to `to` and reset.
     * @dev WORST-CASE HCU DEPTH: 32 for the trivial encrypt inside the mint.
     *      The amount returned is plaintext because the prize is public.
     */
    function harvest(address to) external returns (uint64 amount) {
        amount = _pending;
        _pending = 0;
        if (amount > 0) {
            asset.mint(to, amount);
        }
        emit Harvested(to, amount);
    }
}
