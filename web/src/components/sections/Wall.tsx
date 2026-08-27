import styles from "./section.module.css";
import {
  HCU,
  LINEAR_SCAN_WALL,
  MEASUREMENT_COMMIT,
  REPO_URL,
  SEPOLIA_CHECK,
} from "@/lib/measurements";

/**
 * Section 2. The wall.
 *
 * This section runs on an inverted ground, and it is the only one that does.
 * The brief said spend the boldness in one place and the draw column took it,
 * which left the argument that actually wins the bounty carrying the same
 * visual weight as the footer. Inverting exactly one section fixes both the
 * emphasis and the monotony, and stays disciplined because it happens once.
 *
 * The chart plots SEQUENTIAL DEPTH of a COMPLETE DRAW, because that is the
 * budget that stops both designs and because a fragment of a transaction is
 * not a fair comparison. A linear scan is one dependent chain and crosses at
 * 30. A Sortis draw is a short chain per level plus the lot reduction, and
 * crosses at 64. Shards ship at 32, the last power of two underneath.
 *
 * TWO ANNOTATIONS, NO MORE. The previous version had four overlapping in the
 * same region and was unreadable. The limit label sits at the left end where
 * neither curve is; the shard marker's label sits below the axis; and each
 * curve is labelled at its own endpoint in its own colour. The measured points
 * are drawn but not labelled, because the table underneath already carries
 * those numbers and repeating them is what made this a mess.
 */

const W = 680;
const H = 400;

// 76px of left gutter is reserved for the rotated axis label. Without it the
// label clipped to "TIAL HCU", which reads as a rendering fault on the most
// important visual on the site.
const PLOT = { left: 76, right: 640, top: 30, bottom: 300 };

const MAX_LOG2 = 8; // x axis runs 1 to 256 stakes
const MAX_HCU = 6_000_000;

// The ground is --ink here, so the chart's furniture is stone at reduced
// opacity rather than graphite, and the Sortis curve is --gleam rather than
// --brass so it survives the dark background.
const LABEL = "color-mix(in srgb, var(--stone) 62%, transparent)";
const GRID = "color-mix(in srgb, var(--stone) 14%, transparent)";
const AXIS = "color-mix(in srgb, var(--stone) 40%, transparent)";

const xFor = (stakes: number) =>
  PLOT.left + (Math.log2(stakes) / MAX_LOG2) * (PLOT.right - PLOT.left);

const yFor = (hcu: number) =>
  PLOT.bottom - (Math.min(hcu, MAX_HCU) / MAX_HCU) * (PLOT.bottom - PLOT.top);

/** A linear scan accumulates into one ciphertext: N dependent adds. */
const linearDepth = (stakes: number) => stakes * HCU.ADD_CT_CT;

/**
 * A complete Sortis draw. Levels are log2 of the stakes, so it is a straight
 * line against a log x axis, offset by the cost of reducing the lot modulo the
 * published total before the descent starts.
 *
 * This plots `drawLot`, not `_walk`. The walk alone is cheaper and reading
 * that number instead is how a shard nearly shipped at a size that could not
 * settle its own draw.
 */
const DRAW_INTERCEPT = HCU.DRAW[0].depth - HCU.DRAW_PER_LEVEL * 2;
const drawDepth = (stakes: number) =>
  DRAW_INTERCEPT + HCU.DRAW_PER_LEVEL * Math.log2(Math.max(stakes, 1));

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
const X_TICKS = [1, 4, 16, 32, 64, 256];

/** Where the linear curve leaves the top of the plot, for its endpoint label. */
const LINEAR_EXIT = MAX_HCU / HCU.ADD_CT_CT;

