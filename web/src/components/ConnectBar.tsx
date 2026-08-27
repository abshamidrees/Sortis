"use client";

import { ConnectButton } from "@rainbow-me/rainbowkit";

/** Wallet connect. Raw wallet, no signup step -- see lib/wagmi.ts. */
export function ConnectBar() {
  return (
    <div style={{ display: "flex", justifyContent: "flex-start" }}>
      <ConnectButton showBalance={false} chainStatus="icon" accountStatus="address" />
    </div>
  );
}
