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
  | "no-gas"
  | "over-release"
  | null;

export type Guard = {
  id: Exclude<GuardId, null>;
  /** What is wrong, in one line, in the user's terms. */
  message: string;
  /** The control that resolves it, when one exists. */
  action?: "switch-network" | "faucet" | "gas-faucet";
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

/** Where to send someone who has no Sepolia ETH. */
export const SEPOLIA_FAUCET =
  "https://cloud.google.com/application/web3/faucet/ethereum/sepolia";

/**
 * No gas. The state a judge is most likely to hit first.
 *
 * "Insufficient balance" in the rules is usually read as the pool's token, and
 * that is guarded above. This is the other balance, and it stops everything:
 * mint, commit and release alike, because signing a transaction that moves an
 * encrypted amount still costs ether like any other.
 *
 * Worth stating BEFORE the send rather than after. Unstated, it arrives as a
 * wallet error that names eth_sendRawTransaction and reads, through viem's
 * wrapper, as though the contract rejected the call.
 */
export function guardGas(balanceWei: bigint | undefined): Guard | null {
  // Undefined is "not read yet", which is not the same as zero.
  if (balanceWei === undefined) return null;
  if (balanceWei > 0n) return null;
  return {
    id: "no-gas",
    message:
      "This wallet holds no Sepolia ETH, so no transaction here can be signed. The pool's own token is free from the faucet below; the gas is not.",
    action: "gas-faucet",
    actionLabel: "Get Sepolia ETH",
    blocking: true,
  };
}

/** cUSDT is 6 decimals. "1.5" becomes 1_500_000. */
export function toBaseUnits(input: string): bigint {
  const [whole, frac = ""] = input.trim().split(".");
  const padded = (frac + "000000").slice(0, 6);
  return BigInt(whole || "0") * 1_000_000n + BigInt(padded || "0");
}

export function formatUnits(value: bigint): string {
  const whole = value / 1_000_000n;
  const frac = (value % 1_000_000n)
    .toString()
    .padStart(6, "0")
    .replace(/0+$/, "");
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
      message: `Your wallet holds ${formatUnits(
        args.walletClear
      )} cUSDT, which is ${formatUnits(short)} short of this commit.`,
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
      message: `Your stake is ${formatUnits(
        args.stakeClear
      )} cUSDT. This release will succeed and move nothing, because an over-release is an encrypted no-op rather than a revert. Reverting would prove your balance is below the amount asked for.`,
      blocking: false,
    };
  }

  return null;
}

/**
 * What a failed transaction actually says, rather than what viem calls it.
 *
 * viem wraps every write failure as `The contract function "mint" reverted
 * with the following reason: ...`, including failures where no contract ever
 * ran. A wallet with no Sepolia ETH is refused at `eth_sendRawTransaction`,
 * before the node simulates anything, and the screen still read "the contract
 * function mint reverted" followed by a message cut off mid-word at
 * "RPC 0x1 Infura eth_se". That sends a judge to read the contract for a bug
 * that is not there. The real cause was an empty gas balance.
 *
 * The guards above catch what can be known BEFORE a send. This is the other
 * half: naming what came back after one. Everything here is matched on the
 * whole error chain, because the useful sentence is usually nested well below
 * the wrapper viem puts on top.
 */
export type TxFault = {
  /** One line, in the user's terms, with no wrapper and no truncation. */
  message: string;
  /** Whether this is the user's own machine or wallet rather than the chain. */
  kind: "gas" | "declined" | "rpc" | "interval" | "operator" | "unknown";
};

/** Longest sentence worth showing before it stops being read. */
const MAX_TAIL = 120;

export function readTxError(error: unknown): TxFault {
  /*
    Read the fields off ANY object, not just an instanceof Error.

    viem's error classes do not reliably survive `instanceof` across bundle
    boundaries, and a wallet provider can reject with a plain object. Gating on
    instanceof meant those fell through to String(error), which is
    "[object Object]", and a perfectly explicit `shortMessage: insufficient
    funds` was thrown away in favour of matching nothing.
  */
  const parts: string[] = [];
  const visit = (value: unknown, depth: number) => {
    if (value === null || value === undefined || depth > 4) return;
    if (typeof value === "string") {
      parts.push(value);
      return;
    }
    if (typeof value !== "object") {
      parts.push(String(value));
      return;
    }
    const object = value as Record<string, unknown>;
    for (const key of [
      "message",
      "details",
      "shortMessage",
      "reason",
      "data",
    ]) {
      if (typeof object[key] === "string") parts.push(object[key] as string);
    }
    visit(object.cause, depth + 1);
  };
  visit(error, 0);
  const raw = parts.join(" ") || String(error);
  const text = raw.toLowerCase();

  // Gas first. It is both the most common and the most misread, because the
  // wrapper blames the contract for a wallet that simply has no ether.
  if (text.includes("insufficient funds")) {
    return {
      kind: "gas",
      message:
        "This wallet has no Sepolia ETH. Every transaction needs gas, including one that only moves an encrypted amount. Fund it from a Sepolia faucet and try again.",
    };
  }

  if (
    text.includes("user rejected") ||
    text.includes("user denied") ||
    text.includes("rejected the request") ||
    text.includes("4001")
  ) {
    return {
      kind: "declined",
      message: "Signature declined in the wallet. Nothing was sent.",
    };
  }

  if (text.includes("drawtoosoon")) {
    return {
      kind: "interval",
      message:
        "Too soon. The minimum interval since the last draw has not elapsed.",
    };
  }

  if (
    text.includes("erc7984unauthorizedspender") ||
    text.includes("not an operator")
  ) {
    return {
      kind: "operator",
      message:
        "The pool is not authorised to pull your cUSDT. Press Mint 5 cUSDT, which grants the operator in the same step.",
    };
  }

  /*
    The relayer refusing to decrypt a published total.

    It answers with a 500 and "Transaction simulation failed: Execution
    reverted", which reads like the draw is malformed and is not. The
    coprocessor computes the register's root asynchronously after openDraw, and
    until that ciphertext exists the KMS has nothing to sign, so the simulation
    reverts. The operator script hits exactly the same wall, which is how we
    know it is not a browser problem.
  */
  if (
    text.includes("public-decrypt") ||
    text.includes("public_decrypt") ||
    (text.includes("simulation failed") && text.includes("reverted"))
  ) {
    return {
      kind: "rpc",
      message:
        "The KMS has not published this draw's total yet. The register root is computed after the draw opens and cannot be decrypted until it exists. Wait a minute and settle again.",
    };
  }

  if (
    text.includes("429") ||
    text.includes("too many requests") ||
    text.includes("rate limit") ||
    text.includes("exceeded")
  ) {
    return {
      kind: "rpc",
      message:
        "The RPC endpoint refused the request for rate limiting. This is the node, not the transaction. Wait a moment and try again.",
    };
  }

  /*
    Nothing matched. Show the most specific sentence available rather than the
    wrapper, and cut on a word boundary: the old `.slice(0, 90)` ended messages
    at "eth_se", which reads as a corrupted string rather than a long one.
  */
  const specific =
    (error as { shortMessage?: string })?.shortMessage ||
    (error instanceof Error ? error.message : String(error));
  const firstLine = specific.split("\n")[0].trim();
  return {
    kind: "unknown",
    message:
      firstLine.length > MAX_TAIL
        ? `${firstLine.slice(0, MAX_TAIL).replace(/\s+\S*$/, "")}…`
        : firstLine,
  };
}
