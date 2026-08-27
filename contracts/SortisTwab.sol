// SPDX-License-Identifier: BSD-3-Clause-Clear
pragma solidity ^0.8.27;

import {FHE, euint64} from "@fhevm/solidity/lib/FHE.sol";
import {ZamaEthereumConfig} from "@fhevm/solidity/config/ZamaConfig.sol";

/**
 * @title  SortisTwab
 * @notice Encrypted time-weighted balance observations. The weight a stake
 *         carries into a draw is how much money sat in the pool and for how
 *         long, not what the balance happened to be at the draw block.
 *
 * @dev ---------------------------------------------------------------------
 *      WHY TIME-WEIGHTED
 *      ---------------------------------------------------------------------
 *      If odds tracked the raw balance, anyone could watch for `DrawOpened`,
 *      commit a large stake in the same block, win, and release. Weighting by
 *      time removes the attack without any special-casing: a stake committed a
 *      moment before the draw has been in the pool for zero time and accrues
 *      zero weight, so there is nothing to snipe with.
 *
 *      ---------------------------------------------------------------------
 *      THE SCALAR MULTIPLY
 *      ---------------------------------------------------------------------
 *      Accrual is `balance * elapsed`. The balance is a ciphertext; the elapsed
 *      time is not, because `block.timestamp` is public and pretending
 *      otherwise would buy nothing. That makes this the SCALAR overload,
 *      `FHE.mul(euint64, uint64)`, and the difference is not small:
 *
 *          FheMul scalar    (ct, plaintext)   365,000 HCU
 *          FheMul nonScalar (ct, ct)          596,000 HCU
 *
 *      63% more expensive for a number that is already public. The scalar form
 *      is used here and everywhere else it fits. Encrypting the multiplier
 *      would also drag `elapsed` into the dependent chain, which is the more
 *      expensive mistake of the two.
 *
 *      ---------------------------------------------------------------------
 *      TIME GRANULARITY, AND WHY IT IS NOT SECONDS
 *      ---------------------------------------------------------------------
 *      Accrual is measured in whole TIME_UNITs, not seconds, because seconds
 *      overflow euint64 at realistic pool sizes. A $10M pool of a 6-decimal
 *      token is 1e13 base units; a year is 3.15e7 seconds; the product is
 *      3.2e20 and euint64 tops out at 1.84e19. In hours the same pool-year is
 *      8.8e16, roughly 200x of headroom, and a decade still fits.
 *
 *      A partial unit is never thrown away: `lastUpdate` advances only by the
 *      whole units consumed, so the remainder is carried into the next accrual.
 *
 *      ---------------------------------------------------------------------
 *      KNOWN LIMITATION -- READ THIS BEFORE WIRING UP SortisDraw
 *      ---------------------------------------------------------------------
 *      Weight accrues only when a balance changes, because that is the only
 *      moment the contract touches the stake. A stake that is committed and
 *      then left alone therefore carries the weight it had at its last
 *      balance change, not the weight it has earned since. A depositor who
 *      commits once and never touches the position again sits at zero weight
 *      until they touch it, which is safe (nobody can snipe) but wrong (an
 *      honest depositor has no odds).
 *
 *      Fixing it properly does not need a loop over stakes. Write the identity
 *
 *          weight_i(T) = accumulator_i + balance_i * (T - lastUpdate_i)
 *                      = (accumulator_i - balance_i * lastUpdate_i)
 *                        + balance_i * T
 *
 *      and note that both bracketed terms are additive over a subtree. Keep
 *      TWO euint64 per register node -- the intercept and the slope -- and any
 *      subtree's exact time-weighted sum at any T is one scalar multiply and
 *      one add, with T plaintext. That doubles `_update` and leaves the walk
 *      untouched. It is the right fix and it is deliberately not in this
 *      commit, because it changes SortisRegister's node shape and that is a
 *      decision to make once, with the draw in front of you.
 */
