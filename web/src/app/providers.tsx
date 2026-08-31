"use client";

import { useEffect, useState, type ReactNode } from "react";
import { useAccount } from "wagmi";
import { PrivyProvider, usePrivy, useWallets } from "@privy-io/react-auth";
import {
  WagmiProvider as PrivyWagmiProvider,
  useSetActiveWallet,
} from "@privy-io/wagmi";
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
/**
 * Hand Privy's restored wallet to wagmi.
 *
 * Privy and wagmi keep separate ideas of who is connected. Privy restores its
 * session from storage on load, so `usePrivy().authenticated` is true again
 * after a refresh, but the wagmi connector is not reconnected and
 * `useAccount()` reports nobody. The nav reads Privy and the screens read
 * wagmi, so the app showed a connected address in the header and "not
 * connected" in the position panel at the same time, and the only way out was
 * to disconnect and connect again.
 *
 * Setting the active wallet whenever Privy has one and wagmi does not closes
 * that gap on every load, not just after an explicit login.
 *
 * This mounts ONLY inside PrivyProvider. useWallets outside it is the build
 * failure described above, and there is nothing to bridge in the fallback
 * branch anyway, where plain wagmi is the only connector.
 */
function WalletBridge({ children }: { children: ReactNode }) {
  const { ready, authenticated } = usePrivy();
  const { wallets } = useWallets();
  const { setActiveWallet } = useSetActiveWallet();
  const { address, isConnected } = useAccount();

  /*
    Only bridge a session Privy has already restored.

    Ungated, this ran before Privy finished loading, and attaching a wallet
    that was not connected yet asked the user to connect again on every
    refresh. `ready` is Privy saying it has finished deciding;
    `authenticated` is Privy saying there is a session to hand over. Without
    both, there is nothing to bridge and prompting is the wrong answer.
  */
  const wallet = ready && authenticated ? wallets[0] : undefined;

  /*
    Keyed on the ADDRESS, not on the wallet object.

    useWallets returns a fresh array on every render, so depending on it would
    re-run this effect on every render and call setActiveWallet in a loop
    against the connector. The address is a primitive and only changes when the
    thing we care about changes.
  */
  const privyAddress = wallet?.address;
  const attached =
    isConnected && address?.toLowerCase() === privyAddress?.toLowerCase();

  useEffect(() => {
    if (!ready || !authenticated || !wallet || attached) return;
    void setActiveWallet(wallet).catch(() => {
      // A wallet that will not attach leaves the screens reading "not
      // connected", which is the honest state rather than a false positive.
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, authenticated, privyAddress, attached, setActiveWallet]);

  return <>{children}</>;
}

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
        <PrivyWagmiProvider config={wagmiConfig}>
          <WalletBridge>{children}</WalletBridge>
        </PrivyWagmiProvider>
      </QueryClientProvider>
    </PrivyProvider>
  );
}
