import styles from "./section.module.css";
import { HCU, LINEAR_SCAN_WALL, MEASUREMENT_COMMIT, REPO_URL } from "@/lib/measurements";

/**
 * Section 2 of the landing page. The wall.
 *
 * Everything here is measured by test/HCU.t.ts, and the commit that produced
 * the numbers is printed under the chart so a reader can rerun it.
 *
 * The chart plots SEQUENTIAL DEPTH, because that is the budget that stops both
 * designs. A linear scan is one dependent chain and crosses the limit at 30
 * depositors. The walk is a shorter chain per level and crosses at 128. Sortis
 * ships shards of 64, which is the last power of two underneath.
 */

const W = 680;
const H = 380;
const PLOT = { left: 64, right: 650, top: 24, bottom: 316 };
const MAX_LOG2 = 8; // x axis runs 1 to 256 stakes
const MAX_HCU = 6_000_000;

const xFor = (stakes: number) =>
  PLOT.left + (Math.log2(stakes) / MAX_LOG2) * (PLOT.right - PLOT.left);

const yFor = (hcu: number) =>
  PLOT.bottom - (Math.min(hcu, MAX_HCU) / MAX_HCU) * (PLOT.bottom - PLOT.top);

/** A linear scan accumulates into one ciphertext: N dependent adds. */
const linearDepth = (stakes: number) => stakes * HCU.ADD_CT_CT;

/**
 * The walk. Measured at 774,500 per level, and levels are log2 of the stakes,
 * so it is a straight line against a log x axis.
 */
const walkDepth = (stakes: number) => HCU.WALK_PER_LEVEL * Math.log2(Math.max(stakes, 1));

function pathFor(fn: (n: number) => number) {
  const points: string[] = [];
  for (let step = 0; step <= 200; step++) {
    const stakes = 2 ** ((step / 200) * MAX_LOG2);
    const value = fn(stakes);
    if (value > MAX_HCU) break;
    points.push(`${xFor(stakes).toFixed(1)},${yFor(value).toFixed(1)}`);
  }
  return `M ${points.join(" L ")}`;
}

const Y_GRID = [1, 2, 3, 4, 5, 6].map((m) => m * 1_000_000);
const X_TICKS = [1, 4, 16, 64, 256];

