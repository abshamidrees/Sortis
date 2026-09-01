// SPDX-License-Identifier: BSD-3-Clause-Clear
pragma solidity ^0.8.27;

import {FHE, euint64} from "@fhevm/solidity/lib/FHE.sol";
import {ZamaEthereumConfig} from "@fhevm/solidity/config/ZamaConfig.sol";

/**
 * @title  PublicDecryptProbe
 * @notice The smallest possible public decryption, to tell a broken relayer
 *         from a broken contract.
 *
 * @dev A draw's total weight stopped being decryptable, and the two candidate
 *      explanations sit on opposite sides of the boundary: either the relayer's
 *      public decrypt is down, in which case nothing here is at fault, or
 *      something about how `publishRootForDraw` grants the handle is wrong, in
 *      which case it is entirely at fault.
 *
 *      This has nothing to do with the register, the walk, or a draw. It makes
 *      a trivially encrypted constant, publishes it, and stops. If this handle
 *      will not decrypt, no handle will.
 */
contract PublicDecryptProbe is ZamaEthereumConfig {
    euint64 public value;

    event Published(bytes32 handle, uint64 plaintext);

    /**
     * @notice Encrypt `n`, publish it, and emit its handle.
     * @dev WORST-CASE HCU DEPTH: 32, one TrivialEncrypt. Nothing else happens.
     */
    function publish(uint64 n) external returns (bytes32 handle) {
        euint64 v = FHE.asEuint64(n);
        FHE.allowThis(v);
        FHE.makePubliclyDecryptable(v);
        value = v;
        handle = euint64.unwrap(v);
        emit Published(handle, n);
    }

    function handle() external view returns (bytes32) {
        return euint64.unwrap(value);
    }
}
