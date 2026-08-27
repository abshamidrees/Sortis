/**
 * Every number the site displays, in one place, with its provenance.
 *
 * Section 13 of the brief: every number on the site must be derived from a real
 * call, and if a chart is drawn from measurements it has to say which commit
 * produced them. Nothing here is invented or rounded for effect. Rerun
 * `npm test` at the repo root to reproduce all of it.
 */

export const REPO_URL = "https://github.com/abshamidrees/Sortis";

/** The commit whose `npm test` run produced the figures below. */
export const MEASUREMENT_COMMIT = "69acb43";

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
   * 2^4, 2^8, 2^12 and 2^16. Identical at all four: the update path folds the
   * sign into the delta once and then adds the same ciphertext to every node,
   * so the writes are independent of each other rather than chained.
   */
  UPDATE_DEPTH: 348_000,

  /** Depth the walk adds per tree level, measured between 2^4 and 2^8. */
  WALK_PER_LEVEL: 240_250,
  /** Fixed cost of the walk before any level is descended. */
  WALK_INTERCEPT: 77_032,

  /** Measured. */
  WALK_AT_2_4: 1_038_032,
  WALK_AT_2_8: 1_999_032,
  /** Projected from the measured slope. The global budget stops these running. */
  WALK_AT_2_12: 2_960_032,
  WALK_AT_2_16: 3_921_032,

  /** Measured on a pool over a 2^8 register. */
  COMMIT_DEPTH: 713_000,
  COMMIT_GLOBAL: 2_757_064,
  RELEASE_DEPTH: 713_000,
  RELEASE_GLOBAL: 3_181_096,

  /** Measured: a draw on a production-depth register holding five stakes. */
  DRAW_DEPTH_AT_5_STAKES: 1_998_000,
  DRAW_GLOBAL_AT_5_STAKES: 2_837_192,
} as const;

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
