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
export const MEASUREMENT_COMMIT = "b741488";

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

  /** Depth the walk adds per tree level, measured across the sweep. */
  WALK_PER_LEVEL: 774_500,

  /**
   * The walk, measured by sweeping until the transaction reverts. Depth is
   * the binding budget, so this ceiling cannot be raised by splitting the
   * draw across transactions.
   */
  WALK: [
    { stakes: 4, depth: 1_549_000, global: 2_093_192, fits: true },
    { stakes: 8, depth: 2_370_000, global: 3_461_416, fits: true },
    { stakes: 16, depth: 3_098_000, global: 5_269_896, fits: true },
    { stakes: 32, depth: 3_826_000, global: 7_958_888, fits: true },
    { stakes: 64, depth: 4_647_000, global: 12_408_904, fits: true },
    { stakes: 128, depth: 5_421_500, global: 20_373_000, fits: false },
    { stakes: 256, depth: 6_196_000, global: 35_381_000, fits: false },
  ] as const,

  /** The largest register one transaction can draw from. Measured. */
  SHARD_CEILING: 64,

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
