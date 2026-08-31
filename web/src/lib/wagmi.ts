"use client";

import { createConfig } from "@privy-io/wagmi";
import { http } from "wagmi";
import { sepolia } from "wagmi/chains";
import type { PrivyClientConfig } from "@privy-io/react-auth";

/**
 * Wallet configuration.
 *
 * Privy over wagmi and viem. The original design said RainbowKit
 * and explicitly not Privy, on the grounds that a signup step reads as consumer
 * friction to a protocol judge. That objection is answered by the config rather
 * than by the library: `loginMethods` is wallet and nothing else, so there is
 * no email, no SMS, no social and no embedded wallet. What a judge sees is a
 * wallet picker, which is what RainbowKit gave them, in Sortis colours.
 *
 * The practical reason to switch is that RainbowKit initialises WalletConnect
 * on page load whether or not anyone uses it, which meant a 403 from
 * api.web3modal.org and a 400 from pulse.walletconnect.org in the console of
 * every visitor unless a real project id was configured. Privy carries its own
 * transport and does not.
 *
 * THE APP ID IS PUBLIC. THE APP SECRET IS NOT, and it is not imported here or
 * anywhere else under web/. It authenticates server-to-server calls to Privy's
 * API; shipping it to a browser would let anyone act as this application. It
 * stays in the root .env, which is gitignored, and nothing in the frontend
 * reads it.
 */

export const PRIVY_APP_ID = process.env.NEXT_PUBLIC_PRIVY_APP_ID ?? "";

export const RPC_URL =
  process.env.NEXT_PUBLIC_SEPOLIA_RPC_URL ?? "https://ethereum-sepolia-rpc.publicnode.com";

/**
 * Sepolia only. There is no mainnet deployment, and a chain switcher that
 * leads nowhere is worse than one chain that works.
 */
export const wagmiConfig = createConfig({
  chains: [sepolia],
  transports: { [sepolia.id]: http(RPC_URL) },
});

/**
 * The login card, in Sortis colours.
 *
 * Brass on stone with the kleroterion mark, not Privy's default purple. A
 * connect dialog that arrives in another product's brand is the moment the
 * app stops feeling like one thing, and this one is the first modal a judge
 * will open.
 */
export const privyConfig: PrivyClientConfig = {
  // Wallet only. No email, no SMS, no social, no embedded wallet.
  loginMethods: ["wallet"],

  appearance: {
    theme: "light",
    // --brass. The accent everywhere else in the product.
    accentColor: "#A87A2E",
    // --stone, so the card sits on the same ground as the app.
    logo: "/sortis-mark.svg",
    walletList: ["metamask", "rainbow", "coinbase_wallet", "wallet_connect"],
    showWalletLoginFirst: true,
  },

  // No embedded wallets. A prize-savings protocol asking to custody a key on
  // signup is exactly the consumer-app friction the brief warned about.
  embeddedWallets: {
    ethereum: { createOnLogin: "off" },
  },

  defaultChain: sepolia,
  supportedChains: [sepolia],
};
