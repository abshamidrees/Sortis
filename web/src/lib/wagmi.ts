"use client";

import { connectorsForWallets } from "@rainbow-me/rainbowkit";
import {
  injectedWallet,
  metaMaskWallet,
  rainbowWallet,
  walletConnectWallet,
} from "@rainbow-me/rainbowkit/wallets";
import { createConfig, http } from "wagmi";
import { sepolia } from "wagmi/chains";

/**
 * Wallet configuration.
 *
 * RainbowKit over wagmi and viem, not Privy. The brief is explicit: a protocol
 * judge opening the app expects a raw wallet connect, and a signup step reads
 * as consumer-app friction on something meant to look like civic
 * infrastructure.
 *
 * WALLETCONNECT IS OPT-IN, and that is why the console is clean. RainbowKit's
 * `getDefaultConfig` always wires WalletConnect, which then calls
 * api.web3modal.org and pulse.walletconnect.org on page load. Without a real
 * project id those answer 403 and 400, and the errors ship to every visitor.
 * A placeholder id does not make the calls succeed, it just makes them fail
 * quietly enough to miss. So the connector list is built explicitly and
 * WalletConnect only joins it when a real id is configured.
 *
 * Sepolia only. There is no mainnet deployment, and a chain switcher that
 * leads nowhere is worse than one chain that works.
 */

const WALLETCONNECT_PROJECT_ID = process.env.NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID ?? "";

export const RPC_URL =
  process.env.NEXT_PUBLIC_SEPOLIA_RPC_URL ?? "https://ethereum-sepolia-rpc.publicnode.com";

/**
 * With a real project id: the full list, WalletConnect included.
 *
 * Without one: `injectedWallet` alone. Not metaMaskWallet or rainbowWallet
 * either, because both fall back to WalletConnect on a device with no
 * extension and that is exactly the call that 403s. Injected has no
 * WalletConnect dependency at all.
 *
 * `connectorsForWallets` throws on an empty project id whatever the wallet
 * list, so a placeholder is passed to satisfy it. Nothing reaches
 * WalletConnect with it, because nothing in the list speaks WalletConnect.
 */
const wallets = WALLETCONNECT_PROJECT_ID
  ? [
      { groupName: "Installed", wallets: [injectedWallet, metaMaskWallet, rainbowWallet] },
      { groupName: "Other", wallets: [walletConnectWallet] },
    ]
  : [{ groupName: "Installed", wallets: [injectedWallet] }];

export const wagmiConfig = createConfig({
  chains: [sepolia],
  connectors: connectorsForWallets(wallets, {
    appName: "Sortis",
    projectId: WALLETCONNECT_PROJECT_ID || "sortis-injected-only",
  }),
  transports: { [sepolia.id]: http(RPC_URL) },
  ssr: true,
});