export function Wall() {
  const fits = HCU.DRAW.filter((row) => row.fits);
  const ceiling = fits[fits.length - 1];
  const firstFail = HCU.DRAW.find((row) => !row.fits)!;

  return (
    <section className={styles.section} id="the-wall" data-invert="true">
      <div className={styles.inner}>
        <div className={styles.head}>
          <span className={styles.number}>02</span>
          <p className="eyebrow">The constraint</p>
          <h2 className={styles.title}>A linear draw dies at thirty depositors.</h2>
          <p className={styles.standfirst}>
            FHEVM caps the longest chain of dependent operations in a transaction at 5,000,000 HCU.
            Encrypting balances and scanning them puts every depositor in that one chain, so it
            stops working almost immediately. Sortis descends a tree instead, which puts one short
            chain per level in the budget rather than one per person. Both curves are a complete
            draw, not a fragment of one.
          </p>
        </div>

        <div className={styles.chartScroll}>
          <svg
            className={styles.chart}
            viewBox={`0 0 ${W} ${H}`}
            role="img"
            aria-label={`Sequential HCU against stake count. A linear scan crosses the 5,000,000 limit at ${LINEAR_SCAN_WALL} depositors. The Sortis walk crosses at ${firstFail.stakes} stakes, and a shard is capped at ${ceiling.stakes}, the last power of two underneath.`}
          >
            <text
              transform={`translate(20 ${(PLOT.top + PLOT.bottom) / 2}) rotate(-90)`}
              textAnchor="middle"
              fill={LABEL}
              fontFamily="var(--font-body)"
              fontSize="10"
              letterSpacing="0.08em"
            >
              SEQUENTIAL HCU
            </text>

            {Y_GRID.map((value) => (
              <g key={value}>
                <line
                  x1={PLOT.left}
                  x2={PLOT.right}
                  y1={yFor(value)}
                  y2={yFor(value)}
                  stroke={GRID}
                  strokeWidth="1"
                />
                <text
                  x={PLOT.left - 10}
                  y={yFor(value) + 4}
                  textAnchor="end"
                  fill={LABEL}
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
                fill={n === ceiling.stakes ? "var(--gleam)" : LABEL}
                fontFamily="var(--font-data)"
                fontSize="10"
              >
                {n}
              </text>
            ))}
            <text
              x={(PLOT.left + PLOT.right) / 2}
              y={PLOT.bottom + 58}
              textAnchor="middle"
              fill={LABEL}
              fontFamily="var(--font-body)"
              fontSize="10"
              letterSpacing="0.08em"
            >
              STAKES IN THE REGISTER
            </text>

            {/* Annotation one: the limit, labelled at the left end where
                neither curve is. */}
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
              x={PLOT.left + 8}
              y={yFor(HCU.DEPTH_LIMIT) - 9}
              fill="var(--fault)"
              fontFamily="var(--font-data)"
              fontSize="11"
            >
              5,000,000 HCU. Transaction reverts here.
            </text>

            {/* Each curve labelled at its own endpoint, in its own colour. */}
            <path d={pathFor(linearDepth)} fill="none" stroke="var(--fault)" strokeWidth="2" />
            <text
              x={xFor(LINEAR_EXIT) + 10}
              y={PLOT.top + 34}
              fill="var(--fault)"
              fontFamily="var(--font-data)"
              fontSize="11"
            >
              Linear scan. Reverts at {LINEAR_SCAN_WALL}.
            </text>

            <path d={pathFor(drawDepth)} fill="none" stroke="var(--gleam)" strokeWidth="2" />
            {/* Both curves leave the top of the plot, so both labels live up
                there. They are separated vertically and anchored to opposite
                edges, because side by side at the same height is exactly how
                the previous version became unreadable. */}
            <text
              x={PLOT.right}
              y={PLOT.top + 12}
              textAnchor="end"
              fill="var(--gleam)"
              fontFamily="var(--font-data)"
              fontSize="11"
            >
              Sortis. Reverts at {firstFail.stakes}.
            </text>

            {fits.map((row) => (
              <circle
                key={row.stakes}
                cx={xFor(row.stakes)}
                cy={yFor(row.depth)}
                r="2.5"
                fill="var(--gleam)"
              />
            ))}

            {/* Annotation two: the shipped shard. Marker in the plot, label
                below the axis so nothing floats over a curve. */}
            <line
              x1={xFor(ceiling.stakes)}
              x2={xFor(ceiling.stakes)}
              y1={yFor(ceiling.depth)}
              y2={PLOT.bottom}
              stroke="var(--gleam)"
              strokeWidth="1"
              strokeDasharray="2 3"
            />
            <circle
              cx={xFor(ceiling.stakes)}
              cy={yFor(ceiling.depth)}
              r="5"
              fill="none"
              stroke="var(--gleam)"
              strokeWidth="2"
            />
            <text
              x={xFor(ceiling.stakes)}
              y={PLOT.bottom + 38}
              textAnchor="middle"
              fill="var(--gleam)"
              fontFamily="var(--font-data)"
              fontSize="11"
            >
              one shard
            </text>

            <line
              x1={PLOT.left}
              x2={PLOT.left}
              y1={PLOT.top}
              y2={PLOT.bottom}
              stroke={AXIS}
              strokeWidth="1"
            />
            <line
              x1={PLOT.left}
              x2={PLOT.right}
              y1={PLOT.bottom}
              y2={PLOT.bottom}
              stroke={AXIS}
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
            <span className={styles.legendSwatch} style={{ background: "var(--gleam)" }} />
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
                <span className={styles.rowLabel}>At 32 stakes</span>
                <span className={styles.rowValue} data-tone="fault">
                  {linearDepth(32).toLocaleString("en-US")} HCU
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
                {((ceiling.depth / HCU.DEPTH_LIMIT) * 100).toFixed(0)}% of budget
              </span>
            </div>
            <div className={styles.rows}>
              <div className={styles.row}>
                <span className={styles.rowLabel}>Cost per tree level</span>
                <span className={styles.rowValue}>
                  {HCU.DRAW_PER_LEVEL.toLocaleString("en-US")} HCU
                </span>
              </div>
              <div className={styles.row}>
                <span className={styles.rowLabel}>Draw at {ceiling.stakes} stakes</span>
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
          <a href={`${REPO_URL}/commit/${MEASUREMENT_COMMIT}`}>{MEASUREMENT_COMMIT}</a>, sweeping
          register sizes until a draw reverts rather than assuming where it will. A real draw on
          Sepolia at height {SEPOLIA_CHECK.height} reported{" "}
          {SEPOLIA_CHECK.depth.toLocaleString("en-US")} HCU against the mock&rsquo;s{" "}
          {SEPOLIA_CHECK.mockDepth.toLocaleString("en-US")}, so the two agree exactly. Depth is the
          budget that binds, not global work, so this ceiling cannot be raised by splitting a draw
          across transactions. Run <code>npm test</code> to reproduce every number here.
        </p>
      </div>
    </section>
  );
}
