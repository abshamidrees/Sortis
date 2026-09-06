import { writeFileSync, mkdirSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { chromium } from "@playwright/test";

const here = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = join(here, "..", "web", "public");
const SVG = join(OUT_DIR, "privacy-model.svg");
const PNG = join(OUT_DIR, "privacy-model.png");

/**
 * The privacy table, as a standalone SVG and a 2x PNG.
 *
 *     node scripts/privacy-chart.mjs
 *
 * Every string is content rather than a measurement, so nothing here is read
 * from measurements.ts: there is no figure to get wrong. The one claim that
 * could drift is which side each row sits on, and that is the whole point of
 * the image, so it matches docs/privacy-model word for word.
 */

const C = {
  ground: "#F3F4F1",
  ink: "#1A1E1B",
  grey: "#565C56",
  hair: "#CDD2C9",
  brass: "#A87A2E",
  seal: "#2F3E6B",
};

const PRIVATE = [
  ["Your deposit", "euint64, encrypted in your wallet before it is sent"],
  ["Your balance", "euint64, decryptable by you and nobody else"],
  ["Your weight", "euint64, the time-weighted stake the draw reads"],
  ["Whether you won", "the resolved leaf is an encrypted index"],
  ["What you were paid", "a losing claim transfers an encrypted zero"],
];

const PUBLIC = [
  ["The pot size", "harvested yield, plaintext, so the draw can be checked"],
  ["The tree root", "a handle, published when the draw opens"],
  ["The block", "the lot must come from a later one"],
  ["That a draw happened", "anyone can verify the walk ran against that root"],
  ["That you interacted", "your address, the time, and the direction"],
];

const W = 1600;
const H = 900;
const FRAME = { x: 40, y: 40, w: 1520, h: 700 };

const PANEL = { top: 140, strip: 46, rowH: 92, w: 708 };
const LEFT_X = 72;
const RIGHT_X = 820;
const ROWS_Y = PANEL.top + PANEL.strip;
const PANEL_H = PANEL.strip + PANEL.rowH * 5;

const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const p = [];

p.push(`<rect x="0" y="0" width="${W}" height="${H}" fill="${C.ground}"/>`);
p.push(
  `<rect x="${FRAME.x}.5" y="${FRAME.y}.5" width="${FRAME.w}" height="${FRAME.h}" fill="none" stroke="${C.hair}" stroke-width="1"/>`,
);

// Title, top left inside the frame.
p.push(
  `<text x="${LEFT_X}" y="94" font-family="Archivo" font-size="30" font-weight="600" fill="${C.ink}">What Sortis hides, and what it does not</text>`,
);

/** One panel: hairline box, label strip, five rows divided by hairlines. */
function panel(x, label, right, rows, marker) {
  const out = [];

  out.push(
    `<rect x="${x}.5" y="${PANEL.top}.5" width="${PANEL.w}" height="${PANEL_H}" fill="none" stroke="${C.hair}" stroke-width="1"/>`,
  );

  // Label strip.
  out.push(
    `<text x="${x + 24}" y="${PANEL.top + 29}" font-family="IBM Plex Mono" font-size="13" font-weight="600" fill="${C.ink}" letter-spacing="1.4">${label}</text>`,
  );
  out.push(
    `<text x="${x + PANEL.w - 24}" y="${PANEL.top + 29}" text-anchor="end" font-family="IBM Plex Mono" font-size="13" fill="${C.grey}">${right}</text>`,
  );
  out.push(
    `<line x1="${x}" y1="${PANEL.top + PANEL.strip}" x2="${x + PANEL.w}" y2="${PANEL.top + PANEL.strip}" stroke="${C.hair}" stroke-width="1"/>`,
  );

  rows.forEach(([term, note], i) => {
    const top = ROWS_Y + i * PANEL.rowH;

    // Marker, aligned to the term's optical centre.
    out.push(
      `<rect x="${x + 24}" y="${top + 28}" width="9" height="9" fill="${marker}"/>`,
    );
    out.push(
      `<text x="${x + 46}" y="${top + 38}" font-family="Inter" font-size="17" font-weight="600" fill="${C.ink}">${esc(term)}</text>`,
    );
    out.push(
      `<text x="${x + 46}" y="${top + 64}" font-family="IBM Plex Mono" font-size="13" fill="${C.grey}">${esc(note)}</text>`,
    );

    // Hairline between rows, zero gap. The last row is closed by the box.
    if (i < rows.length - 1) {
      out.push(
        `<line x1="${x}" y1="${top + PANEL.rowH}" x2="${x + PANEL.w}" y2="${top + PANEL.rowH}" stroke="${C.hair}" stroke-width="1"/>`,
      );
    }
  });

  return out;
}

p.push(...panel(LEFT_X, "PRIVATE", "encrypted", PRIVATE, C.seal));
p.push(...panel(RIGHT_X, "PUBLIC", "on chain", PUBLIC, C.brass));

// The line that explains why the right column exists.
p.push(
  `<text x="${LEFT_X}" y="${PANEL.top + PANEL_H + 56}" font-family="IBM Plex Mono" font-size="14" fill="${C.ink}">The right-hand column is deliberate. A draw nobody can check is not worth having.</text>`,
);

// Caption, below the frame.
const capY = FRAME.y + FRAME.h + 46;
p.push(
  `<text x="${FRAME.x}" y="${capY}" font-family="Inter" font-size="13" fill="${C.grey}">Sortis, confidential prize savings on the Zama Protocol. Deployed on Sepolia.</text>`,
);
p.push(
  `<text x="${FRAME.x}" y="${capY + 24}" font-family="Inter" font-size="13" fill="${C.grey}">The last public row is the honest one: interaction is visible, amounts are not.</text>`,
);

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
console.log("wrote", SVG);

/* ------------------------------------------------------------------ png -- */

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
// Fonts must be resolved before the shot, or Archivo silently falls back.
await page.evaluate(() => document.fonts.ready);
await page.waitForTimeout(600);
await page.locator("svg").screenshot({ path: PNG });
await browser.close();
console.log("wrote", PNG, "at 2x");
