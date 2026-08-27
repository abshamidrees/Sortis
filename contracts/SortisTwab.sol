// SPDX-License-Identifier: BSD-3-Clause-Clear
pragma solidity ^0.8.27;

import {FHE, euint64} from "@fhevm/solidity/lib/FHE.sol";
import {ZamaEthereumConfig} from "@fhevm/solidity/config/ZamaConfig.sol";

/**
 * @title  SortisTwab
 * @notice A stake's own copy of its weight line, so the owner can read what
 *         they hold and what it is worth without decrypting the register.
 *
 * @dev This file used to carry an accumulator, a lastUpdate, and an accrual
 *      step that folded `balance * elapsed` in on every balance change. All of
 *      that is gone, and the reason is worth stating because it was a real
 *      bug: weight only moved when a stake was touched, so a depositor who
 *      committed once and left the position alone kept the weight they had at
 *      their last balance change. For a stake that never changed, that is
 *      zero. An honest saver had no odds.
 *
 *      SortisRegister now stores the weight LINE rather than a point:
 *
 *          weight(T) = intercept + slope * T
 *
 *      and a balance change of delta at time t moves it by slope += delta,
 *      intercept -= delta * t. This contract mirrors the same two numbers per
 *      stake. The slope is just the balance, so only the intercept is extra
 *      storage, and there is no accrual step at all: weight at any T is one
 *      scalar multiply and one add, and nothing is ever stale.
 *
 *      The anti-snipe property survives, and survives for a better reason than
 *      before. Time is counted in whole hours, so a stake committed minutes
 *      before a draw has slope * T exactly cancelled by its own intercept and
 *      is worth zero. Not because it was missed by an accrual pass, but
 *      because it has genuinely been in the pool for no time at all.
 */
abstract contract SortisTwab is ZamaEthereumConfig {
    struct Stake {
        /// Confidential balance. Also the slope of this stake's weight line.
        euint64 balance;
        /// Intercept of the weight line. Negative in two's complement for any
        /// stake that has ever held money, which is expected and correct.
        euint64 intercept;
        /// Plaintext. When the balance last moved. Display only, and not
        /// secret: the timing of a transaction is already on chain.
        uint48 lastChange;
    }

    mapping(address => Stake) private _stakes;

    event StakeMoved(address indexed owner, uint48 at);

    // ---------------------------------------------------------------------
    // Views
    // ---------------------------------------------------------------------

    /**
     * @notice The stake's confidential balance handle.
     * @dev WORST-CASE HCU DEPTH: 0. Returns a stored handle, which is
     *      meaningless without an ACL grant and therefore safe to expose.
     */
    function confidentialBalanceOf(address owner) public view returns (euint64) {
        return _stakes[owner].balance;
    }

    /**
     * @notice The intercept of this stake's weight line.
     * @dev WORST-CASE HCU DEPTH: 0. Returns a stored handle.
     */
    function interceptOf(address owner) public view returns (euint64) {
        return _stakes[owner].intercept;
    }

    /**
     * @notice When this stake's balance last moved, as a plaintext timestamp.
     * @dev WORST-CASE HCU DEPTH: 0. Plaintext read. Zero for a stake that has
     *      never been opened.
     */
    function lastChangeOf(address owner) public view returns (uint48) {
        return _stakes[owner].lastChange;
    }

    // ---------------------------------------------------------------------
    // Internal
    // ---------------------------------------------------------------------

    /**
     * @notice Apply a balance change to a stake's own line.
     *
     * @dev WORST-CASE HCU DEPTH: 162,000 on top of its inputs. Two adds that
     *      do not depend on each other, so they cost one add of depth between
     *      them.
     *
     *      Takes the deltas already computed by
     *      `SortisRegister._signedDeltas` rather than recomputing them, which
     *      saves the 365,000 scalar multiply. The register and the stake move
     *      by exactly the same two numbers, which is what keeps the leaf and
     *      its owner's copy in agreement.
     */
    function _applyToStake(address owner, euint64 signed, euint64 interceptDelta) internal {
        Stake storage stake = _stakes[owner];

        euint64 balance = stake.balance;
        euint64 intercept = stake.intercept;

        euint64 nextBalance = FHE.isInitialized(balance) ? FHE.add(balance, signed) : signed;
        euint64 nextIntercept = FHE.isInitialized(intercept)
            ? FHE.add(intercept, interceptDelta)
            : interceptDelta;

        stake.balance = nextBalance;
        stake.intercept = nextIntercept;
        stake.lastChange = uint48(block.timestamp);

        FHE.allowThis(nextBalance);
        FHE.allowThis(nextIntercept);
        // The owner grant is what lets the frontend decrypt its own position
        // client-side. Nobody else is granted, so nobody else can read it.
        FHE.allow(nextBalance, owner);
        FHE.allow(nextIntercept, owner);

        emit StakeMoved(owner, stake.lastChange);
    }

    /**
     * @notice Overwrite a stake's balance directly, keeping its line intact.
     *
     * @dev WORST-CASE HCU DEPTH: 0. Storage write plus ACL grants.
     *
     *      Used by the release path, where FHESafeMath has already produced
     *      the post-release balance and re-deriving it from a delta would
     *      double the work. The intercept is moved separately by
     *      `_applyToStake` with the delta that was actually applied.
     */
    function _setBalance(address owner, euint64 newBalance) internal {
        _stakes[owner].balance = newBalance;
        FHE.allowThis(newBalance);
        FHE.allow(newBalance, owner);
    }
}
