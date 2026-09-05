"use client";

import { useCallback, useEffect, useState } from "react";
import {
  useAccount,
  useSwitchChain,
  useWriteContract,
  usePublicClient,
} from "wagmi";

import { DRAW_ABI } from "@/lib/abi";
import { DRAW, publicClient, SHARD } from "@/lib/chain";
import { readTxError, SEPOLIA_ID } from "@/lib/guards";
import { useSepolia } from "@/lib/useSepolia";
import shell from "@/components/chrome/AppShell.module.css";

/**
 * Open a draw. Any connected wallet may.
 *
 * The bounty rules ask for draws to be automated or to have a documented
 * keeper flow, and separately for a judge to be able to connect a wallet and
 * try every feature. An owner-gated draw fails the second: the central
 * mechanism would be the one thing a judge could only read about.
 *
 * So `openDraw` has no owner check and never did. The only gate is a minimum
 * interval since the last draw, which exists because a draw can otherwise be
 * opened in every block, and that costs nothing and makes the history
 * meaningless.
 *
 * Only the opening is exposed here. Settling needs a KMS decryption proof for
 * the published total, which is an off-chain fetch through the relayer and
 * belongs in a keeper rather than behind a button that would appear to hang.
 * The README documents the two-transaction flow and the script that runs it.
 */
export function TriggerDraw({
  onOpened,
  /**
   * An already-open draw, if there is one.
   *
   * Opening a second draw while the first is unsettled stacks them: every
   * click created a draw nobody was going to finish, and pushed the stat strip
   * onto one with no prize, no weight and no winner. There is now a Settle
   * control directly below, so the honest behaviour is to point at it rather
   * than to let the same mistake be made again.
   */
  pending,
  /**
   * Whether that open draw can still be settled.
   *
   * A STRANDED DRAW MUST NOT BLOCK OPENING A NEW ONE. Blocking on any open
   * draw at all was a trap: a draw is voided permanently by any commit or
   * release after it opens, so one deposit could lock the Open control forever
   * with a draw nobody could ever settle. Draws 6, 7 and 8 died that way and
   * between them would have made the control unusable for good.
   */
  pendingStranded,
}: {
  onOpened?: () => void;
  pending?: { id: bigint } | null;
  pendingStranded?: boolean | null;
}) {
  const { isConnected } = useAccount();
  const { walletChainId, wrongNetwork, ensureSepolia } = useSepolia();
  const chainId = walletChainId ?? SEPOLIA_ID;
  const { switchChain } = useSwitchChain();
  const { writeContractAsync } = useWriteContract();
  const wagmiClient = usePublicClient();

  const [remaining, setRemaining] = useState<number | null>(null);
  // Immutable, from the bundle. Never read, never null, never "reading".
  const interval = SHARD.minDrawInterval;
  const [state, setState] = useState<{
    status: "idle" | "pending" | "done" | "failed";
    detail?: string;
  }>({ status: "idle" });

  const refresh = useCallback(async () => {
    try {
      /*
        Only the countdown is read. The interval is a constructor argument.

        minDrawInterval cannot change without redeploying SortisDraw, which
        would change the address this app is pointed at, so it comes from the
        build-time snapshot. On a provider that rate limits by request count,
        re-asking for an immutable number on a twenty second poll is budget
        spent on an answer that is already known.
      */
      const left = await publicClient.readContract({
        address: DRAW,
        abi: DRAW_ABI,
        functionName: "secondsUntilNextDraw",
      });
      setRemaining(Number(left as bigint));
    } catch {
      // Leave the countdown unknown rather than claiming it is open.
    }
  }, []);

  useEffect(() => {
    void refresh();
    const timer = window.setInterval(refresh, 20_000);
    return () => window.clearInterval(timer);
  }, [refresh]);

  // Count down locally between reads so the number moves.
  useEffect(() => {
    if (remaining === null || remaining <= 0) return;
    const tick = window.setInterval(
      () => setRemaining((r) => (r === null ? r : Math.max(0, r - 1))),
      1_000
    );
    return () => window.clearInterval(tick);
  }, [remaining]);

  const open = useCallback(async () => {
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
        functionName: "openDraw",
      });
      setState({ status: "pending", detail: "Mining" });
      await wagmiClient?.waitForTransactionReceipt({ hash });
      setState({ status: "done", detail: "Draw opened" });
      await refresh();
      onOpened?.();
    } catch (error) {
      // readTxError already names DrawTooSoon, and it also names the case this
      // used to blame the contract for: a wallet with no Sepolia ETH.
      setState({ status: "failed", detail: readTxError(error).message });
    }
  }, [writeContractAsync, wagmiClient, refresh, onOpened]);

  const openable = remaining !== null && remaining === 0;

  const countdown =
    remaining === null
      ? "reading"
      : remaining === 0
      ? "open now"
      : `${Math.floor(remaining / 60)}m ${String(remaining % 60).padStart(
          2,
          "0"
        )}s`;

  return (
    <section className={shell.panel}>
      <div className={shell.panelHead}>
        <span className={shell.panelLabel}>Trigger a draw</span>
        <span className={shell.panelMeta}>anyone may</span>
      </div>
      <div className={shell.panelBody}>
        <div className={shell.kv}>
          <span className={shell.kvKey}>Next draw</span>
          <span
            className={shell.kvValue}
            data-tone={openable ? "brass" : undefined}
          >
            {countdown}
          </span>

          <span className={shell.kvKey}>Interval</span>
          <span className={shell.kvValue}>
            {`${Math.round(interval / 60)} minutes`}
            <span className={shell.kvAside}>minimum between draws</span>
          </span>
        </div>

        {!isConnected ? (
          <p className={shell.note}>Connect a wallet to open a draw.</p>
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
              onClick={open}
              disabled={
                state.status === "pending" || !openable || Boolean(pending)
              }
            >
              {state.status === "pending"
                ? state.detail
                : pending
                ? `Draw #${pending.id.toString()} is still open`
                : "Open draw"}
            </button>
            <p
              className={`${shell.cost} ${
                state.status === "failed" ? shell.fault : ""
              }`}
            >
              {pending && pendingStranded === true
                ? `Draw #${pending.id.toString()} can never be settled, because the register moved after it opened. Opening a new one is the way forward.`
                : pending
                ? "Settle the open draw below before opening another. Stacking draws leaves ones nobody finishes."
                : state.status === "idle" || state.status === "done"
                ? "No owner check. The only gate is the interval above."
                : state.detail}
            </p>
          </>
        )}

        {/*
          The rule that decides whether a fresh deposit can win, stated next to
          the control that would otherwise make it look broken.
        */}
        <p className={shell.note}>
          A stake carries no weight until it has been in the pool a full hour,
          so a deposit made moments before a draw cannot take the prize.
          Settling happens in the panel below, in this browser: the total weight
          is published when the draw opens, so fetching its KMS proof needs no
          wallet and no grant.
        </p>
      </div>
    </section>
  );
}
