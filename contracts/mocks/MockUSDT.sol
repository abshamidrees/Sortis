// SPDX-License-Identifier: BSD-3-Clause-Clear
pragma solidity ^0.8.27;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/**
 * @title  MockUSDT
 * @notice Public ERC-20 standing in for USDT on the input side of the wrap
 *         queue. Open mint, 6 decimals.
 */
contract MockUSDT is ERC20 {
    constructor() ERC20("USD Tether (Sortis mock)", "USDT") {}

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}
