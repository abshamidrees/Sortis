"use client";

import { useState, type ReactNode } from "react";
import { WagmiProvider } from "wagmi";
import { RainbowKitProvider, lightTheme } from "@rainbow-me/rainbowkit";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { wagmiConfig } from "@/lib/wagmi";

import "@rainbow-me/rainbowkit/styles.css";

/**
 * Wallet and query providers.
 *
 * RainbowKit is themed down to the Sortis palette rather than left on its
 * defaults. Its stock accent is a saturated blue that collides with --seal,
 * which in this product means "encrypted" -- a connect button in that colour
 * would be reading as a privacy state to anyone who had learned the palette.
 */
export function Providers({ children }: { children: ReactNode }) {
  const [queryClient] = useState(() => new QueryClient());

  return (
    <WagmiProvider config={wagmiConfig}>
      <QueryClientProvider client={queryClient}>
        <RainbowKitProvider
          theme={lightTheme({
            accentColor: "#A87A2E",
            accentColorForeground: "#FBFCFA",
            borderRadius: "small",
            fontStack: "system",
          })}
        >
          {children}
        </RainbowKitProvider>
      </QueryClientProvider>
    </WagmiProvider>
  );
}
