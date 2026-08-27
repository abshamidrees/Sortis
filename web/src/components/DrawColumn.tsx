"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import styles from "./DrawColumn.module.css";

/**
 * The draw column. The signature element, per docs/BRIEF.md section 6.
 *
 * A kleroterion plate: a channel down the left edge, a column of slots on the
 * right. Each slot is a stake and shows its ciphertext handle in --seal --
 * the real handle, not a lock icon, not asterisks, not a blur. The lot
 * descends the channel as a brass token, ONE LEVEL PER BEAT, sixteen beats for
 * a full-depth register. Each beat eliminates a candidate. One slot survives
 * and turns brass.
 *
 * WHY SIXTEEN BEATS AND ONLY SIXTEEN SLOTS
 * The slots are a window onto the register, not the whole of it. A depth-16
 * register holds 65,536 stakes, and the walk halves the candidate set at every
 * level: 65,536 -> 32,768 -> ... -> 1 in sixteen steps. The readout under the
 * plate counts that down, which is where the O(log N) argument actually lands.
 * Watching sixteen beats resolve 65,536 candidates is the entire pitch, and a
 * linear scan over the same register would need 65,536 of them -- and would
 * revert at about thirty, which is the wall the protocol is built around.
 *
 * The motion is deliberately DISCRETE. The token snaps between levels rather
 * than sliding through them, because each step is a tree level and easing them
 * together would sell a smooth search rather than a logarithmic one.
 */

export type DrawColumnProps = {
  /** Tree depth. Sixteen in production; also the number of beats. */
  levels?: number;
  /** Ciphertext handles, one per visible slot. Generated if omitted. */
  handles?: string[];
  /** Which slot is drawn. Derived from the seed if omitted. */
  resolvedIndex?: number;
  /** Restart after settling. Used by the landing hero. */
  loop?: boolean;
  /** Begin on mount. */
  autoPlay?: boolean;
  /**
   * The decrypted value, shown in place on the drawn slot. Supply this only
   * for the session that actually holds the drawn address -- everyone else
   * keeps looking at the handle, which is the whole disclosure model.
   */
  revealed?: string | null;
  /** Show a replay control. Off for the hero loop, on for the app. */
  showReplay?: boolean;
  onResolve?: (index: number) => void;
  className?: string;
};

/** Number of slot rows drawn on the plate. */
const VISIBLE_SLOTS = 16;

/**
 * Deterministic pseudo-random. Real randomness here would produce different
 * handles on the server and the client and blow up hydration, so everything
 * visual is derived from a seed.
 */
function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A plausible truncated ciphertext handle: 0x7f2a…c091. */
function makeHandle(rand: () => number): string {
  const hex = (n: number) =>
    Array.from({ length: n }, () => "0123456789abcdef"[Math.floor(rand() * 16)]).join("");
  return `0x${hex(4)}…${hex(4)}`;
}

