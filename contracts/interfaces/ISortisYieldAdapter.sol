// SPDX-License-Identifier: BSD-3-Clause-Clear
pragma solidity ^0.8.27;

/**
 * @title  ISortisYieldAdapter
 * @notice Where the prize comes from.
 *
 * @dev The prize is PUBLIC. It is an amount of cUSDT harvested from whatever
 *      is earning on the pooled principal, and the brief is explicit that
 *      encrypting it would remove the public verifiability the bounty asks for
 *      while gaining nothing. What is secret is who wins it.
 *
 *      Sepolia has no real yield, so the adapter behind this interface there is
 *      a mock with an admin-callable accrue. On mainnet the same interface sits
 *      in front of an ERC-4626 vault. Chasing a live yield source on a testnet
 *      would burn days and prove nothing.
 */
interface ISortisYieldAdapter {
    /**
     * @notice Move all accrued yield to `to` and return the public amount.
     * @dev Returns zero when there is nothing to harvest, which opens a draw
     *      with a zero prize rather than reverting. A draw with no prize is
     *      still a valid draw; it just pays nothing.
     */
    function harvest(address to) external returns (uint64 amount);

    /// @notice Yield accrued and not yet harvested, in cUSDT base units.
    function pending() external view returns (uint64);
}
