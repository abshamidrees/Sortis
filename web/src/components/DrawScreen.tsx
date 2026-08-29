"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";

import { AppShell } from "@/components/chrome/AppShell";
import { DrawColumn } from "@/components/DrawColumn";
import { ETHERSCAN } from "@/lib/measurements";
import {
  CONFIGURED,
  readDrawHistory,
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

type Filter = "all" | "drawn" | "claimed";

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
  const [slots, setSlots] = useState<(string | null)[]>([]);
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
  const columnHandles = useMemo(() => {
    if (!state) return undefined;
    return Array.from({ length: state.capacity }, (_, i) => {
      const handle = slots[i];
      return handle ? truncate(handle, 3) : "—";
    });
  }, [slots, state]);

  const filtered = history.filter((row) =>
    filter === "all" ? true : filter === "drawn" ? row.lotDrawn : row.lotDrawn,
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
              {state ? `${state.leafCount} / ${state.capacity}` : "—"}
            </span>
          </div>
          <div className={shell.panelBody}>
            <div style={{ display: "flex", justifyContent: "center" }}>
              <DrawColumn
                levels={levels}
                handles={columnHandles}
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

                  <span className={shell.kvKey}>Walk height</span>
                  <span className={shell.kvValue}>{current.walkHeight}</span>

                  <span className={shell.kvKey}>Status</span>
                  <span className={shell.kvValue}>{current.status}</span>
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
                {(["all", "drawn", "claimed"] as Filter[]).map((f) => (
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
                <table className={shell.table}>
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
