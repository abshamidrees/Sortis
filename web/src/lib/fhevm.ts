"use client";

import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Client-side FHEVM: encrypting inputs before they are sent, and running the
 * user-decryption flow so a stake owner can read their own numbers.
 *
 * Two things make this awkward enough to be worth wrapping:
 *
 *   1. The relayer SDK instantiates WASM. It cannot be imported at module
 *      scope in a Next app -- that would drag it into the server bundle and
 *      break the build -- so it is loaded dynamically, once, on first use.
 *   2. `initSDK()` must finish before `createInstance()` is called, and the
 *      instance is expensive enough that it should be built once per session
 *      rather than once per interaction.
 */

type RelayerInstance = Awaited<
  ReturnType<typeof import("@zama-fhe/relayer-sdk/web")["createInstance"]>
>;

let instancePromise: Promise<RelayerInstance> | null = null;

/** Build the relayer instance, once. Safe to await from anywhere. */
export function getFhevmInstance(): Promise<RelayerInstance> {
  if (instancePromise) return instancePromise;

  instancePromise = (async () => {
    const { initSDK, createInstance, SepoliaConfig } = await import("@zama-fhe/relayer-sdk/web");

    // Loads and compiles the WASM. Must complete before createInstance.
    await initSDK();

    return createInstance({
      ...SepoliaConfig,
      network:
        process.env.NEXT_PUBLIC_SEPOLIA_RPC_URL ?? "https://ethereum-sepolia-rpc.publicnode.com",
    });
  })().catch((error) => {
    // Do not cache a failure. A transient relayer timeout should not poison the
    // session for as long as the tab is open.
    instancePromise = null;
    throw error;
  });

  return instancePromise;
}

export type FhevmStatus = "idle" | "loading" | "ready" | "error";

/**
 * Load the relayer instance and report progress, so a screen can say "sealing"
 * rather than appearing to hang while several megabytes of WASM compile.
 */
export function useFhevm() {
  const [status, setStatus] = useState<FhevmStatus>("idle");
  const [error, setError] = useState<Error | null>(null);
  const instanceRef = useRef<RelayerInstance | null>(null);
  const alive = useRef(true);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const load = useCallback(async () => {
    if (instanceRef.current) return instanceRef.current;
    setStatus("loading");
    setError(null);
    try {
      const instance = await getFhevmInstance();
      instanceRef.current = instance;
      if (alive.current) setStatus("ready");
      return instance;
    } catch (caught) {
      const asError = caught instanceof Error ? caught : new Error(String(caught));
      if (alive.current) {
        setError(asError);
        setStatus("error");
      }
      throw asError;
    }
  }, []);

  /** Encrypt a euint64 amount for `contractAddress`, submitted by `userAddress`. */
  const encryptAmount = useCallback(
    async (contractAddress: string, userAddress: string, amount: bigint) => {
      const instance = await load();
      const input = instance.createEncryptedInput(contractAddress, userAddress);
      input.add64(amount);
      const { handles, inputProof } = await input.encrypt();
      return { handle: handles[0], inputProof };
    },
    [load],
  );

  return { status, error, load, encryptAmount, instance: instanceRef };
}

/**
 * Truncate a ciphertext handle for display: 0x7f2a…c091.
 *
 * The brand rule from docs/BRIEF.md section 5: an encrypted value renders as
 * its REAL handle, in IBM Plex Mono, in --seal. Never asterisks, never a lock
 * icon, never a blurred number. Encryption is the default visual state of this
 * product and the interface should look encrypted at rest.
 */
export function truncateHandle(handle: string | null | undefined): string {
  if (!handle) return "—";
  const hex = handle.startsWith("0x") ? handle.slice(2) : handle;
  if (hex.length <= 8) return `0x${hex}`;
  return `0x${hex.slice(0, 4)}…${hex.slice(-4)}`;
}
