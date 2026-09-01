"use client";

import { useCallback, useRef, useState } from "react";

/**
 * Client-side FHEVM: encrypting inputs before they are sent, and running the
 * EIP-712 user-decryption flow so a stake owner can read their own numbers.
 *
 * Two things make this awkward enough to be worth wrapping.
 *
 * The relayer SDK instantiates WASM and cannot be imported at module scope in
 * a Next app, because that drags it into the server bundle and breaks the
 * build. It is loaded dynamically, once, on first use.
 *
 * `initSDK()` must finish before `createInstance()`, and the first call pulls
 * 4.6MB of PKE key material from S3 in eu-west-1. That takes about twenty
 * minutes on a cold cache over a slow link and 27 seconds once warm. A spinner
 * that hangs silently for twenty minutes is worse than a slow operation you
 * can watch, so progress is reported rather than swallowed.
 */

type RelayerInstance = Awaited<
  ReturnType<typeof import("@zama-fhe/relayer-sdk/web")["createInstance"]>
>;

export type FhevmPhase =
  | "idle"
  | "loading-sdk"
  | "fetching-keys"
  | "ready"
  | "decrypting"
  | "error";

export type FhevmProgress = {
  phase: FhevmPhase;
  message: string;
};

let instancePromise: Promise<RelayerInstance> | null = null;

const RPC =
  process.env.NEXT_PUBLIC_SEPOLIA_RPC_URL ??
  "https://ethereum-sepolia-rpc.publicnode.com";

function getInstance(
  onProgress: (p: FhevmProgress) => void
): Promise<RelayerInstance> {
  if (instancePromise) return instancePromise;

  instancePromise = (async () => {
    onProgress({ phase: "loading-sdk", message: "Loading the relayer SDK." });
    const { initSDK, createInstance, SepoliaConfig } = await import(
      "@zama-fhe/relayer-sdk/web"
    );

    onProgress({
      phase: "fetching-keys",
      message: "Fetching key material, 4.6 MB. First run only.",
    });
    await initSDK();

    const instance = await createInstance({ ...SepoliaConfig, network: RPC });
    onProgress({ phase: "ready", message: "Relayer ready." });
    return instance;
  })().catch((error) => {
    // Do not cache a failure. A transient relayer timeout should not poison
    // the session for as long as the tab is open, and these time out often
    // enough on a slow link that it matters.
    instancePromise = null;
    throw error;
  });

  return instancePromise;
}

