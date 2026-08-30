"use client";

import { useState, type ReactNode } from "react";
import { PrivyProvider } from "@privy-io/react-auth";
import { WagmiProvider } from "@privy-io/wagmi";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { PRIVY_APP_ID, privyConfig, wagmiConfig } from "@/lib/wagmi";

/**
 * Wallet and query providers.
 *
 * WagmiProvider comes from @privy-io/wagmi rather than from wagmi itself. It
 * is the same provider with Privy's connector bridged in, so every existing
 * `useAccount`, `useWriteContract` and `useSignTypedData` call keeps working
 * untouched: the register screen did not change at all for this.
 *
 * If the app id is missing the tree still renders. A landing page that throws
 * because a wallet provider is unconfigured is worse than one that shows a
 * connect button which cannot connect, and the app routes say so plainly.
 */
export function Providers({ children }: { children: ReactNode }) {
  const [queryClient] = useState(() => new QueryClient());

  if (!PRIVY_APP_ID) {
    return (
      <WagmiProvider config={wagmiConfig}>
        <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
      </WagmiProvider>
    );
  }

  return (
    <PrivyProvider appId={PRIVY_APP_ID} config={privyConfig}>
      <QueryClientProvider client={queryClient}>
        <WagmiProvider config={wagmiConfig}>{children}</WagmiProvider>
      </QueryClientProvider>
    </PrivyProvider>
  );
}
