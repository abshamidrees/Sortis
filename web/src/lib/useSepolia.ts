"use client";

import { useCallback } from "react";
import { useAccount, useSwitchChain } from "wagmi";

import { SEPOLIA_ID } from "./guards";

/**
 * The wallet's ACTUAL chain, and a way to move it to Sepolia.
 *
 * THIS EXISTS BECAUSE THE APP SENT A TRANSACTION TO ETHEREUM MAINNET.
 *
 * Two bugs compounded. Every screen detected the network with `useChainId()`,
 * which reports the chain the wagmi CONFIG is pointed at, not the chain the
 * wallet is on. `wagmiConfig` lists exactly one chain, so `useChainId()`
 * returned 11155111 permanently and the "wrong network" state was unreachable
 * by construction: the app was reading its own configuration and calling it an
 * observation.
 *
 * Then `writeContractAsync` was called without a `chainId`, which means wagmi
 * signs on whatever chain the wallet happens to be on. With detection broken
 * and the write unpinned, a wallet sitting on mainnet got a real mainnet
 * transaction addressed to a contract that only exists on Sepolia, and the
 * header cheerfully read SEPOLIA the whole time.
 *
 * `useAccount().chainId` is the connector's chain, which is the one that
 * matters. Pinning `chainId` on every write is the belt to that braces: even
 * if detection were wrong again, wagmi refuses to sign on the wrong chain
 * rather than sending value somewhere it cannot be used.
 */
export function useSepolia() {
  const { chainId: walletChainId, isConnected } = useAccount();
  const { switchChainAsync } = useSwitchChain();

  const onSepolia = walletChainId === SEPOLIA_ID;
  const wrongNetwork = isConnected && walletChainId !== undefined && !onSepolia;

  /**
   * Move the wallet to Sepolia, and say whether it worked.
   *
   * Called before a write rather than offered as a button the user has to find.
   * A judge who has to notice a banner, press a switch, and then press the
   * thing they wanted has been given a puzzle instead of an app.
   */
  const ensureSepolia = useCallback(async (): Promise<boolean> => {
    if (onSepolia) return true;
    try {
      await switchChainAsync({ chainId: SEPOLIA_ID });
      return true;
    } catch {
      // Declined, or the wallet has no Sepolia entry. Either way the caller
      // must not send: the contracts do not exist anywhere else.
      return false;
    }
  }, [onSepolia, switchChainAsync]);

  return { walletChainId, onSepolia, wrongNetwork, ensureSepolia };
}
