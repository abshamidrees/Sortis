// SPDX-License-Identifier: BSD-3-Clause-Clear
pragma solidity ^0.8.27;

import {FHE, euint64, euint16, ebool} from "@fhevm/solidity/lib/FHE.sol";
import {ZamaEthereumConfig} from "@fhevm/solidity/config/ZamaConfig.sol";
import {IERC7984} from "@openzeppelin/confidential-contracts/interfaces/IERC7984.sol";

import {SortisPool} from "./SortisPool.sol";
import {ISortisYieldAdapter} from "./interfaces/ISortisYieldAdapter.sol";

/**
 * @title  SortisDraw
 * @notice Prize rounds. Two transactions, and the order of them is the whole
 *         security argument.
 *
 * @dev ---------------------------------------------------------------------
 *      WHY TWO TRANSACTIONS
 *      ---------------------------------------------------------------------
 *      `openDraw` commits the register root and the block, and publishes both.
 *      At that moment no randomness exists anywhere -- not on chain, not in the
 *      operator's head. `drawLot` produces the lot in a LATER block with
 *      `FHE.randEuint64`, which the coprocessor derives at execution time.
 *
 *      Collapsing the two into one transaction would let an operator simulate
 *      the call, see the lot, and reshape the register before broadcasting.
 *      Splitting them means the operator has to commit to the tree before
 *      learning anything about who it favours.
 *
 *      `drawLot` additionally requires the root handle to be UNCHANGED since
 *      the open. Handles are content-derived, so a single commit or release
 *      anywhere in the pool produces a different root handle and invalidates
 *      the draw. That turns "the operator promised not to reshape the tree"
 *      into something the contract checks rather than something you trust.
 *
 *      ---------------------------------------------------------------------
 *      THE DENOMINATOR HAS TO BE PUBLIC
 *      ---------------------------------------------------------------------
 *      The lot must land uniformly in [0, totalWeight). `FHE.rem` and
 *      `FHE.randEuint64(bound)` both take a PLAINTEXT bound -- there is no
 *      ciphertext-ciphertext remainder in FHEVM -- so the total weight has to
 *      be a number the contract can see.
 *
 *      `openDraw` therefore marks the committed root publicly decryptable, and
 *      `drawLot` takes the plaintext total plus the KMS decryption proof and
 *      verifies it with `FHE.checkSignatures`. An operator who supplies a
 *      false total fails signature verification and the transaction reverts.
 *      No third transaction: fetching the KMS proof is an off-chain read
 *      between the two.
 *
 *      Publishing the total is not a leak of anyone's position. It is an
 *      aggregate over every stake, and a draw whose denominator nobody can see
 *      is not publicly verifiable, which is the property the bounty asks for.
 *
 *      ---------------------------------------------------------------------
 *      WHY THE PRIZE IS CLAIMED, NOT PUSHED
 *      ---------------------------------------------------------------------
 *      The brief says drawLot should grant the prize ciphertext to the drawn
 *      leaf's owner with `FHE.allow`. That cannot be done from `drawLot`, and
 *      the reason is structural rather than a limitation of this code:
 *
 *          FHE.allow(handle, account) takes a PLAINTEXT address.
 *          The walk resolves to an ENCRYPTED leaf index.
 *          Looking up _leafOwner[index] needs a plaintext index.
 *
 *      Decrypting the index to complete the grant would publish the winner,
 *      which is the one thing the walk exists to prevent. So the grant is
 *      issued in `claimPrize` instead, at the only moment a plaintext address
 *      is available: when the winner shows up holding one.
 *
 *      `claimPrize` compares the caller's own leaf against the encrypted
 *      resolved leaf, selects the prize or zero on the encrypted result, and
 *      confidentially transfers that. Every claimant runs the same code and
 *      moves the same shaped ciphertext; only one of them moves a non-zero
 *      amount, and nobody outside can tell which. The ACL grant is still
 *      scoped to the drawn address -- it is just pulled rather than pushed.
 */
