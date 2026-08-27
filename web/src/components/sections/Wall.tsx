import styles from "./section.module.css";
import { HCU, MEASUREMENT_COMMIT, REPO_URL } from "@/lib/measurements";

/**
 * Section 2 of the landing page. The wall.
 *
 * The one section that carries the whole argument: a linear draw is a chain of
 * dependent additions and dies at about thirty depositors, and a tree draw is
 * not. Every number here comes from test/HCU.t.ts, and the commit that
 * produced them is printed under the chart so a reader can rerun it.
 */

// Chart geometry. Computed rather than hand-placed so the curves cannot drift
// away from the numbers they claim to plot.
const W = 680;
const H = 380;
const PLOT = { left: 60, right: 650, top: 24, bottom: 320 };
const MAX_LOG2 = 16; // x axis runs 2^0 to 2^16 depositors
const MAX_HCU = 6_000_000; // y axis, a little above the 5,000,000 limit

const xFor = (depositors: number) =>
  PLOT.left + (Math.log2(depositors) / MAX_LOG2) * (PLOT.right - PLOT.left);

const yFor = (hcu: number) =>
  PLOT.bottom - (Math.min(hcu, MAX_HCU) / MAX_HCU) * (PLOT.bottom - PLOT.top);

/** A linear scan accumulates into one ciphertext: N dependent adds. */
const linearHCU = (depositors: number) => depositors * HCU.ADD_CT_CT;

/** The walk is a fixed chain per level, and levels are log2 of the stakes. */
const treeHCU = (depositors: number) =>
  HCU.WALK_INTERCEPT + HCU.WALK_PER_LEVEL * Math.log2(Math.max(depositors, 1));

/** Where the linear curve crosses the limit and the transaction reverts. */
const REVERTS_AT = Math.floor(HCU.DEPTH_LIMIT / HCU.ADD_CT_CT);

function pathFor(fn: (n: number) => number, stopAtLimit: boolean) {
  const points: string[] = [];
  for (let step = 0; step <= 160; step++) {
    const depositors = 2 ** ((step / 160) * MAX_LOG2);
    const value = fn(depositors);
    if (stopAtLimit && value > MAX_HCU) break;
    points.push(`${xFor(depositors).toFixed(1)},${yFor(value).toFixed(1)}`);
  }
  return `M ${points.join(" L ")}`;
}

const Y_GRID = [1, 2, 3, 4, 5, 6].map((m) => m * 1_000_000);
const X_TICKS = [0, 4, 8, 12, 16].map((p) => 2 ** p);