export function DrawColumn({
  levels = 16,
  handles,
  resolvedIndex,
  loop = false,
  autoPlay = true,
  revealed = null,
  showReplay = false,
  onResolve,
  className,
}: DrawColumnProps) {
  const seed = useMemo(() => {
    // Stable across server and client. Derived from the inputs that change the
    // picture, so two columns on one page do not look identical.
    return levels * 7919 + (resolvedIndex ?? 3) * 104729 + (handles?.length ?? 0) * 31;
  }, [levels, resolvedIndex, handles?.length]);

  const generatedHandles = useMemo(() => {
    const rand = mulberry32(seed);
    return Array.from({ length: VISIBLE_SLOTS }, () => makeHandle(rand));
  }, [seed]);

  const slotHandles = handles?.length ? handles.slice(0, VISIBLE_SLOTS) : generatedHandles;

  const winner = useMemo(() => {
    if (resolvedIndex !== undefined) return Math.min(Math.max(resolvedIndex, 0), VISIBLE_SLOTS - 1);
    return Math.floor(mulberry32(seed + 1)() * VISIBLE_SLOTS);
  }, [resolvedIndex, seed]);

  /**
   * The order candidates fall out in. Every slot except the winner, shuffled,
   * so the elimination does not read as a top-to-bottom sweep -- that would
   * look like the linear scan this design exists to argue against.
   */
  const eliminationOrder = useMemo(() => {
    const rand = mulberry32(seed + 2);
    const order = Array.from({ length: VISIBLE_SLOTS }, (_, i) => i).filter((i) => i !== winner);
    for (let i = order.length - 1; i > 0; i--) {
      const j = Math.floor(rand() * (i + 1));
      [order[i], order[j]] = [order[j], order[i]];
    }
    return order;
  }, [seed, winner]);

  // -1 is "not started". Beats run 0..levels-1; the last one resolves.
  const [beat, setBeat] = useState(-1);
  const [reducedMotion, setReducedMotion] = useState(false);
  const [mounted, setMounted] = useState(false);
  const resolveNotified = useRef(false);

  useEffect(() => {
    setMounted(true);
    const query = window.matchMedia("(prefers-reduced-motion: reduce)");
    setReducedMotion(query.matches);
    const listener = (event: MediaQueryListEvent) => setReducedMotion(event.matches);
    query.addEventListener("change", listener);
    return () => query.removeEventListener("change", listener);
  }, []);

  const resolved = beat >= levels - 1;

  // Drive the beats. One timer per beat rather than an interval, so a change of
  // props cannot leave a stale schedule running.
  useEffect(() => {
    if (!mounted || !autoPlay) return;

    // Reduced motion: no descent at all. Jump straight to the resolved state.
    // Not a fast animation, not a crossfade -- the final frame, immediately.
    if (reducedMotion) {
      setBeat(levels - 1);
      return;
    }

    if (beat === -1) {
      const start = window.setTimeout(() => setBeat(0), 240);
      return () => window.clearTimeout(start);
    }

    if (beat < levels - 1) {
      const next = window.setTimeout(() => setBeat((b) => b + 1), 110);
      return () => window.clearTimeout(next);
    }

    if (loop) {
      const restart = window.setTimeout(() => {
        resolveNotified.current = false;
        setBeat(-1);
      }, 2600);
      return () => window.clearTimeout(restart);
    }
  }, [mounted, autoPlay, reducedMotion, beat, levels, loop]);

  useEffect(() => {
    if (resolved && !resolveNotified.current) {
      resolveNotified.current = true;
      onResolve?.(winner);
    }
  }, [resolved, winner, onResolve]);

  const replay = useCallback(() => {
    resolveNotified.current = false;
    setBeat(reducedMotion ? levels - 1 : -1);
  }, [reducedMotion, levels]);

  /** How many slots have fallen out by now. The final beat resolves instead. */
  const eliminatedCount = beat < 0 ? 0 : Math.min(beat, eliminationOrder.length);
  const eliminated = useMemo(
    () => new Set(eliminationOrder.slice(0, eliminatedCount)),
    [eliminationOrder, eliminatedCount],
  );

  /** Candidates left in the real register: 2^levels halved once per beat. */
  const candidatesRemaining = beat < 0 ? 2 ** levels : 2 ** Math.max(0, levels - 1 - beat);

  // While the walk runs, the token tracks the level it is on. When the walk
  // resolves it settles onto the drawn slot. A token that finished at the
  // bottom of the channel while the brass slot sat higher up would read as
  // two unrelated things happening rather than one descent landing.
  const tokenY = resolved ? winner : beat < 0 ? 0 : Math.min(beat, VISIBLE_SLOTS - 1);

  return (
    <div className={className}>
      <div
        className={styles.plate}
        style={{ ["--slot-pitch" as string]: "26px", ["--token-y" as string]: tokenY }}
        role="img"
        aria-label={
          resolved
            ? `Draw resolved. Sixteen levels descended, one slot of ${(2 ** levels).toLocaleString("en-US")} drawn.`
            : `Draw in progress. Level ${Math.max(beat, 0) + 1} of ${levels}.`
        }
      >
        <div className={styles.channel} aria-hidden="true">
          <div className={styles.channelTrack} />
          {Array.from({ length: VISIBLE_SLOTS }, (_, i) => (
            <div
              key={i}
              className={styles.tick}
              style={{ ["--tick-i" as string]: i }}
              data-passed={beat >= 0 && i <= tokenY}
            />
          ))}
          <div className={styles.token} data-resolved={resolved} />
        </div>

        <div className={styles.slots}>
          {slotHandles.map((handle, i) => {
            const isDrawn = resolved && i === winner;
            const state = isDrawn ? "drawn" : eliminated.has(i) ? "eliminated" : "sealed";
            return (
              <div
                key={i}
                className={styles.slot}
                data-state={state}
                data-flash={isDrawn && !reducedMotion}
              >
                <span className={styles.slotIndex}>{i}</span>
                {/* The handle stays put. A drawn slot that the viewer can
                    decrypt shows the value beside it rather than replacing it,
                    so the encrypted identity of the row is never lost. */}
                <span className={styles.slotHandle}>{handle}</span>
                {isDrawn && revealed ? <span className={styles.slotRevealed}>{revealed}</span> : null}
              </div>
            );
          })}
        </div>

        <div className={styles.readout}>
          <span className={styles.readoutLabel}>
            {resolved ? "Resolved" : `Level ${Math.max(beat, 0) + (beat < 0 ? 0 : 1)} of ${levels}`}
          </span>
          <span className={styles.readoutValue} data-resolved={resolved}>
            {candidatesRemaining.toLocaleString("en-US")}
            {candidatesRemaining === 1 ? " candidate" : " candidates"}
          </span>
          {showReplay ? (
            <button type="button" className={styles.replay} onClick={replay}>
              Replay
            </button>
          ) : null}
        </div>
      </div>
    </div>
  );
}

export default DrawColumn;
