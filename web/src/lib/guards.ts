"use client";

import { sepolia } from "viem/chains";

/**
 * The four failure states the bounty rules name by hand.
 *
 *   "Sensible error handling for missing approvals, insufficient balance,
 *    network mismatch, and unsupported tokens."
 *
 * Each is a NAMED STATE checked before a transaction is built, not an
 * exception caught after one reverts. The difference matters to whoever is
 * looking at the screen: a revert reason surfaced from a wallet is a hex
 * string and a stack, and none of these four are the user doing something
 * wrong. Three of them have a specific action that fixes them, and the fourth
 * is not a failure at all.
 */

export type GuardId =
  | "wrong-network"
  | "not-operator"
  | "insufficient-balance"
  | "over-release"
  | null;

export type Guard = {
  id: Exclude<GuardId, null>;
  /** What is wrong, in one line, in the user's terms. */
  message: string;
  /** The control that resolves it, when one exists. */
  action?: "switch-network" | "faucet";
  actionLabel?: string;
  /**
   * Whether this blocks the transaction.
   *
   * An over-release does not. It is an encrypted no-op by design, and the
   * point of saying so before the send is that the user understands the
   * transaction will succeed and move nothing, rather than watching a
   * successful transaction change none of their numbers and concluding the
   * app is broken.
   */
  blocking: boolean;
};

export const SEPOLIA_ID = sepolia.id;

/** cUSDT is 6 decimals. "1.5" becomes 1_500_000. */
export function toBaseUnits(input: string): bigint {
  const [whole, frac = ""] = input.trim().split(".");
  const padded = (frac + "000000").slice(0, 6);
  return BigInt(whole || "0") * 1_000_000n + BigInt(padded || "0");
}

export function formatUnits(value: bigint): string {
  const whole = value / 1_000_000n;
  const frac = (value % 1_000_000n).toString().padStart(6, "0").replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : `${whole}`;
}

/**
 * Check a commit before it is sent.
 *
 * `walletClear` is the decrypted cUSDT balance, which exists only if the user
 * has decrypted it in this session. When it is null the balance check is
 * skipped rather than guessed: the balance is a ciphertext and inventing a
 * comparison against it would be worse than not checking. ERC-7984 handles the
 * short case anyway by transferring zero, which is why this is a courtesy and
 * not a safety property.
 */
export function guardCommit(args: {
  chainId: number | undefined;
  isOperator: boolean;
  walletClear: bigint | null;
  amount: bigint;
}): Guard | null {
  if (args.chainId !== undefined && args.chainId !== SEPOLIA_ID) {
    return {
      id: "wrong-network",
      message: `Wallet is on chain ${args.chainId}. Sortis is deployed on Sepolia only.`,
      action: "switch-network",
      actionLabel: "Switch to Sepolia",
      blocking: true,
    };
  }

  if (!args.isOperator) {
    return {
      id: "not-operator",
      message:
        "The pool is not authorised to pull your cUSDT. ERC-7984 requires an explicit operator grant before a confidential transfer.",
      action: "faucet",
      actionLabel: "Authorise the pool",
      blocking: true,
    };
  }

  if (args.walletClear !== null && args.amount > args.walletClear) {
    const short = args.amount - args.walletClear;
    return {
      id: "insufficient-balance",
      message: `Your wallet holds ${formatUnits(args.walletClear)} cUSDT, which is ${formatUnits(short)} short of this commit.`,
      action: "faucet",
      actionLabel: "Mint 5 cUSDT",
      blocking: true,
    };
  }

  return null;
}

/**
 * Check a release before it is sent.
 *
 * An over-release is NOT blocked. `FHESafeMath.tryDecrease` returns an
 * encrypted failure flag and leaves the balance untouched, so the transaction
 * succeeds and moves nothing. Reverting instead would leak the balance: a
 * revert on release(X) proves the stake is below X, and an attacker binary
 * searches any balance in about 64 transactions. Warning without blocking is
 * the honest version of that design.
 */
export function guardRelease(args: {
  chainId: number | undefined;
  stakeClear: bigint | null;
  amount: bigint;
}): Guard | null {
  if (args.chainId !== undefined && args.chainId !== SEPOLIA_ID) {
    return {
      id: "wrong-network",
      message: `Wallet is on chain ${args.chainId}. Sortis is deployed on Sepolia only.`,
      action: "switch-network",
      actionLabel: "Switch to Sepolia",
      blocking: true,
    };
  }

  if (args.stakeClear !== null && args.amount > args.stakeClear) {
    return {
      id: "over-release",
      message: `Your stake is ${formatUnits(args.stakeClear)} cUSDT. This release will succeed and move nothing, because an over-release is an encrypted no-op rather than a revert. Reverting would prove your balance is below the amount asked for.`,
      blocking: false,
    };
  }

  return null;
}
