// SPDX-License-Identifier: BSD-3-Clause-Clear
pragma solidity ^0.8.27;

import {FHE, euint64} from "@fhevm/solidity/lib/FHE.sol";
import {ZamaEthereumConfig} from "@fhevm/solidity/config/ZamaConfig.sol";
import {ERC7984} from "@openzeppelin/confidential-contracts/token/ERC7984/ERC7984.sol";

/**
 * @title  MockConfidentialUSDT
 * @notice A faucet-mintable ERC-7984 standing in for cUSDT on Sepolia.
 *
 * @dev Sepolia has no cUSDT, and the brief is explicit that faking depth on the
 *      asset side is a waste of days. This is a plain ERC-7984 with an open
 *      mint so a demo can fund an account in one transaction. Mainnet uses the
 *      real confidential USDT and this contract does not ship.
 *
 *      6 decimals, matching USDT, because the TWAB overflow headroom in
 *      SortisTwab is reasoned against a 6-decimal token.
 */
contract MockConfidentialUSDT is ERC7984, ZamaEthereumConfig {
    constructor() ERC7984("Confidential USDT (Sortis mock)", "cUSDT", "") {}

    /**
     * @notice USDT decimals.
     * @dev WORST-CASE HCU DEPTH: 0.
     */
    function decimals() public pure override returns (uint8) {
        return 6;
    }

    /**
     * @notice Mint `amount` base units to `to`. Open by design; this is a faucet.
     * @dev WORST-CASE HCU DEPTH: 32 for the trivial encrypt, plus whatever
     *      ERC7984._mint costs to settle the balance.
     */
    function mint(address to, uint64 amount) external returns (euint64) {
        euint64 value = FHE.asEuint64(amount);
        FHE.allowThis(value);
        return _mint(to, value);
    }
}