abstract contract SortisTwab is ZamaEthereumConfig {
    // ---------------------------------------------------------------------
    // Constants and storage
    // ---------------------------------------------------------------------

    /// @notice Granularity of accrual. See the overflow note above.
    uint48 public constant TIME_UNIT = 1 hours;

    struct Observation {
        /// Confidential balance currently held by the stake.
        euint64 balance;
        /// Integral of balance over time, in balance-units * TIME_UNIT.
        euint64 twabAccumulator;
        /// Plaintext. Timestamps are not secret and encrypting them buys nothing.
        uint48 lastUpdate;
    }

    mapping(address => Observation) private _observations;

    event StakeAccrued(address indexed owner, uint48 through, uint64 units);

    // ---------------------------------------------------------------------
    // Views
    // ---------------------------------------------------------------------

    /**
     * @notice The stake's confidential balance handle.
     * @dev WORST-CASE HCU DEPTH: 0. Returns a stored handle. Meaningless to
     *      anyone without an ACL grant, which is why it is safe to expose.
     */
    function confidentialBalanceOf(address owner) public view returns (euint64) {
        return _observations[owner].balance;
    }

    /**
     * @notice The stake's accrued time-weighted balance handle.
     * @dev WORST-CASE HCU DEPTH: 0. Returns a stored handle.
     */
    function twabOf(address owner) public view returns (euint64) {
        return _observations[owner].twabAccumulator;
    }

    /**
     * @notice When this stake last accrued, as a plaintext timestamp.
     * @dev WORST-CASE HCU DEPTH: 0. Plaintext read. Public on purpose: the
     *      timing of a balance change is already visible on chain, so hiding
     *      this accessor would be theatre.
     */
    function lastUpdateOf(address owner) public view returns (uint48) {
        return _observations[owner].lastUpdate;
    }

    /**
     * @notice Whole TIME_UNITs that would accrue if `owner` were touched now.
     * @dev WORST-CASE HCU DEPTH: 0. Plaintext arithmetic. Lets the frontend
     *      show a depositor how much weight is pending without decrypting.
     */
    function pendingUnits(address owner) public view returns (uint64) {
        Observation storage observation = _observations[owner];
        if (observation.lastUpdate == 0) return 0;
        return uint64((uint48(block.timestamp) - observation.lastUpdate) / TIME_UNIT);
    }

    // ---------------------------------------------------------------------
    // Internal
    // ---------------------------------------------------------------------

    /**
     * @notice Fold elapsed time into the stake's accumulator and return what
     *         was added, so the caller can push the same delta into the register.
     *
     * @dev WORST-CASE HCU DEPTH: 527,000 (10.5% of the 5,000,000 budget).
     *
     *          FHE.mul(balance, units)   365,000   scalar, depth 365,000
     *          FHE.add(accumulator, .)   162,000   depth 527,000
     *
     *      One multiply, one add, exactly as the brief specifies. Both operands
     *      of the multiply would be ciphertext if `units` were encrypted, which
     *      would cost 596,000 instead of 365,000 and gain nothing.
     *
     *      WORST-CASE GLOBAL HCU: 527,000 plus at most two 32 HCU trivial
     *      encrypts on a stake's first accrual.
     *
     *      Returns a trivial encrypted zero when no whole TIME_UNIT has passed,
     *      which is also the path a brand-new stake takes. `lastUpdate` is NOT
     *      advanced in that case, so a sub-unit remainder is carried rather
     *      than discarded.
     */
    function _accrue(address owner) internal returns (euint64 accrued) {
        Observation storage observation = _observations[owner];
        uint48 nowTs = uint48(block.timestamp);

        // First touch: start the clock, accrue nothing. There is no elapsed
        // time to weight and no balance to weight it against.
        if (observation.lastUpdate == 0) {
            observation.lastUpdate = nowTs;
            return FHE.asEuint64(0);
        }

        uint64 units = uint64((nowTs - observation.lastUpdate) / TIME_UNIT);
        if (units == 0 || !FHE.isInitialized(observation.balance)) {
            // Leave lastUpdate alone so the partial unit is not lost.
            return FHE.asEuint64(0);
        }

        // THE SCALAR MULTIPLY. `units` is a plaintext uint64, so this resolves
        // to FHE.mul(euint64, uint64) at 365,000 HCU rather than the
        // ciphertext-ciphertext overload at 596,000.
        accrued = FHE.mul(observation.balance, units);

        euint64 updated = FHE.isInitialized(observation.twabAccumulator)
            ? FHE.add(observation.twabAccumulator, accrued)
            : accrued;

        observation.twabAccumulator = updated;
        // Advance by whole units only; the remainder carries forward.
        observation.lastUpdate = observation.lastUpdate + uint48(units) * TIME_UNIT;

        FHE.allowThis(accrued);
        FHE.allowThis(updated);
        FHE.allow(updated, owner);

        emit StakeAccrued(owner, observation.lastUpdate, units);
    }

    /**
     * @notice Overwrite a stake's confidential balance.
     * @dev WORST-CASE HCU DEPTH: 0. Storage write plus two ACL grants, neither
     *      of which is a coprocessor operation. The owner grant is what lets
     *      the frontend decrypt its own balance client-side; nobody else is
     *      granted, so nobody else can read it.
     */
    function _setBalance(address owner, euint64 newBalance) internal {
        _observations[owner].balance = newBalance;
        FHE.allowThis(newBalance);
        FHE.allow(newBalance, owner);
    }

    /**
     * @notice Start the clock for a stake that has never been touched.
     * @dev WORST-CASE HCU DEPTH: 0. Plaintext write.
     */
    function _startClock(address owner) internal {
        if (_observations[owner].lastUpdate == 0) {
            _observations[owner].lastUpdate = uint48(block.timestamp);
        }
    }
}
