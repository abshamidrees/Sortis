import { readFileSync, writeFileSync, mkdirSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { chromium } from "@playwright/test";

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = join(here, "..");
const SRC = join(ROOT, "web", "src", "lib", "measurements.ts");
const OUT_DIR = join(ROOT, "web", "public");
const SVG = join(OUT_DIR, "hcu-ceiling.svg");
const PNG = join(OUT_DIR, "hcu-ceiling.png");

/**
 * The depth ceiling, as a standalone SVG and a 2x PNG.
 *
 *     node scripts/hcu-chart.mjs
 *
 * NOTHING IS TYPED BY HAND. Every figure is parsed out of measurements.ts and
 * asserted, so a change there either flows into the image or stops this script.
 * The same constants drive web/src/components/sections/Wall.tsx, which is why
 * the numbers here and on the site cannot drift apart.
 *
 * ONE FIGURE WAS ASKED FOR AND IS NOT IN THAT FILE: how many times the mock and
 * the chain have agreed. measurements.ts carries two agreements, LIVE_DRAW at
 * the deployed height and SEPOLIA_CHECK at height 2, and no count of repeats.
 * So the stat block states the agreement it can source and says nothing about
 * how often, rather than asserting a number the code does not hold.
 */

const src = readFileSync(SRC, "utf8");

const scoped = (block, name) => {
  const b = src.slice(src.indexOf(block));
  const m = b.match(new RegExp(`${name}:\\s*([0-9_]+)`));
  if (!m) throw new Error(`measurements.ts has no ${block}.${name}. Refusing to invent it.`);
  return Number(m[1].replace(/_/g, ""));
};
const top = (name) => {
  const m = src.match(new RegExp(`${name}:\\s*([0-9_]+)`));
  if (!m) throw new Error(`measurements.ts has no ${name}. Refusing to invent it.`);
  return Number(m[1].replace(/_/g, ""));
};

const DEPTH_LIMIT = top("DEPTH_LIMIT");
const ADD_CT_CT = top("ADD_CT_CT");
const SHARD_CEILING = top("SHARD_CEILING");
const PREDICTED = scoped("export const LIVE_DRAW", "mockDepth");
const OBSERVED = scoped("export const LIVE_DRAW", "depth");
const WALK_HEIGHT = scoped("export const LIVE_DRAW", "walkHeight");

const DRAW = [
  ...src.matchAll(/\{\s*stakes:\s*(\d+),\s*depth:\s*([0-9_]+),\s*fits:\s*(true|false)\s*\}/g),
].map((m) => ({
  stakes: Number(m[1]),
  depth: Number(m[2].replace(/_/g, "")),
  fits: m[3] === "true",
}));
if (DRAW.length !== 5) throw new Error(`expected 5 swept rows, parsed ${DRAW.length}`);

const shard = DRAW.find((d) => d.stakes === SHARD_CEILING);
if (!shard) throw new Error(`no swept row at the shard ceiling of ${SHARD_CEILING}`);

const divergence = (((OBSERVED - PREDICTED) / PREDICTED) * 100).toFixed(2);

console.log("parsed from measurements.ts:");
console.log("  DEPTH_LIMIT   ", DEPTH_LIMIT.toLocaleString("en-US"));
console.log("  ADD_CT_CT     ", ADD_CT_CT.toLocaleString("en-US"));
console.log("  SHARD_CEILING ", SHARD_CEILING);
console.log("  predicted     ", PREDICTED.toLocaleString("en-US"));
console.log("  observed      ", OBSERVED.toLocaleString("en-US"));
console.log("  divergence    ", divergence + "%");
console.log("  swept         ", DRAW.map((d) => `${d.stakes}:${d.depth}`).join("  "));

/* ---------------------------------------------------------------- layout -- */

const W = 1600;
const H = 900;
const FRAME = { x: 40, y: 40, w: 1520, h: 700 };

const Y_MAX = 6_000_000;
/*
  The axis stops at 64, where the data does.

  128 was a tick with nothing on it: the derived line leaves the plot at 37
  stakes and the swept series ends at 64 where the transaction reverts, so the
  right seventh was empty by construction.
*/
const TICKS = [1, 4, 8, 16, 32, 64];

// A 76px gutter for the rotated axis label, then room for the tick numbers.
const GUTTER = { x: FRAME.x + 32, w: 76 };
const PLOT = { x: 268, y: 196, w: 1120, h: 372 };

const yPos = (v) => PLOT.y + PLOT.h - (Math.min(v, Y_MAX) / Y_MAX) * PLOT.h;
const lo = Math.log2(Math.min(...TICKS));
const hi = Math.log2(Math.max(...TICKS));
const xPos = (n) => PLOT.x + ((Math.log2(n) - lo) / (hi - lo)) * PLOT.w;

const C = {
  ground: "#F3F4F1",
  ink: "#1A1E1B",
  grey: "#565C56",
  hair: "#CDD2C9",
  brass: "#A87A2E",
  seal: "#2F3E6B",
  fault: "#8C3A28",
};

const n = (v) => v.toLocaleString("en-US");
const p = [];

const linearAt = (s) => s * ADD_CT_CT;
const LINEAR_EXIT = Y_MAX / ADD_CT_CT; // where the derived line leaves the plot

/* ---------------------------------------------------------------- render -- */

p.push(`<rect x="0" y="0" width="${W}" height="${H}" fill="${C.ground}"/>`);
p.push(
  `<rect x="${FRAME.x}.5" y="${FRAME.y}.5" width="${FRAME.w}" height="${FRAME.h}" fill="none" stroke="${C.hair}" stroke-width="1"/>`,
);

p.push(
  `<text x="${GUTTER.x}" y="94" font-family="Archivo" font-size="30" font-weight="600" fill="${C.ink}">Hiding the winner has a measured ceiling</text>`,
);

// Legend, top right. The provenance tag sits IN the legend, not only the caption.
const LGX = FRAME.x + FRAME.w - 32;
[
  { c: C.fault, label: "Linear scan, one dependent add per depositor", tag: "derived" },
  { c: C.brass, label: "Sortis, one encrypted descent per level", tag: "measured" },
].forEach((L, i) => {
  const y = 78 + i * 28;
  p.push(`<rect x="${LGX - 430}" y="${y - 10}" width="12" height="12" fill="${L.c}"/>`);
  p.push(
    `<text x="${LGX - 410}" y="${y}" font-family="IBM Plex Mono" font-size="13" fill="${C.ink}">${L.label}</text>`,
  );
  p.push(
    `<text x="${LGX}" y="${y}" text-anchor="end" font-family="IBM Plex Mono" font-size="13" font-weight="600" fill="${L.c}">${L.tag}</text>`,
  );
});

// Y gridlines and tick labels.
for (let v = 0; v <= Y_MAX; v += 1_000_000) {
  const y = yPos(v);
  p.push(
    `<line x1="${PLOT.x}" y1="${y}" x2="${PLOT.x + PLOT.w}" y2="${y}" stroke="${C.hair}" stroke-width="1"/>`,
  );
  p.push(
    `<text x="${PLOT.x - 18}" y="${y + 4}" text-anchor="end" font-family="IBM Plex Mono" font-size="13" fill="${C.grey}" style="font-variant-numeric:tabular-nums">${n(v)}</text>`,
  );
}

// Rotated Y label, centred in its own gutter so it can never be clipped.
const gx = GUTTER.x + GUTTER.w / 2;
const gy = PLOT.y + PLOT.h / 2;
p.push(
  `<text x="${gx}" y="${gy}" transform="rotate(-90 ${gx} ${gy})" text-anchor="middle" font-family="Inter" font-size="14" fill="${C.grey}">Sequential HCU</text>`,
);

// X ticks.
TICKS.forEach((t) => {
  const x = xPos(t);
  p.push(
    `<line x1="${x}" y1="${PLOT.y + PLOT.h}" x2="${x}" y2="${PLOT.y + PLOT.h + 7}" stroke="${C.hair}" stroke-width="1"/>`,
  );
  p.push(
    `<text x="${x}" y="${PLOT.y + PLOT.h + 27}" text-anchor="middle" font-family="IBM Plex Mono" font-size="14" fill="${C.ink}" style="font-variant-numeric:tabular-nums">${t}</text>`,
  );
});
p.push(
  `<text x="${PLOT.x + PLOT.w / 2}" y="${PLOT.y + PLOT.h + 52}" text-anchor="middle" font-family="Inter" font-size="14" fill="${C.grey}">Stakes in the register</text>`,
);

// The budget line, labelled at its LEFT end inside the plot.
const yLimit = yPos(DEPTH_LIMIT);
p.push(
  `<line x1="${PLOT.x}" y1="${yLimit}" x2="${PLOT.x + PLOT.w}" y2="${yLimit}" stroke="${C.fault}" stroke-width="1.5" stroke-dasharray="7 4"/>`,
);
p.push(
  `<text x="${PLOT.x + 14}" y="${yLimit - 13}" font-family="IBM Plex Mono" font-size="14" font-weight="600" fill="${C.fault}" style="font-variant-numeric:tabular-nums">${n(DEPTH_LIMIT)} HCU. The transaction reverts here.</text>`,
);

// Linear, derived. Drawn from the first tick to where it leaves the plot.
const linPts = TICKS.filter((t) => linearAt(t) <= Y_MAX);
const linLine = linPts
  .map((t) => `${xPos(t)},${yPos(linearAt(t))}`)
  .concat(`${xPos(LINEAR_EXIT)},${PLOT.y}`)
  .join(" ");
p.push(
  `<polyline points="${linLine}" fill="none" stroke="${C.fault}" stroke-width="2.5" stroke-dasharray="6 4"/>`,
);

// Sortis, measured. The reverting row is drawn but marked hollow.
const fits = DRAW.filter((d) => d.fits);
p.push(
  `<polyline points="${fits.map((d) => `${xPos(d.stakes)},${yPos(d.depth)}`).join(" ")}" fill="none" stroke="${C.brass}" stroke-width="3"/>`,
);
const revert = DRAW.find((d) => !d.fits);
p.push(
  `<line x1="${xPos(fits.at(-1).stakes)}" y1="${yPos(fits.at(-1).depth)}" x2="${xPos(revert.stakes)}" y2="${yPos(revert.depth)}" stroke="${C.brass}" stroke-width="3" stroke-dasharray="5 4" opacity="0.75"/>`,
);
DRAW.forEach((d) => {
  const x = xPos(d.stakes);
  const y = yPos(d.depth);
  p.push(
    d.fits
      ? `<circle cx="${x}" cy="${y}" r="5.5" fill="${C.brass}"/>`
      : `<circle cx="${x}" cy="${y}" r="5.5" fill="${C.ground}" stroke="${C.fault}" stroke-width="2.5"/>`,
  );
});

// ANNOTATION 1: the shard, below the axis rather than floating in the plot.
const xs = xPos(SHARD_CEILING);
p.push(
  `<line x1="${xs}" y1="${yPos(shard.depth)}" x2="${xs}" y2="${PLOT.y + PLOT.h + 96}" stroke="${C.brass}" stroke-width="1" stroke-dasharray="3 3"/>`,
);
p.push(
  `<text x="${xs - 14}" y="${PLOT.y + PLOT.h + 100}" text-anchor="end" font-family="IBM Plex Mono" font-size="14" font-weight="600" fill="${C.brass}" style="font-variant-numeric:tabular-nums">${SHARD_CEILING} stakes, ${n(shard.depth)}. One shard. This is what ships.</text>`,
);

// ANNOTATION 2: each curve named once at its own right-hand end.
p.push(
  `<text x="${xPos(LINEAR_EXIT) + 12}" y="${PLOT.y + 16}" font-family="IBM Plex Mono" font-size="13" font-weight="600" fill="${C.fault}">Linear scan, derived</text>`,
);
p.push(
  `<text x="${xPos(revert.stakes) - 16}" y="${yPos(revert.depth) + 5}" text-anchor="end" font-family="IBM Plex Mono" font-size="13" font-weight="600" fill="${C.brass}">Sortis, measured</text>`,
);

// The agreement block, bottom right.
const SB = { x: PLOT.x, y: 626, w: 386, h: 96 };
p.push(
  `<rect x="${SB.x}.5" y="${SB.y}.5" width="${SB.w}" height="${SB.h}" fill="none" stroke="${C.hair}" stroke-width="1"/>`,
);
p.push(
  `<text x="${SB.x + 18}" y="${SB.y + 26}" font-family="IBM Plex Mono" font-size="13" font-weight="600" fill="${C.ink}" letter-spacing="1.2">MEASURED ON CHAIN</text>`,
);
[
  ["predicted", n(PREDICTED)],
  ["observed", n(OBSERVED)],
  ["divergence", `${divergence}%, at the deployed height`],
].forEach(([k, v], i) => {
  const y = SB.y + 50 + i * 20;
  p.push(
    `<text x="${SB.x + 18}" y="${y}" font-family="IBM Plex Mono" font-size="13" fill="${C.grey}">${k}</text>`,
  );
  p.push(
    `<text x="${SB.x + 130}" y="${y}" font-family="IBM Plex Mono" font-size="13" fill="${C.ink}" style="font-variant-numeric:tabular-nums">${v}</text>`,
  );
});

// Caption, three lines below the frame.
const capY = FRAME.y + FRAME.h + 44;
[
  `Sequential HCU per draw against the FHEVM ${n(DEPTH_LIMIT)} depth limit. Walk height ${WALK_HEIGHT} at the deployed shard.`,
  `Sortis figures measured by sweeping register sizes until the walk reverts. The linear series is derived from a per-depositor constant of ${n(ADD_CT_CT)} HCU,`,
  `because a scan that reverts cannot be measured past the point it stops fitting. Reproduce with npm test.`,
].forEach((line, i) => {
  p.push(
    `<text x="${FRAME.x}" y="${capY + i * 22}" font-family="Inter" font-size="13" fill="${C.grey}">${line}</text>`,
  );
});

const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
<defs><style>
@import url('https://fonts.googleapis.com/css2?family=Archivo:wght@600;700&amp;family=Inter:wght@400;600&amp;family=IBM+Plex+Mono:wght@400;500;600&amp;display=swap');
text { font-family: Inter, system-ui, sans-serif; }
</style></defs>
${p.join("\n")}
</svg>
`;

mkdirSync(OUT_DIR, { recursive: true });
writeFileSync(SVG, svg);
console.log("\nwrote", SVG);

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 2 });
await page.setContent(
  `<!doctype html><html><head>
   <link rel="preconnect" href="https://fonts.googleapis.com">
   <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
   <link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Archivo:wght@600;700&family=Inter:wght@400;600&family=IBM+Plex+Mono:wght@400;500;600&display=swap">
   <style>html,body{margin:0;padding:0;background:${C.ground}}</style>
   </head><body>${svg}</body></html>`,
  { waitUntil: "networkidle" },
);
await page.evaluate(() => document.fonts.ready);
await page.waitForTimeout(600);
await page.locator("svg").screenshot({ path: PNG });
await browser.close();
console.log("wrote", PNG, "at 2x");
