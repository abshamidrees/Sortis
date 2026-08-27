/**
 * Every number the site displays, in one place, with its provenance.
 *
 * Section 13 of the brief: every number on the site must be derived from a real
 * call, and a chart drawn from measurements has to say which commit produced
 * them. Nothing here is invented or rounded for effect. Run `npm test` at the
 * repo root to reproduce all of it.
 */

export const REPO_URL = "https://github.com/abshamidrees/Sortis";

/** The commit whose `npm test` run produced the figures below. */
export const MEASUREMENT_COMMIT = "c234b6a";

/** The Sepolia draw that confirmed the mock's accounting. Height 2. */
export const SEPOLIA_CHECK = { height: 2, depth: 2_199_000, mockDepth: 2_199_000 } as const;

export const HCU = {
  /** FHEVM caps the longest dependent chain in one transaction. */
  DEPTH_LIMIT: 5_000_000,
  /** FHEVM caps total work in one transaction. */
  GLOBAL_LIMIT: 20_000_000,

  /**
   * euint64 ciphertext-plus-ciphertext addition. A linear scan accumulates
   * into one running total, so this is the per-depositor cost and the whole
   * scan is a single chain of them.
   */
  ADD_CT_CT: 162_000,

  /**
   * Sequential depth of one commit or release, measured at register sizes
   * 2^4, 2^8, 2^12 and 2^16. Identical at all four: the update folds the sign
   * into the delta once and then adds the same two ciphertexts to every node,
   * so the writes are independent rather than chained.
   */
  UPDATE_DEPTH: 713_000,

  /** Depth the walk alone adds per tree level. See DRAW for what a draw costs. */
  WALK_PER_LEVEL: 774_500,

  /**
   * A COMPLETE DRAW, swept until it reverts. This is the table that sets the
   * shard size.
   *
   * The walk alone fits up to 64 stakes, and reading only that number is how
   * a shard briefly got deployed at a size that could not settle its own
   * draw. `drawLot` reduces the lot modulo the published total before it
   * descends, and `FHE.rem` is a 1,153,000 chain the whole walk then hangs
   * off. Depth is the binding budget and it cannot be checkpointed, so this
   * ceiling is hard.
   */
  DRAW: [
    { stakes: 4, depth: 2_199_000, fits: true },
    { stakes: 8, depth: 3_020_000, fits: true },
    { stakes: 16, depth: 3_748_000, fits: true },
    { stakes: 32, depth: 4_476_000, fits: true },
    { stakes: 64, depth: 5_297_000, fits: false },
  ] as const,

  /** The largest shard a draw can actually settle. Measured, not projected. */
  SHARD_CEILING: 32,

  /** Depth the draw adds per level of the active subtree. */
  DRAW_PER_LEVEL: 728_000,

  /** Measured on a pool over a 2^8 register. */
  COMMIT_DEPTH: 920_000,
  COMMIT_GLOBAL: 4_638_224,
} as const;

/** Where a linear scan crosses the depth limit and the transaction reverts. */
export const LINEAR_SCAN_WALL = Math.floor(HCU.DEPTH_LIMIT / HCU.ADD_CT_CT);

/**
 * Deployed addresses, read from the environment.
 *
 * Deliberately not hardcoded. The brief forbids placeholder data anywhere a
 * real value belongs, so an unset variable renders as "not deployed" rather
 * than as a plausible-looking address that resolves to nothing.
 */
export const ADDRESSES = {
  pool: process.env.NEXT_PUBLIC_POOL_ADDRESS ?? "",
  draw: process.env.NEXT_PUBLIC_DRAW_ADDRESS ?? "",
  cUSDT: process.env.NEXT_PUBLIC_CUSDT_ADDRESS ?? "",
} as const;

export const ETHERSCAN = "https://sepolia.etherscan.io/address/";

/** Public Sepolia RPC, used by the Verify screen so it needs no wallet. */
export const RPC_FALLBACK = "https://ethereum-sepolia-rpc.publicnode.com";