export function Wall() {
  const fits = HCU.WALK.filter((row) => row.fits);
  const ceiling = fits[fits.length - 1];
  const firstFail = HCU.WALK.find((row) => !row.fits)!;

  return (
    <section className={styles.section} id="the-wall">
      <div className={styles.inner}>
        <div className={styles.head}>
          <span className={styles.number}>02</span>
          <p className="eyebrow">The constraint</p>
          <h2 className={styles.title}>A linear draw dies at thirty depositors.</h2>
          <p className={styles.standfirst}>
            FHEVM caps the longest chain of dependent operations in a transaction at 5,000,000 HCU.
            Encrypting balances and scanning them puts every depositor in that one chain, so it
            stops working almost immediately. Sortis descends a tree instead, which puts one short
            chain per level in the budget rather than one per person.
          </p>
        </div>

        <div className={styles.chartScroll}>
          <svg
            className={styles.chart}
            viewBox={`0 0 ${W} ${H}`}
            role="img"
            aria-label={`Sequential HCU against stake count. A linear scan crosses the 5,000,000 limit at ${LINEAR_SCAN_WALL} depositors. The Sortis walk crosses at ${firstFail.stakes}, and shards are capped at ${ceiling.stakes} stakes, the last power of two underneath.`}
          >
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

            {X_TICKS.map((n) => (
              <text
                key={n}
                x={xFor(n)}
                y={PLOT.bottom + 20}
                textAnchor={n === 1 ? "start" : n === 256 ? "end" : "middle"}
                fill="var(--graphite)"
                fontFamily="var(--font-data)"
                fontSize="10"
              >
                {n}
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
              STAKES IN THE REGISTER
            </text>
            <text
              x={PLOT.left - 10}
              y={PLOT.top - 8}
              textAnchor="end"
              fill="var(--graphite)"
              fontFamily="var(--font-body)"
              fontSize="10"
              letterSpacing="0.08em"
            >
              SEQUENTIAL HCU
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

            {/* linear scan */}
            <path d={pathFor(linearDepth)} fill="none" stroke="var(--fault)" strokeWidth="2" />
            <circle cx={xFor(LINEAR_SCAN_WALL)} cy={yFor(HCU.DEPTH_LIMIT)} r="4" fill="var(--fault)" />
            <text
              x={xFor(LINEAR_SCAN_WALL) + 9}
              y={yFor(HCU.DEPTH_LIMIT) + 20}
              fill="var(--fault)"
              fontFamily="var(--font-data)"
              fontSize="11"
            >
              {LINEAR_SCAN_WALL} depositors
            </text>

            {/* the walk */}
            <path d={pathFor(walkDepth)} fill="none" stroke="var(--brass)" strokeWidth="2" />

            {/* measured points */}
            {fits.map((row) => (
              <circle
                key={row.stakes}
                cx={xFor(row.stakes)}
                cy={yFor(row.depth)}
                r="3"
                fill="var(--brass)"
              />
            ))}

            {/* the shipped shard size */}
            <line
              x1={xFor(ceiling.stakes)}
              x2={xFor(ceiling.stakes)}
              y1={yFor(ceiling.depth)}
              y2={PLOT.bottom}
              stroke="var(--brass)"
              strokeWidth="1"
              strokeDasharray="2 3"
            />
            <circle cx={xFor(ceiling.stakes)} cy={yFor(ceiling.depth)} r="5" fill="var(--brass)" />
            <text
              x={xFor(ceiling.stakes) - 10}
              y={yFor(ceiling.depth) - 12}
              textAnchor="end"
              fill="var(--brass)"
              fontFamily="var(--font-data)"
              fontSize="11"
            >
              {ceiling.stakes} stakes, {(ceiling.depth / 1_000_000).toFixed(2)}M. One shard.
            </text>

            {/* where the walk itself runs out */}
            <circle
              cx={xFor(firstFail.stakes)}
              cy={yFor(HCU.DEPTH_LIMIT)}
              r="3"
              fill="none"
              stroke="var(--brass)"
              strokeWidth="1.5"
            />
            <text
              x={xFor(firstFail.stakes) + 8}
              y={yFor(HCU.DEPTH_LIMIT) - 10}
              fill="var(--brass)"
              fontFamily="var(--font-data)"
              fontSize="11"
            >
              {firstFail.stakes} reverts
            </text>

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
            Sortis, one encrypted descent per tree level
          </span>
        </div>

        <div className={styles.pair} style={{ marginTop: "var(--s-7)" }}>
          <div className={styles.panel}>
            <div className={styles.panelHead}>
              <span className={styles.panelTitle}>Linear draw</span>
              <span className={styles.panelVerdict} data-tone="fault">
                Reverts past {LINEAR_SCAN_WALL}
              </span>
            </div>
            <div className={styles.rows}>
              <div className={styles.row}>
                <span className={styles.rowLabel}>Cost per depositor</span>
                <span className={styles.rowValue}>{HCU.ADD_CT_CT.toLocaleString("en-US")} HCU</span>
              </div>
              <div className={styles.row}>
                <span className={styles.rowLabel}>At 64 stakes</span>
                <span className={styles.rowValue} data-tone="fault">
                  {linearDepth(64).toLocaleString("en-US")} HCU
                </span>
              </div>
              <div className={styles.row}>
                <span className={styles.rowLabel}>At 256 stakes</span>
                <span className={styles.rowValue} data-tone="fault">
                  {linearDepth(256).toLocaleString("en-US")} HCU
                </span>
              </div>
              <div className={styles.row}>
                <span className={styles.rowLabel}>Draws from</span>
                <span className={styles.rowValue} data-tone="fault">
                  {LINEAR_SCAN_WALL} stakes
                </span>
              </div>
            </div>
          </div>

          <div className={styles.panel}>
            <div className={styles.panelHead}>
              <span className={styles.panelTitle}>Sortis, one shard</span>
              <span className={styles.panelVerdict} data-tone="brass">
                {pctOf(ceiling.depth, HCU.DEPTH_LIMIT)} of budget
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
                <span className={styles.rowLabel}>Draw at 64 stakes</span>
                <span className={styles.rowValue} data-tone="brass">
                  {ceiling.depth.toLocaleString("en-US")} HCU
                </span>
              </div>
              <div className={styles.row}>
                <span className={styles.rowLabel}>Commit and release</span>
                <span className={styles.rowValue} data-tone="brass">
                  {HCU.UPDATE_DEPTH.toLocaleString("en-US")} HCU, flat
                </span>
              </div>
              <div className={styles.row}>
                <span className={styles.rowLabel}>Draws from</span>
                <span className={styles.rowValue} data-tone="brass">
                  {ceiling.stakes} stakes per shard
                </span>
              </div>
            </div>
          </div>
        </div>

        <p className={styles.provenance}>
          Measured by <code>test/HCU.t.ts</code> against the FHEVM mock coprocessor at commit{" "}
          <a href={`${REPO_URL}/commit/${MEASUREMENT_COMMIT}`}>{MEASUREMENT_COMMIT}</a>, which sweeps
          register sizes until the walk reverts rather than assuming where it will. Depth is the
          budget that binds, not global work, so the ceiling cannot be raised by splitting a draw
          across transactions. Run <code>npm test</code> to reproduce every number on this page.
        </p>
      </div>
    </section>
  );
}

function pctOf(value: number, limit: number): string {
  return `${((value / limit) * 100).toFixed(0)}%`;
}