export function useFhevm() {
  const [progress, setProgress] = useState<FhevmProgress>({
    phase: "idle",
    message: "",
  });
  const instanceRef = useRef<RelayerInstance | null>(null);

  const load = useCallback(async () => {
    if (instanceRef.current) return instanceRef.current;
    try {
      const instance = await getInstance(setProgress);
      instanceRef.current = instance;
      setProgress({ phase: "ready", message: "" });
      return instance;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setProgress({
        phase: "error",
        message: `Relayer unreachable. ${message.slice(0, 90)}`,
      });
      throw error;
    }
  }, []);

  /** Encrypt a euint64 amount for `contract`, submitted by `account`. */
  const encryptAmount = useCallback(
    async (contract: string, account: string, amount: bigint) => {
      const instance = await load();
      const input = instance.createEncryptedInput(contract, account);
      input.add64(amount);
      const { handles, inputProof } = await input.encrypt();
      return {
        handle: `0x${Buffer.from(handles[0]).toString("hex")}` as `0x${string}`,
        inputProof: `0x${Buffer.from(inputProof).toString(
          "hex"
        )}` as `0x${string}`,
      };
    },
    [load]
  );

  /**
   * EIP-712 user decryption. The wallet signs a typed-data grant scoped to one
   * contract and a short validity window; the relayer returns the plaintext to
   * this browser only. Nothing is sent to any server of ours, because there is
   * no server of ours in the path.
   */
  const userDecrypt = useCallback(
    async (
      handle: string,
      contract: string,
      account: string,
      signTypedData: (args: {
        domain: Record<string, unknown>;
        types: Record<string, unknown>;
        primaryType: string;
        message: Record<string, unknown>;
      }) => Promise<string>
    ): Promise<bigint> => {
      const instance = await load();

      const keypair = instance.generateKeypair();
      // The SDK takes these as numbers here even though the ABI spells them
      // as strings elsewhere.
      /*
        BACK-DATED A MINUTE, AND IT HAS TO BE.

        The relayer rejects a grant whose startTimestamp is not strictly in the
        past, answering "Validation failed for 1 field: requestValidity" with a
        400. Sending Math.floor(Date.now() / 1000) is "now" by the browser's
        clock and lands on or after "now" by the relayer's, so every decrypt on
        this site failed while the code looked obviously correct.

        Measured against the live relayer: now fails, now minus 60 succeeds,
        and so does every earlier value. A minute is comfortably more skew than
        two clocks will ever disagree by and it costs a minute off the end of a
        window that lasts a day.
      */
      const startTimestamp = Math.floor(Date.now() / 1000) - 60;
      const durationDays = 1;

      const eip712 = instance.createEIP712(
        keypair.publicKey,
        [contract],
        startTimestamp,
        durationDays
      );

      const signature = await signTypedData({
        domain: eip712.domain as unknown as Record<string, unknown>,
        types: {
          UserDecryptRequestVerification:
            eip712.types.UserDecryptRequestVerification,
        },
        primaryType: "UserDecryptRequestVerification",
        message: eip712.message as unknown as Record<string, unknown>,
      });

      const results = await instance.userDecrypt(
        [{ handle, contractAddress: contract }],
        keypair.privateKey,
        keypair.publicKey,
        signature.replace(/^0x/, ""),
        [contract],
        account,
        startTimestamp,
        durationDays
      );

      const value = (results as Record<string, unknown>)[handle];
      return typeof value === "bigint" ? value : BigInt(String(value ?? 0));
    },
    [load]
  );

  /**
   * Publicly decrypt a handle the contract has published, with its KMS proof.
   *
   * This is what turns settling a draw from a keeper-only operation into
   * something the app can do. `drawLot` needs the register's committed total
   * weight as cleartext plus the KMS signatures over it, and
   * `publishRootForDraw` already made that handle publicly decryptable when the
   * draw opened.
   *
   * NO SIGNATURE IS INVOLVED, which is the whole reason this works in a
   * browser. User decryption needs an EIP-712 grant and is subject to the
   * relayer's startTimestamp rule; a public decrypt asks for something the
   * contract has already declared public, so there is no wallet round trip and
   * nothing for a clock to disagree about. Measured against the live relayer at
   * roughly three seconds.
   */
  const publicDecryptWithProof = useCallback(
    async (
      handle: `0x${string}`
    ): Promise<{ abiEncodedClearValues: string; decryptionProof: string }> => {
      const instance = await load();
      setProgress({
        phase: "decrypting",
        message: "Asking the KMS for the published total",
      });
      const result = await instance.publicDecrypt([handle]);
      setProgress({ phase: "idle", message: "" });
      return {
        abiEncodedClearValues: result.abiEncodedClearValues as string,
        decryptionProof: result.decryptionProof as string,
      };
    },
    [load]
  );

  return { progress, load, encryptAmount, userDecrypt, publicDecryptWithProof };
}

/**
 * Truncate a ciphertext handle for display: 0x7f2a…c091.
 *
 * The brand rule: an encrypted value renders as its REAL handle, in IBM Plex
 * Mono, in --seal. Never asterisks, never a lock icon, never a blurred number.
 */
export function truncateHandle(handle: string | null | undefined): string {
  if (!handle) return "not set";
  const hex = handle.startsWith("0x") ? handle.slice(2) : handle;
  if (hex.length <= 8) return `0x${hex}`;
  return `0x${hex.slice(0, 4)}…${hex.slice(-4)}`;
}
