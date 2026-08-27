"use client";

import { getDefaultConfig } from "@rainbow-me/rainbowkit";
import { sepolia } from "wagmi/chains";
import { http } from "wagmi";

/**
 * Wallet configuration.
 *
 * RainbowKit over wagmi and viem, not Privy. The brief is explicit about this:
 * a protocol judge opening the app expects a raw wallet connect, and a signup
 * step reads as consumer-app friction on something that is meant to look like
 * civic infrastructure.
 *
 * Sepolia only. There is no mainnet deployment and offering a chain switcher
 * that leads nowhere is worse than offering one chain that works.
 */

const WALLETCONNECT_PROJECT_ID = process.env.NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID ?? "";

export const RPC_URL =
  process.env.NEXT_PUBLIC_SEPOLIA_RPC_URL ?? "https://ethereum-sepolia-rpc.publicnode.com";

export const wagmiConfig = getDefaultConfig({
  appName: "Sortis",
  projectId: WALLETCONNECT_PROJECT_ID || "sortis-local-dev",
  chains: [sepolia],
  transports: { [sepolia.id]: http(RPC_URL) },
  ssr: true,
});