contract SortisDraw is ZamaEthereumConfig {
    // ---------------------------------------------------------------------
    // Types and storage
    // ---------------------------------------------------------------------

    struct Draw {
        /// Root handle committed at open. Content-derived, so it doubles as a
        /// fingerprint of the entire register at that instant.
        bytes32 rootHandle;
        /// Block the draw was opened in. The lot must come strictly later.
        uint256 openedAtBlock;
        /// Public prize, harvested from the yield adapter at open.
        uint64 prize;
        /// Total register weight, verified against the KMS proof at drawLot.
        uint64 totalWeight;
        /// Height of the subtree the walk descended. Public.
        uint8 walkHeight;
        /// Set once drawLot has run.
        bool lotDrawn;
        /// The resolved leaf, still encrypted. Nobody is granted this.
        euint16 resolvedLeaf;
        /// The prize as a ciphertext, for the claim path.
        euint64 prizeCiphertext;
    }

    SortisPool public immutable pool;
    IERC7984 public immutable asset;
    ISortisYieldAdapter public immutable yieldAdapter;

    mapping(uint256 => Draw) private _draws;
    mapping(uint256 => mapping(address => bool)) private _claimed;

    uint256 public drawCount;

    // ---------------------------------------------------------------------
    // Events
    // ---------------------------------------------------------------------

    /// @dev The root handle and the block are the public commitment. Anyone can
    ///      check later that the lot was drawn against this exact tree.
    event DrawOpened(uint256 indexed drawId, bytes32 rootHandle, uint256 blockNumber, uint64 prize);

    /// @dev The lot and the resolved leaf are published as HANDLES. Publishing
    ///      the handles is what makes the walk auditable; they decrypt to
    ///      nothing without a grant, and no grant is issued for either.
    event Drawn(uint256 indexed drawId, bytes32 lotHandle, bytes32 resolvedLeafHandle, uint64 totalWeight);

    event PrizeClaimed(uint256 indexed drawId, address indexed claimant);

    // ---------------------------------------------------------------------
    // Errors
    // ---------------------------------------------------------------------

    error UnknownDraw(uint256 drawId);
    error DrawAlreadySettled(uint256 drawId);
    error LotNotDrawn(uint256 drawId);
    error SameBlockAsOpen();
    error RegisterMovedSinceOpen(bytes32 committed, bytes32 current);
    error RegisterEmpty();
    error AlreadyClaimed(uint256 drawId, address claimant);
    error TotalWeightOverflow(uint256 decoded);

    // ---------------------------------------------------------------------
    // Constructor
    // ---------------------------------------------------------------------

    /**
     * @notice Wire the draw to a pool and a yield source.
     * @dev WORST-CASE HCU DEPTH: 0. No FHE operation.
     */
    constructor(address poolAddress, address yieldAdapterAddress) {
        pool = SortisPool(poolAddress);
        asset = IERC7984(address(SortisPool(poolAddress).asset()));
        yieldAdapter = ISortisYieldAdapter(yieldAdapterAddress);
    }

    // ---------------------------------------------------------------------
    // Views
    // ---------------------------------------------------------------------

    /**
     * @notice Public facts about a draw.
     * @dev WORST-CASE HCU DEPTH: 0. Plaintext reads only. The encrypted fields
     *      are deliberately not returned here; see `resolvedLeafHandle`.
     */
    function drawInfo(
        uint256 drawId
    )
        external
        view
        returns (
            bytes32 rootHandle,
            uint256 openedAtBlock,
            uint64 prize,
            uint64 totalWeight,
            uint8 walkHeight,
            bool lotDrawn
        )
    {
        Draw storage d = _draws[drawId];
        return (d.rootHandle, d.openedAtBlock, d.prize, d.totalWeight, d.walkHeight, d.lotDrawn);
    }

    /**
     * @notice The resolved leaf as a raw handle, for auditing the walk.
     * @dev WORST-CASE HCU DEPTH: 0. Returns a handle nobody can decrypt. It is
     *      published so an observer can confirm the same ciphertext the walk
     *      produced is the one the claims are checked against.
     */
    function resolvedLeafHandle(uint256 drawId) external view returns (bytes32) {
        return euint16.unwrap(_draws[drawId].resolvedLeaf);
    }

    /**
     * @notice Whether `claimant` has already claimed this draw.
     * @dev WORST-CASE HCU DEPTH: 0. Plaintext read. True for everyone who
     *      claimed, winner or not, so it reveals nothing about the outcome.
     */
    function hasClaimed(uint256 drawId, address claimant) external view returns (bool) {
        return _claimed[drawId][claimant];
    }

    // ---------------------------------------------------------------------
    // Transaction 1: open
    // ---------------------------------------------------------------------

    /**
     * @notice Open a draw. Commits the register root before any randomness
     *         exists anywhere.
     *
     * @dev WORST-CASE HCU DEPTH: 0 from this contract. `publishRootForDraw` is
     *      ACL work, and `harvest` settles the asset's own ciphertexts. No
     *      symbolic operation is performed here at all, which is the point:
     *      opening a draw must not be able to depend on a lot that does not
     *      exist yet.
     *
     *      The harvested prize is PUBLIC. The brief is explicit that the size
     *      of the pot is not a secret and encrypting it would only remove the
     *      public verifiability the bounty asks for. Who wins it is the secret.
     *
     *      The root is marked publicly decryptable here rather than at drawLot
     *      so that the KMS proof can be fetched off chain in between, keeping
     *      the flow to two transactions.
     */
    function openDraw() external returns (uint256 drawId) {
        if (pool.activeHeight() == 0 && pool.leafHighWater() == 0) revert RegisterEmpty();

        // Public prize, in cUSDT, transferred into this contract.
        uint64 prize = yieldAdapter.harvest(address(this));

        euint64 currentRoot = pool.publishRootForDraw();
        bytes32 handle = euint64.unwrap(currentRoot);
        if (handle == bytes32(0)) revert RegisterEmpty();

        drawId = ++drawCount;

        Draw storage d = _draws[drawId];
        d.rootHandle = handle;
        d.openedAtBlock = block.number;
        d.prize = prize;

        emit DrawOpened(drawId, handle, block.number, prize);
    }

    // ---------------------------------------------------------------------
    // Transaction 2: draw the lot
    // ---------------------------------------------------------------------

    /**
     * @notice Draw the lot and resolve it to a leaf.
     *
     * @dev WORST-CASE HCU DEPTH: 1,177,000 to produce the lot, plus the walk.
     *
     *          FHE.randEuint64()          24,000
     *          FHE.rem(raw, total)     1,153,000   scalar, the expensive part
     *          the walk                  240,250   per level of activeHeight()
     *
     *      The remainder costs more than four levels of descent on its own,
     *      which makes it the single most expensive operation in the protocol.
     *      It is unavoidable: the lot has to land uniformly in [0, totalWeight)
     *      and there is no cheaper reduction that keeps the distribution right.
     *
     *      GLOBAL HCU is the constraint, not depth. The walk's oblivious read
     *      costs 2^h - h - 1 selects, so a draw fits in one transaction up to
     *      about 256 stakes. See the note above `SortisRegister._walk` for why
     *      that bound is a property of hiding the winner rather than of this
     *      implementation.
     *
     *      `totalWeight` is not trusted. `FHE.checkSignatures` verifies that
     *      the KMS actually decrypted the committed root handle to that value,
     *      and reverts otherwise, so a lying operator cannot skew the
     *      denominator to favour a leaf.
     *
     *      The total arrives as the KMS's own ABI-encoded cleartext rather than
     *      as a loose uint64, and the value actually used is decoded FROM the
     *      bytes that were verified. Taking the number and the proof as
     *      separate arguments would let a caller get one thing signed and use
     *      another.
     *
     * @param drawId          The draw to settle.
     * @param abiEncodedTotal The KMS cleartext for `rootHandle`, ABI-encoded.
     * @param decryptionProof KMS proof that `rootHandle` decrypts to it.
     */
    function drawLot(
        uint256 drawId,
        bytes calldata abiEncodedTotal,
        bytes calldata decryptionProof
    ) external {
        Draw storage d = _draws[drawId];
        if (d.openedAtBlock == 0) revert UnknownDraw(drawId);
        if (d.lotDrawn) revert DrawAlreadySettled(drawId);

        // The lot must be produced in a block the opener could not see.
        if (block.number <= d.openedAtBlock) revert SameBlockAsOpen();

        // The register must be exactly the tree that was committed. Handles are
        // content-derived, so any commit or release since the open changes this
        // and voids the draw.
        bytes32 currentHandle = euint64.unwrap(pool.root());
        if (currentHandle != d.rootHandle) revert RegisterMovedSinceOpen(d.rootHandle, currentHandle);

        // Verify the denominator against the KMS rather than trusting it.
        // Reverts on a bad proof, so what follows is a number the KMS signed.
        bytes32[] memory handles = new bytes32[](1);
        handles[0] = d.rootHandle;
        FHE.checkSignatures(handles, abiEncodedTotal, decryptionProof);

        uint256 decoded = abi.decode(abiEncodedTotal, (uint256));
        if (decoded > type(uint64).max) revert TotalWeightOverflow(decoded);
        uint64 totalWeight = uint64(decoded);
        if (totalWeight == 0) revert RegisterEmpty();

        // Native randomness on the host chain. No oracle, no VRF, nothing
        // external to defend.
        //
        // Full-range rand then FHE.rem, exactly as the brief specifies, and NOT
        // the bounded overload: FHE.randEuint64(bound) reverts with
        // NotPowerOfTwo unless the bound is a power of two, and a register's
        // total weight is an arbitrary number.
        //
        // The remainder introduces the usual modulo bias, weighted toward the
        // low end by at most totalWeight / 2^64. For a pool whose weight is
        // measured in token-hours that ratio is around 1e-14, which is far
        // below any bias a participant could exploit or even detect.
        euint64 lot = FHE.rem(FHE.randEuint64(), totalWeight);
        FHE.allowThis(lot);
        FHE.allowTransient(lot, address(pool));

        // Root to leaf, one encrypted comparison per level, index never
        // decrypted.
        euint16 resolved = pool.walkForDraw(lot);
        FHE.allowThis(resolved);

        // The prize as a ciphertext, so the payout can be made in a shape that
        // does not distinguish a winner from anyone else.
        euint64 prizeCiphertext = FHE.asEuint64(d.prize);
        FHE.allowThis(prizeCiphertext);

        d.lotDrawn = true;
        d.totalWeight = totalWeight;
        d.walkHeight = pool.activeHeight();
        d.resolvedLeaf = resolved;
        d.prizeCiphertext = prizeCiphertext;

        emit Drawn(drawId, euint64.unwrap(lot), euint16.unwrap(resolved), totalWeight);
    }

    // ---------------------------------------------------------------------
    // Claim
    // ---------------------------------------------------------------------

    /**
     * @notice Claim a draw. Pays the prize if the caller holds the drawn leaf,
     *         and zero otherwise, without revealing which happened.
     *
     * @dev WORST-CASE HCU DEPTH: 168,000.
     *
     *          FHE.eq(resolvedLeaf, myLeaf)     58,000   euint16, scalar
     *          FHE.select(won, prize, zero)     55,000   depth 113,000
     *          transfer settles the asset               depth 168,000
     *
     *      Constant. It does not depend on the register, the number of stakes,
     *      or how many people have already claimed.
     *
     *      This is where the `FHE.allow` the brief asks for actually happens.
     *      It is scoped to the drawn address, because the only branch that
     *      yields a non-zero amount is the one where the caller's leaf equals
     *      the resolved leaf -- but the scoping is enforced by an encrypted
     *      comparison rather than by an address lookup Solidity cannot do.
     *
     *      Every claimant runs identical code and moves an identically shaped
     *      ciphertext. A loser transfers an encrypted zero. Gas, HCU and the
     *      emitted event are the same either way, so an observer watching the
     *      claims learns the set of people who tried and nothing else. The
     *      winner finds out by decrypting their own balance, which only they
     *      can do.
     *
     *      Claiming is idempotent per address per draw, and the flag is set for
     *      losers too. A flag that only winners set would be a public winner
     *      announcement.
     */
    function claimPrize(uint256 drawId) external {
        Draw storage d = _draws[drawId];
        if (d.openedAtBlock == 0) revert UnknownDraw(drawId);
        if (!d.lotDrawn) revert LotNotDrawn(drawId);
        if (_claimed[drawId][msg.sender]) revert AlreadyClaimed(drawId, msg.sender);

        _claimed[drawId][msg.sender] = true;

        // A caller with no leaf cannot have been drawn. Resolving to leaf 0
        // would be wrong here, so use a sentinel outside the register instead
        // of silently paying leaf 0's owner.
        uint16 callerLeaf = pool.hasLeaf(msg.sender)
            ? uint16(pool.leafOf(msg.sender))
            : type(uint16).max;

        // The comparison is encrypted on one side and plaintext on the other,
        // so this is the scalar overload.
        ebool won = FHE.eq(d.resolvedLeaf, callerLeaf);

        euint64 payout = FHE.select(won, d.prizeCiphertext, FHE.asEuint64(0));
        FHE.allowThis(payout);

        // The grant the brief asks for, scoped to the drawn address: only the
        // caller can decrypt what they were paid.
        FHE.allow(payout, msg.sender);

        FHE.allowTransient(payout, address(asset));
        asset.confidentialTransfer(msg.sender, payout);

        emit PrizeClaimed(drawId, msg.sender);
    }
}
