"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";

import { AppShell } from "@/components/chrome/AppShell";
import { DrawColumn } from "@/components/DrawColumn";
import { TriggerDraw } from "@/components/TriggerDraw";
import { ETHERSCAN, HCU } from "@/lib/measurements";
import type { Slot } from "@/lib/chain";
import {
  CONFIGURED,
  readDrawHistory,
  readDrawnEvent,
  readShardState,
  readSlotHandles,
  truncate,
  type DrawRow,
  type ShardState,
} from "@/lib/chain";
import shell from "@/components/chrome/AppShell.module.css";

/**
 * /app. The draw route.
 *
 * No headline, no paragraph. Under /app, prose is a bug: this route is the
 * plate, a key-value grid for the current draw, and a table of every draw so
 * far. Everything reads from Sepolia.
 */

type Filter = "all" | "drawn" | "open";

/**
 * An unoccupied register slot.
 *
 * A middot, not an em dash. The craft standard bans em dashes everywhere, the
 * UI included, and a middot reads as "this slot exists and holds nothing"
 * rather than as a missing value.
 */
const EMPTY_SLOT = "·";

/**
 * How a lot handle reads.
 *
 * Three distinct cases, and collapsing the last two is what put "not drawn"
 * next to a badge reading "drawn": a lot that does not exist yet, a lot that
 * exists and whose handle the RPC would not serve, and a lot whose handle we
 * have. Only the first is "not drawn".
 */
function lotHandleText(row: DrawRow): string {
  if (!row.lotDrawn) return "not drawn";
  if (!row.lotHandle) return "drawn, handle unavailable from this RPC";
  return truncate(row.lotHandle);
}