export function Wall() {
  return (
    <section className={styles.section} id="the-wall">
      <div className={styles.inner}>
        <div className={styles.head}>
          <span className={styles.number}>02</span>
          <p className="eyebrow">The constraint</p>
          <h2 className={styles.title}>Every other design hits a wall at thirty depositors.</h2>
          <p className={styles.standfirst}>
            FHEVM caps the longest chain of dependent operations in a transaction at 5,000,000 HCU.
            Encrypting balances and scanning them puts every depositor in that one chain. Sortis
            keeps the weights in a tree and descends it, so the chain grows with the depth of the
            tree rather than with the number of people in it.
          </p>
        </div>

        <div className={styles.chartScroll}>
        <svg
          className={styles.chart}
          viewBox={`0 0 ${W} ${H}`}
          role="img"
          aria-label={`Sequential HCU against depositor count. A linear scan crosses the 5,000,000 limit at ${REVERTS_AT} depositors. The tree walk reaches ${Math.round(treeHCU(65536)).toLocaleString("en-US")} HCU at 65,536 depositors and never approaches the limit.`}
        >
          {/* horizontal grid */}
          {Y_GRID.map((value) => (
            <g key={value}>
              <line
                x1={PLOT.left}
                x2={PLOT.right}
                y1={yFor(value)}
                y2={yFor(value)}
                stroke="var(--rule)"
                strokeWidth="1"
              />
              <text
                x={PLOT.left - 10}
                y={yFor(value) + 4}
                textAnchor="end"
                fill="var(--graphite)"
                fontFamily="var(--font-data)"
                fontSize="10"
              >
                {value / 1_000_000}M
              </text>
            </g>
          ))}

          {/* x ticks, one per four tree levels */}
          {X_TICKS.map((n) => (
            <text
              key={n}
              x={xFor(n)}
              y={PLOT.bottom + 20}
              textAnchor={n === 1 ? "start" : n === 65536 ? "end" : "middle"}
              fill="var(--graphite)"
              fontFamily="var(--font-data)"
              fontSize="10"
            >
              {n.toLocaleString("en-US")}
            </text>
          ))}
          <text
            x={PLOT.left}
            y={PLOT.bottom + 38}
            fill="var(--graphite)"
            fontFamily="var(--font-body)"
            fontSize="10"
            letterSpacing="0.08em"
          >
            DEPOSITORS
          </text>

          {/* the limit */}
          <line
            x1={PLOT.left}
            x2={PLOT.right}
            y1={yFor(HCU.DEPTH_LIMIT)}
            y2={yFor(HCU.DEPTH_LIMIT)}
            stroke="var(--fault)"
            strokeWidth="1.5"
            strokeDasharray="4 3"
          />
          <text
            x={PLOT.right}
            y={yFor(HCU.DEPTH_LIMIT) - 8}
            textAnchor="end"
            fill="var(--fault)"
            fontFamily="var(--font-data)"
            fontSize="11"
          >
            5,000,000 HCU. Transaction reverts here.
          </text>

          {/* linear scan, stopped where it leaves the chart */}
          <path d={pathFor(linearHCU, true)} fill="none" stroke="var(--fault)" strokeWidth="2" />

          {/* the crossing */}
          <circle
            cx={xFor(REVERTS_AT)}
            cy={yFor(HCU.DEPTH_LIMIT)}
            r="4"
            fill="var(--fault)"
          />
          <text
            x={xFor(REVERTS_AT) + 10}
            y={yFor(HCU.DEPTH_LIMIT) + 22}
            fill="var(--fault)"
            fontFamily="var(--font-data)"
            fontSize="11"
          >
            {REVERTS_AT} depositors
          </text>

          {/* the walk */}
          <path d={pathFor(treeHCU, false)} fill="none" stroke="var(--brass)" strokeWidth="2" />
          <circle cx={xFor(65536)} cy={yFor(treeHCU(65536))} r="4" fill="var(--brass)" />
          <text
            x={PLOT.right}
            y={yFor(treeHCU(65536)) - 12}
            textAnchor="end"
            fill="var(--brass)"
            fontFamily="var(--font-data)"
            fontSize="11"
          >
            {Math.round(treeHCU(65536)).toLocaleString("en-US")} HCU at 65,536
          </text>

          {/* axes */}
          <line
            x1={PLOT.left}
            x2={PLOT.left}
            y1={PLOT.top}
            y2={PLOT.bottom}
            stroke="var(--graphite)"
            strokeWidth="1"
          />
          <line
            x1={PLOT.left}
            x2={PLOT.right}
            y1={PLOT.bottom}
            y2={PLOT.bottom}
            stroke="var(--graphite)"
            strokeWidth="1"
          />
        </svg>
        </div>

        <div className={styles.chartLegend}>
          <span className={styles.legendItem}>
            <span className={styles.legendSwatch} style={{ background: "var(--fault)" }} />
            Linear scan, one dependent add per depositor
          </span>
          <span className={styles.legendItem}>
            <span className={styles.legendSwatch} style={{ background: "var(--brass)" }} />
            Sortis, one encrypted comparison per tree level
          </span>
        </div>

        <div className={styles.pair} style={{ marginTop: "var(--s-7)" }}>
          <div className={styles.panel}>
            <div className={styles.panelHead}>
              <span className={styles.panelTitle}>Linear draw</span>
              <span className={styles.panelVerdict} data-tone="fault">
                Reverts past {REVERTS_AT}
              </span>
            </div>
            <div className={styles.rows}>
              <div className={styles.row}>
                <span className={styles.rowLabel}>Cost per depositor</span>
                <span className={styles.rowValue}>{HCU.ADD_CT_CT.toLocaleString("en-US")} HCU</span>
              </div>
              <div className={styles.row}>
                <span className={styles.rowLabel}>At 256 depositors</span>
                <span className={styles.rowValue} data-tone="fault">
                  {linearHCU(256).toLocaleString("en-US")} HCU
                </span>
              </div>
              <div className={styles.row}>
                <span className={styles.rowLabel}>At 65,536 depositors</span>
                <span className={styles.rowValue} data-tone="fault">
                  {linearHCU(65536).toLocaleString("en-US")} HCU
                </span>
              </div>
              <div className={styles.row}>
                <span className={styles.rowLabel}>Scales to</span>
                <span className={styles.rowValue} data-tone="fault">
                  {REVERTS_AT} depositors
                </span>
              </div>
            </div>
          </div>

          <div className={styles.panel}>
            <div className={styles.panelHead}>
              <span className={styles.panelTitle}>Sortis</span>
              <span className={styles.panelVerdict} data-tone="brass">
                Inside the budget
              </span>
            </div>
            <div className={styles.rows}>
              <div className={styles.row}>
                <span className={styles.rowLabel}>Cost per tree level</span>
                <span className={styles.rowValue}>
                  {HCU.WALK_PER_LEVEL.toLocaleString("en-US")} HCU
                </span>
              </div>
              <div className={styles.row}>
                <span className={styles.rowLabel}>At 256 depositors</span>
                <span className={styles.rowValue} data-tone="brass">
                  {HCU.WALK_AT_2_8.toLocaleString("en-US")} HCU
                </span>
              </div>
              <div className={styles.row}>
                <span className={styles.rowLabel}>At 65,536 depositors</span>
                <span className={styles.rowValue} data-tone="brass">
                  {HCU.WALK_AT_2_16.toLocaleString("en-US")} HCU
                </span>
              </div>
              <div className={styles.row}>
                <span className={styles.rowLabel}>Commit and release</span>
                <span className={styles.rowValue} data-tone="brass">
                  {HCU.UPDATE_DEPTH.toLocaleString("en-US")} HCU, flat
                </span>
              </div>
            </div>
          </div>
        </div>

        <p className={styles.provenance}>
          Measured by <code>test/HCU.t.ts</code> against the FHEVM mock coprocessor at commit{" "}
          <a href={`${REPO_URL}/commit/${MEASUREMENT_COMMIT}`}>{MEASUREMENT_COMMIT}</a>. Walk figures
          at 256 depositors are measured; at 65,536 they are projected from the measured per-level
          slope, because the global HCU budget stops that transaction before it finishes. Run{" "}
          <code>npm test</code> to reproduce every number on this page.
        </p>
      </div>
    </section>
  );
}
