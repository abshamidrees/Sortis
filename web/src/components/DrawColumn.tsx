"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import styles from "./DrawColumn.module.css";

/**
 * The draw column. The signature element, per docs/BRIEF.md section 6.
 *
 * A kleroterion plate: a channel down the left edge, a column of slots on the
 * right. Each slot is a stake and shows its ciphertext handle in --seal, the
 * real handle, not a lock icon, not asterisks, not a blur. The lot descends
 * the channel as a brass token, ONE LEVEL PER BEAT, and each beat halves what
 * is left. One slot survives and turns brass.
 *
 * IT SHOWS A WHOLE SHARD, NOT A SAMPLE OF ONE. A shard holds 2^levels stakes
 * and that is exactly how many slots are drawn, so the halving on screen is
 * the halving in the register rather than an illustration of it. At the
 * shipped shard size of 64 that is six beats: 64, 32, 16, 8, 4, 2, 1.
 *
 * The motion is deliberately DISCRETE. The token snaps between levels rather
 * than sliding through them, because each step is a tree level and easing them
 * together would sell a smooth search rather than a logarithmic one.
 */

export type DrawColumnProps = {
  /** Tree height. A shard is 6, which is 64 stakes and six beats. */
  levels?: number;
  /** Ciphertext handles, one per slot. Generated if omitted. */
  handles?: string[];
  /** Which slot is drawn. Derived from the seed if omitted. */
  resolvedIndex?: number;
  /** Restart after settling. Used by the landing hero. */
  loop?: boolean;
  /** Begin on mount. */
  autoPlay?: boolean;
  /**
   * The decrypted value, shown in place on the drawn slot. Supply this only
   * for the session that holds the drawn address. Everyone else keeps looking
   * at the handle, which is the whole disclosure model.
   */
  revealed?: string | null;
  /** Show a replay control. Off for the hero loop, on for the app. */
  showReplay?: boolean;
  onResolve?: (index: number) => void;
  className?: string;
};

/** Beat length, matching --beat in the token file. */
const BEAT_MS = 110;

