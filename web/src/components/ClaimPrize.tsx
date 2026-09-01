"use client";

import { useCallback, useEffect, useState } from "react";
import {
  useAccount,
  useSwitchChain,
  useWriteContract,
  usePublicClient,
} from "wagmi";

import { DRAW_ABI, POOL_ABI } from "@/lib/abi";
import { DRAW, POOL, publicClient, type DrawRow } from "@/lib/chain";
import { readTxError, SEPOLIA_ID } from "@/lib/guards";
import { useSepolia } from "@/lib/useSepolia";
import shell from "@/components/chrome/AppShell.module.css";

/**
 * Claim a settled draw.
 *
 * The rules ask that a judge be able to connect a wallet and try every feature,
 * and claiming is the payoff of the whole protocol. It existed only in
 * scripts/draw.ts, so the one thing the design is for was the one thing nobody
 * could do from the app.
 *
 * The losing case is named BEFORE the send, not explained after it. A claim
 * that was not drawn succeeds, transfers an encrypted zero, and costs the same
 * gas and the same HCU as one that was. Without saying so first, a judge sends
 * a transaction, watches it succeed, sees no balance change and concludes the
 * app is broken. That indistinguishability is the privacy property, so the
 * moment it is most likely to be read as a bug is the moment to explain it.
 */
