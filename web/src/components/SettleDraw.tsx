"use client";

import { useCallback, useEffect, useState } from "react";
import {
  useAccount,
  useSwitchChain,
  useWriteContract,
  usePublicClient,
} from "wagmi";

import { DRAW_ABI } from "@/lib/abi";
import { DRAW, publicClient, type DrawRow } from "@/lib/chain";
import { readTxError, SEPOLIA_ID } from "@/lib/guards";
import { useFhevm } from "@/lib/fhevm";
import { useSepolia } from "@/lib/useSepolia";
import shell from "@/components/chrome/AppShell.module.css";

/**
 * Settle an open draw, from the browser.
 *
 * This was the last thing only a script could do, and it made the app a
 * dead end: opening a draw is permissionless, so any judge could create one,
 * and nobody could finish it. Every click on Open draw left a draw that would
 * sit unsettled forever unless the operator ran a script, and pushed the stat
 * strip onto a draw with no prize, no weight and no winner.
 *
 * It works because `drawLot` needs two things a browser can get. The register's
 * committed total weight is published as a PUBLICLY decryptable handle by
 * `publishRootForDraw` when the draw opens, so asking the KMS for its cleartext
 * and signatures needs no wallet and no EIP-712 grant: it is a public decrypt
 * of something the contract already declared public. That is the difference
 * from reading a balance, which needs a signed grant and is subject to the
 * relayer's startTimestamp rule.
 *
 * The second transaction is then an ordinary write. The lot is produced on
 * chain by FHE.randEuint64 inside drawLot, so no randomness passes through
 * here, and the contract refuses to run in the opening block or if either root
 * handle moved since. Nothing about the security of the draw depends on this
 * component being honest.
 */
export function SettleDraw({
  draw,
  onSettled,
}: {
  draw: DrawRow | null;
  onSettled?: () => void;
}) {
  const { isConnected } = useAccount();
  const { walletChainId, wrongNetwork, ensureSepolia } = useSepolia();
  const chainId = walletChainId ?? SEPOLIA_ID;
  const { switchChain } = useSwitchChain();
  const { writeContractAsync } = useWriteContract();
  const wagmiClient = usePublicClient();
  const { publicDecryptWithProof } = useFhevm();

  const [state, setState] = useState<{
    status: "idle" | "pending" | "done" | "failed";
    detail?: string;
  }>({ status: "idle" });
  const [blocksToGo, setBlocksToGo] = useState<number | null>(null);

  const openedAt = draw?.openedAtBlock ?? null;

  /*
    drawLot reverts in the opening block, so the button waits for the next one.

    That gap is the security argument rather than an implementation detail: the
    root is committed before any randomness exists. Showing the wait as a
    countdown is better than letting someone press a button that will revert.
  */
  useEffect(() => {
    if (openedAt === null) return;
    let alive = true;
    const tick = async () => {
      try {
        const head = await publicClient.getBlockNumber();
        if (!alive) return;
        setBlocksToGo(head > openedAt ? 0 : Number(openedAt - head) + 1);
      } catch {
        // Unknown. The contract enforces it regardless.
      }
    };
    void tick();
    const timer = window.setInterval(tick, 6_000);
    return () => {
      alive = false;
      window.clearInterval(timer);
    };
  }, [openedAt]);

  const settle = useCallback(async () => {
    if (!draw) return;
    setState({ status: "pending", detail: "Checking network" });
    if (!(await ensureSepolia())) {
      setState({
        status: "failed",
        detail:
          "This wallet is not on Sepolia. Sortis is deployed there only, so nothing was sent.",
      });
      return;
    }

    try {
      setState({
        status: "pending",
        detail: "Asking the KMS for the published total",
      });
      const { abiEncodedClearValues, decryptionProof } =
        await publicDecryptWithProof(draw.rootHandle);

      setState({ status: "pending", detail: "Waiting for signature" });
      const hash = await writeContractAsync({
        chainId: SEPOLIA_ID,
        address: DRAW,
        abi: DRAW_ABI,
        functionName: "drawLot",
        args: [
          draw.id,
          abiEncodedClearValues as `0x${string}`,
          decryptionProof as `0x${string}`,
        ],
      });

      setState({ status: "pending", detail: "Descending the register" });
      await wagmiClient?.waitForTransactionReceipt({ hash });
      setState({
        status: "done",
        detail: `Draw #${draw.id.toString()} settled`,
      });
      onSettled?.();
    } catch (error) {
      setState({ status: "failed", detail: readTxError(error).message });
    }
  }, [
    draw,
    ensureSepolia,
    publicDecryptWithProof,
    writeContractAsync,
    wagmiClient,
    onSettled,
  ]);

  if (!draw) return null;

  const tooEarly = blocksToGo !== null && blocksToGo > 0;
  const canSettle =
    isConnected && !wrongNetwork && !tooEarly && state.status !== "pending";

  return (
    <section className={shell.panel}>
      <div className={shell.panelHead}>
        <span className={shell.panelLabel}>Settle the open draw</span>
        <span className={shell.panelMeta}>draw #{draw.id.toString()}</span>
      </div>
      <div className={shell.panelBody}>
        <div className={shell.kv}>
          <span className={shell.kvKey}>Opened</span>
          <span className={shell.kvValue}>
            block {draw.openedAtBlock.toString()}
          </span>

          <span className={shell.kvKey}>Prize</span>
          <span
            className={shell.kvValue}
            data-tone={draw.prize > 0n ? "brass" : undefined}
          >
            {(Number(draw.prize) / 1e6).toFixed(6)} cUSDT
          </span>

          <span className={shell.kvKey}>Randomness</span>
          <span className={shell.kvValue}>
            {tooEarly ? `waits ${blocksToGo} block` : "ready"}
            <span className={shell.kvAside}>
              produced on chain by the next transaction, never here
            </span>
          </span>
        </div>

        {!isConnected ? (
          <p className={shell.note}>Connect a wallet to settle this draw.</p>
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
              onClick={settle}
              disabled={!canSettle}
            >
              {state.status === "pending"
                ? state.detail
                : tooEarly
                ? "Waiting for the next block"
                : "Settle draw"}
            </button>
            <p
              className={`${shell.cost} ${
                state.status === "failed" ? shell.fault : ""
              }`}
            >
              {state.status === "failed" || state.status === "done"
                ? state.detail
                : "Two steps: a public decrypt of the committed total, then one transaction."}
            </p>
          </>
        )}

        <p className={shell.note}>
          The total weight was published when this draw opened, so fetching its
          cleartext and KMS signatures needs no wallet and no grant. The lot
          itself is produced inside the settling transaction by the chain, and
          the contract refuses to run in the opening block or if the register
          moved since. Anyone can do this, and doing it dishonestly is not
          possible.
        </p>
      </div>
    </section>
  );
}