/**
 * Deterministic pseudo-random. Real randomness here would produce different
 * handles on the server and the client and break hydration, so everything
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
function makeHandle(rand: () => number, short: boolean): string {
  const hex = (n: number) =>
    Array.from({ length: n }, () => "0123456789abcdef"[Math.floor(rand() * 16)]).join("");
  return short ? `0x${hex(3)}…${hex(3)}` : `0x${hex(4)}…${hex(4)}`;
}

export function DrawColumn({
  levels = 6,
  handles,
  resolvedIndex,
  loop = false,
  autoPlay = true,
  revealed = null,
  showReplay = false,
  onResolve,
  className,
}: DrawColumnProps) {
  const slotCount = 2 ** levels;

  /**
   * A real kleroterion had several columns of slots cut into one slab, and a
   * shard needs them for the same reason the Athenians did. Slots fill
   * column-major, so the index order runs down the first column and continues
   * down the second, and the surviving range stays contiguous on screen. The
   * first halving keeps exactly one column, which is the clearest frame of the
   * whole animation.
   *
   * The threshold is 16 rather than 32 because a single tall column stretches
   * each row across the full width of the plate, and a drawn slot then reads
   * as a banner rather than as a slot.
   */
  const columns = slotCount > 16 ? 2 : 1;
  const rows = Math.ceil(slotCount / columns);
  const pitch = rows > 24 ? 17 : rows > 16 ? 20 : 26;
  const compact = pitch < 24;

  const seed = useMemo(
    () => levels * 7919 + (resolvedIndex ?? 3) * 104729 + (handles?.length ?? 0) * 31,
    [levels, resolvedIndex, handles?.length],
  );

  const generatedHandles = useMemo(() => {
    const rand = mulberry32(seed);
    return Array.from({ length: slotCount }, () => makeHandle(rand, compact));
  }, [seed, slotCount, compact]);

  const slotHandles = handles?.length ? handles.slice(0, slotCount) : generatedHandles;

  const winner = useMemo(() => {
    if (resolvedIndex !== undefined) return Math.min(Math.max(resolvedIndex, 0), slotCount - 1);
    return Math.floor(mulberry32(seed + 1)() * slotCount);
  }, [resolvedIndex, seed, slotCount]);

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

  useEffect(() => {
    if (!mounted || !autoPlay) return;

    // Reduced motion: no descent at all. The resolved frame, immediately. Not
    // a faster animation and not a crossfade.
    if (reducedMotion) {
      setBeat(levels - 1);
      return;
    }

    if (beat === -1) {
      const start = window.setTimeout(() => setBeat(0), 240);
      return () => window.clearTimeout(start);
    }
    if (beat < levels - 1) {
      const next = window.setTimeout(() => setBeat((b) => b + 1), BEAT_MS);
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

  /**
   * The surviving range after `beat` halvings. This is the real binary search:
   * at each level the half that does not contain the drawn leaf is discarded,
   * which is exactly what `_walk` does with an encrypted comparison.
   */
  const surviving = useMemo(() => {
    if (beat < 0) return { lo: 0, hi: slotCount };
    let lo = 0;
    let hi = slotCount;
    for (let k = 0; k <= beat && hi - lo > 1; k++) {
      const mid = (lo + hi) >> 1;
      if (winner < mid) hi = mid;
      else lo = mid;
    }
    return { lo, hi };
  }, [beat, slotCount, winner]);

  /** Candidates left in the shard. Halves once per beat, 64 down to 1. */
  const candidatesRemaining = beat < 0 ? slotCount : Math.max(1, surviving.hi - surviving.lo);

  // While the walk runs the token tracks the level it is on. When it resolves
  // it settles onto the drawn slot, because a token that finished at the
  // bottom of the channel while the brass slot sat higher up would read as two
  // unrelated things rather than one descent landing.
  // The channel spans the plate's height, which is `rows` tall regardless of
  // how many columns the slots are cut into, so the token is positioned in row
  // units. On resolution it settles level with the drawn slot's row.
  const tokenY = resolved
    ? winner % rows
    : beat < 0
      ? 0
      : Math.min(Math.round(((beat + 1) / levels) * (rows - 1)), rows - 1);

  return (
    <div className={className}>
      <div
        className={styles.plate}
        data-compact={compact}
        style={{
          ["--slot-pitch" as string]: `${pitch}px`,
          ["--slot-rows" as string]: rows,
          ["--token-y" as string]: tokenY,
        }}
        role="img"
        aria-label={
          resolved
            ? `Draw resolved. ${levels} levels descended, one slot of ${slotCount} drawn.`
            : `Draw in progress. Level ${Math.max(beat, 0) + 1} of ${levels}, ${candidatesRemaining} candidates left.`
        }
      >
        <div className={styles.channel} aria-hidden="true">
          <div className={styles.channelTrack} />
          {Array.from({ length: levels }, (_, i) => (
            <div
              key={i}
              className={styles.tick}
              style={{
                ["--tick-i" as string]: Math.round((i / Math.max(levels - 1, 1)) * (rows - 1)),
              }}
              data-passed={beat >= 0 && i <= beat}
            />
          ))}
          <div className={styles.token} data-resolved={resolved} />
        </div>

        <div className={styles.slots} data-columns={columns}>
          {slotHandles.map((handle, i) => {
            const isDrawn = resolved && i === winner;
            const alive = i >= surviving.lo && i < surviving.hi;
            const state = isDrawn ? "drawn" : alive ? "sealed" : "eliminated";
            return (
              <div
                key={i}
                className={styles.slot}
                data-state={state}
                data-flash={isDrawn && !reducedMotion}
              >
                {compact ? null : <span className={styles.slotIndex}>{i}</span>}
                {/* The handle stays put. A drawn slot the viewer can decrypt
                    shows the value beside it rather than replacing it, so the
                    encrypted identity of the row is never lost. */}
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
            {candidatesRemaining === 1 ? " stake" : " stakes"}
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