export function ClaimPrize({ draw }: { draw: DrawRow | null }) {
  const { address, isConnected } = useAccount();
  const { walletChainId, wrongNetwork, ensureSepolia } = useSepolia();
  const chainId = walletChainId ?? SEPOLIA_ID;
  const { switchChain } = useSwitchChain();
  const { writeContractAsync } = useWriteContract();
  const wagmiClient = usePublicClient();

  const [hasLeaf, setHasLeaf] = useState<boolean | null>(null);
  const [claimed, setClaimed] = useState<boolean | null>(null);
  const [state, setState] = useState<{
    status: "idle" | "pending" | "done" | "failed";
    detail?: string;
  }>({ status: "idle" });

  const drawId = draw?.id ?? null;

  const refresh = useCallback(async () => {
    if (!address || drawId === null) return;
    try {
      const [leaf, already] = await Promise.all([
        publicClient.readContract({
          address: POOL,
          abi: POOL_ABI,
          functionName: "hasLeaf",
          args: [address],
        }),
        publicClient.readContract({
          address: DRAW,
          abi: DRAW_ABI,
          functionName: "hasClaimed",
          args: [drawId, address],
        }),
      ]);
      setHasLeaf(leaf as boolean);
      setClaimed(already as boolean);
    } catch {
      // Unknown, which is not the same as false. The button stays disabled
      // rather than offering a claim that would revert with AlreadyClaimed.
      setHasLeaf(null);
      setClaimed(null);
    }
  }, [address, drawId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const claim = useCallback(async () => {
    if (drawId === null) return;
    setState({ status: "pending", detail: "Checking network" });
    if (!(await ensureSepolia())) {
      setState({
        status: "failed",
        detail:
          "This wallet is not on Sepolia. Sortis is deployed there only, so nothing was sent.",
      });
      return;
    }
    setState({ status: "pending", detail: "Waiting for signature" });
    try {
      const hash = await writeContractAsync({
        chainId: SEPOLIA_ID,
        address: DRAW,
        abi: DRAW_ABI,
        functionName: "claimPrize",
        args: [drawId],
      });
      setState({ status: "pending", detail: "Mining" });
      await wagmiClient?.waitForTransactionReceipt({ hash });
      setState({ status: "done", detail: "Claimed" });
      await refresh();
    } catch (error) {
      setState({ status: "failed", detail: readTxError(error).message });
    }
  }, [drawId, writeContractAsync, wagmiClient, refresh]);

  const settled = Boolean(draw?.lotDrawn);
  const canClaim =
    settled && hasLeaf === true && claimed === false && !wrongNetwork;

  return (
    <section className={shell.panel}>
      <div className={shell.panelHead}>
        <span className={shell.panelLabel}>Claim</span>
        <span className={shell.panelMeta}>
          {draw ? `draw #${draw.id.toString()}` : "no draw"}
        </span>
      </div>
      <div className={shell.panelBody}>
        <div className={shell.kv}>
          <span className={shell.kvKey}>Prize</span>
          <span
            className={shell.kvValue}
            data-tone={draw && draw.prize > 0n ? "brass" : undefined}
          >
            {draw ? `${(Number(draw.prize) / 1e6).toFixed(6)} cUSDT` : "-"}
            {draw && draw.prize === 0n ? (
              <span className={shell.kvAside}>
                nothing had accrued when this draw opened
              </span>
            ) : null}
          </span>

          <span className={shell.kvKey}>Your leaf</span>
          <span className={shell.kvValue}>
            {!isConnected
              ? "connect to read"
              : hasLeaf === null
              ? "could not read"
              : hasLeaf
              ? "in this register"
              : "none, commit first"}
          </span>

          <span className={shell.kvKey}>Weighed at</span>
          <span className={shell.kvValue}>
            {draw ? `hour ${draw.refHour.toString()}` : "-"}
            <span className={shell.kvAside}>
              stakes held before this hour, and only those, could be drawn
            </span>
          </span>

          <span className={shell.kvKey}>Status</span>
          <span className={shell.kvValue}>
            {!settled
              ? "draw not settled"
              : claimed === null
              ? isConnected
                ? "could not read"
                : "connect to read"
              : claimed
              ? "already claimed"
              : "claimable"}
          </span>
        </div>

        {!isConnected ? (
          <p className={shell.note}>Connect a wallet to claim.</p>
        ) : wrongNetwork ? (
          <p className={`${shell.cost} ${shell.fault}`} role="alert">
            Wallet is on chain {chainId}. Sortis is deployed on Sepolia only.
            <button
              type="button"
              className={shell.inlineAction}
              style={{ marginLeft: "var(--s-2)" }}
              onClick={() => switchChain?.({ chainId: SEPOLIA_ID })}
            >
              Switch to Sepolia
            </button>
          </p>
        ) : (
          <>
            <button
              type="button"
              className={shell.button}
              style={{ marginTop: "var(--s-3)" }}
              onClick={claim}
              disabled={state.status === "pending" || !canClaim}
            >
              {state.status === "pending" ? state.detail : "Claim prize"}
            </button>
            <p
              className={`${shell.cost} ${
                state.status === "failed" ? shell.fault : ""
              }`}
            >
              {state.status === "failed" || state.status === "done"
                ? state.detail
                : claimed
                ? "This wallet has already claimed this draw."
                : "Signing this does not tell you whether you won."}
            </p>
          </>
        )}

        {/*
          What a depositor who joined today can and cannot win, said here.

          A stake carries no weight until it has been in the pool a full hour,
          and the walk reads weight at the reference hour captured when the
          draw OPENED. So a deposit made now was worth nothing at the moment
          every already-settled draw was opened, and it cannot win any of them.
          It becomes eligible for a draw opened after its first hour boundary.

          Without saying so, a new depositor claims this draw, the transaction
          succeeds, nothing arrives, and the only available conclusions are
          that they lost or that the app is broken. Neither is right: they were
          never in this draw. That is a property of the anti-snipe rule working
          rather than a failure, and it is only defensible if it is stated
          before they send rather than discovered afterwards.
        */}
        {settled && hasLeaf === true ? (
          <p className={shell.note}>
            If you deposited after this draw opened, or less than an hour before
            it, your stake carried no weight when it was drawn and this claim
            cannot pay. Claiming anyway costs gas and moves an encrypted zero.
            To become eligible, wait for your stake to cross an hour boundary
            and open a draw with the control above. Settling it needs a KMS
            proof fetched off chain, which runs from a keeper script rather than
            from this page, so the operator closes that step.
          </p>
        ) : null}

        {/*
          The whole point, stated before the button rather than after it.
        */}
        <p className={shell.note}>
          Every depositor claims the same way. If you were not drawn this
          transaction still succeeds, transfers an encrypted zero, and costs the
          same gas and the same HCU depth as a winning claim. That is what makes
          a win invisible to anyone watching the chain, and it means a
          successful claim is not evidence you won. Decrypt your balance on{" "}
          <a href="/app/register">Register</a> to find out.
        </p>
      </div>
    </section>
  );
}
