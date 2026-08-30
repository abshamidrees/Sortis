"use client";

import { useState, type ReactNode } from "react";
import { PrivyProvider } from "@privy-io/react-auth";
import { WagmiProvider as PrivyWagmiProvider } from "@privy-io/wagmi";
import { WagmiProvider } from "wagmi";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { PRIVY_APP_ID, privyConfig, wagmiConfig } from "@/lib/wagmi";

/**
 * Wallet and query providers.
 *
 * ORDER MATTERS AND IT BROKE THE BUILD ONCE. QueryClientProvider has to sit
 * OUTSIDE WagmiProvider, because wagmi's hooks run react-query underneath and
 * a provider that mounts first will call them before the client exists. The
 * failure was "No QueryClient set" during prerender, not at runtime, which is
 * the kind of thing a local dev server never shows you.
 *
 * The WagmiProvider from @privy-io/wagmi calls Privy's own hooks internally,
 * so it may only be used inside a PrivyProvider. When the app id is missing
 * this falls back to plain wagmi instead. Using the Privy one there was the
 * second half of the same build failure: "useWallets was called outside the
 * PrivyProvider component".
 *
 * The fallback exists because a missing environment variable should degrade to
 * a page that renders and says it cannot connect, not to a build that fails.
 */
export function Providers({ children }: { children: ReactNode }) {
  const [queryClient] = useState(() => new QueryClient());

  if (!PRIVY_APP_ID) {
    return (
      <QueryClientProvider client={queryClient}>
        <WagmiProvider config={wagmiConfig}>{children}</WagmiProvider>
      </QueryClientProvider>
    );
  }

  return (
    <PrivyProvider appId={PRIVY_APP_ID} config={privyConfig}>
      <QueryClientProvider client={queryClient}>
        <PrivyWagmiProvider config={wagmiConfig}>{children}</PrivyWagmiProvider>
      </QueryClientProvider>
    </PrivyProvider>
  );
}