export function DrawScreen() {
  const [state, setState] = useState<ShardState | null>(null);
  const [history, setHistory] = useState<DrawRow[]>([]);
  const [slots, setSlots] = useState<(Slot | null)[]>([]);
  const [filter, setFilter] = useState<Filter>("all");
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (!CONFIGURED) return;
    let alive = true;

    (async () => {
      try {
        const next = await readShardState();
        if (!alive) return;
        setState(next);

        // The lot handle comes from the Drawn event and is rendered only here,
        // so it is fetched here rather than by the stat strip, which paid for
        // a log scan on every poll of every route to carry a value it never
        // showed.
        if (next.current) {
          void readDrawnEvent(next.current.id).then((drawn) => {
            if (!alive || !drawn) return;
            setState((prev) =>
              prev?.current
                ? {
                    ...prev,
                    current: { ...prev.current, lotHandle: drawn.lot, drawnAtBlock: drawn.block },
                  }
                : prev,
            );
          });
        }

        const [rows, handles] = await Promise.all([
          next.drawCount > 0n ? readDrawHistory(next.drawCount) : Promise.resolve([]),
          readSlotHandles(next.capacity),
        ]);
        if (!alive) return;
        setHistory(rows);
        setSlots(handles);
      } catch {
        if (alive) setFailed(true);
      }
    })();

    return () => {
      alive = false;
    };
  }, []);

  /**
   * The column's slots, as REAL ciphertext handles read from the chain.
   *
   * An empty leaf renders as a dash rather than as a fabricated handle. The
   * craft standard forbids placeholder data anywhere a real value belongs, and
   * a register that is one third full should look one third full.
   */
  /*
    ALWAYS an array, never undefined.

    DrawColumn generates plausible handles when it is given none, which is
    right for the landing hero and wrong here. When a chain read failed this
    route handed it undefined and it filled all 32 slots with invented hex,
    under a route titled "live", beside a panel saying the chain was
    unreachable. An empty register has to look empty.
  */
  const columnHandles = useMemo(
    () =>
      Array.from({ length: state?.capacity ?? 32 }, (_, i) =>
        slots[i] ? truncate(slots[i]!.handle, 3) : EMPTY_SLOT,
      ),
    [slots, state],
  );

  /**
   * Hours held, shown beside each slot's handle.
   *
   * The one device worth taking from Pendle: a time-scoped position states its
   * age next to its identity. Hours held is the input to the weight line, so a
   * slot showing only a handle hides the number that decides the draw.
   */
  const columnMeta = useMemo(
    () =>
      Array.from({ length: state?.capacity ?? 32 }, (_, i) =>
        slots[i] ? `${slots[i]!.hoursHeld}h` : "",
      ),
    [slots, state],
  );

  /*
    "Claimed" is gone, and both remaining filters do something.

    The third chip used to be CLAIMED, and both it and DRAWN returned
    `row.lotDrawn`, so selecting it changed nothing. It could not have worked:
    claiming is per address, `hasClaimed(drawId, account)` needs one, and there
    is no global claimed state for a draw to filter on. A chip that quietly
    does nothing is worse than one that is absent.
  */
  const filtered = history.filter((row) =>
    filter === "all" ? true : filter === "drawn" ? row.lotDrawn : !row.lotDrawn,
  );

  const current = state?.current ?? null;
  const levels = state ? Math.max(state.depth, 1) : 5;

  return (
    <AppShell>
      <div className={shell.split} data-ratio="thirds">
        {/* --------------------------------------------------------- plate */}
        <section className={shell.panel}>
          <div className={shell.panelHead}>
            <span className={shell.panelLabel}>Register, shard 001</span>
            <span className={shell.panelMeta}>
              {state ? `${state.leafCount} / ${state.capacity}` : "reading"}
            </span>
          </div>
          <div className={shell.panelBody}>
            <div style={{ display: "flex", justifyContent: "center" }}>
              <DrawColumn
                levels={levels}
                handles={columnHandles}
              meta={columnMeta}
                showReplay
                autoPlay
                /* The resolved leaf is an encrypted euint16 with no grant on
                   it, so no client can know which slot the walk landed on.
                   The column shows where a descent ends without claiming
                   which real leaf that is. */
                revealWinner={false}
              />
            </div>
            <p className={shell.note}>
              Slot handles are live from Sepolia. The descent is illustrative: the resolved leaf is
              encrypted, so no client can locate it. See Verify for what is publicly checkable.
            </p>
          </div>
        </section>

        {/* --------------------------------------------------- current draw */}
        <div className={shell.stack}>
          <TriggerDraw />

          <section className={shell.panel}>
            <div className={shell.panelHead}>
              <span className={shell.panelLabel}>Current draw</span>
              <span className={shell.panelMeta} data-status={current?.status ?? "none"}>
                {current?.status ?? "none yet"}
              </span>
            </div>
            <div className={shell.panelBody}>
              {current ? (
                <div className={shell.kv}>
                  <span className={shell.kvKey}>Draw id</span>
                  <span className={shell.kvValue}>#{current.id.toString()}</span>

                  <span className={shell.kvKey}>Root handle</span>
                  <span className={shell.kvValue}>
                    <span className="ciphertext">{truncate(current.rootHandle)}</span>
                  </span>

                  <span className={shell.kvKey}>Opened block</span>
                  <span className={shell.kvValue}>{current.openedAtBlock.toString()}</span>

                  <span className={shell.kvKey}>Lot handle</span>
                  <span className={shell.kvValue}>
                    {current.lotHandle ? (
                      <span className="ciphertext">{truncate(current.lotHandle)}</span>
                    ) : (
                      lotHandleText(current)
                    )}
                  </span>

                  <span className={shell.kvKey}>Resolved handle</span>
                  <span className={shell.kvValue}>
                    <span className="ciphertext">{truncate(current.resolvedLeaf)}</span>
                  </span>

                  <span className={shell.kvKey}>Total weight</span>
                  <span className={shell.kvValue}>
                    {current.totalWeight.toLocaleString("en-US")}
                  </span>

                  <span className={shell.kvKey}>Status</span>
                  <span className={shell.kvValue}>{current.status}</span>

                  {/* The two numbers the whole submission rests on, on screen
                      rather than only in the README. */}
                  <span className={shell.kvKey}>Walk height</span>
                  <span className={shell.kvValue}>
                    {current.walkHeight}
                    <span className={shell.kvAside}>
                      {current.walkHeight === 0
                        ? "one leaf carries weight, so the descent short-circuits"
                        : `${2 ** current.walkHeight} leaf subtree`}
                    </span>
                  </span>

                  <span className={shell.kvKey}>drawLot depth</span>
                  <span className={shell.kvValue} data-tone="brass">
                    {HCU.DRAW[3].depth.toLocaleString("en-US")}
                    <span className={shell.kvAside}>
                      of {HCU.DEPTH_LIMIT.toLocaleString("en-US")} at{" "}
                      {HCU.SHARD_CEILING} stakes,{" "}
                      {((HCU.DRAW[3].depth / HCU.DEPTH_LIMIT) * 100).toFixed(1)}%
                    </span>
                  </span>
                </div>
              ) : (
                <p className={shell.note}>
                  {failed ? "Chain unreachable." : "No draw has been opened on this shard yet."}
                </p>
              )}
            </div>
          </section>
        </div>

        {/* -------------------------------------------------------- history */}
        <div className={shell.stack}>
          <section className={shell.panel}>
            <div className={shell.panelHead}>
              <span className={shell.panelLabel}>History</span>
              <span className={shell.chips}>
                {(["all", "drawn", "open"] as Filter[]).map((f) => (
                  <button
                    key={f}
                    type="button"
                    className={shell.chip}
                    data-active={filter === f}
                    onClick={() => setFilter(f)}
                  >
                    {f}
                  </button>
                ))}
              </span>
            </div>
            <div className={`${shell.panelBodyFlush} ${shell.feed}`}>
              {filtered.length ? (
                <table className={`${shell.table} ${shell.tableTight}`}>
                  <colgroup>
                    <col style={{ width: "12%" }} />
                    <col style={{ width: "26%" }} />
                    <col style={{ width: "24%" }} />
                    <col style={{ width: "24%" }} />
                    <col style={{ width: "14%" }} />
                  </colgroup>
                  <thead>
                    <tr>
                      <th>ID</th>
                      <th>Block</th>
                      <th>Root</th>
                      <th>Resolved</th>
                      <th />
                    </tr>
                  </thead>
                  <tbody>
                    {filtered.map((row) => (
                      <tr key={row.id.toString()}>
                        <td>#{row.id.toString()}</td>
                        <td>{row.openedAtBlock.toString()}</td>
                        <td>{truncate(row.rootHandle, 3)}</td>
                        <td>{truncate(row.resolvedLeaf, 3)}</td>
                        <td>
                          <Link href={`/app/verify?draw=${row.id}`}>verify</Link>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              ) : (
                <p className={shell.empty}>
                  {failed ? "Chain unreachable." : "No draws yet."}
                </p>
              )}
            </div>
          </section>
        </div>
      </div>
    </AppShell>
  );
}
