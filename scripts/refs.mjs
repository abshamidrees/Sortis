import { chromium } from "@playwright/test";
import { mkdirSync, writeFileSync } from "fs";
import { join } from "path";

/**
 * Capture and MEASURE the design reference set.
 *
 *     node scripts/refs.mjs
 *
 * Full-page screenshots at 1440px of surfaces worth studying for DENSITY,
 * RHYTHM and LAYOUT. Nothing else is taken from them: Sortis stays light stone
 * and brass with Archivo, Inter and IBM Plex Mono, and no palette, typeface,
 * radius, shadow or illustration crosses over.
 *
 * refs/ is gitignored. These are third-party screenshots and not ours to
 * redistribute.
 *
 * VALIDATION IS THE POINT. A first pass "captured" a 404 and a blank black
 * rectangle without complaint, because it only checked for a wallet wall. A
 * reference set with dead frames in it is worse than a short one, so a shot is
 * only written if the page actually rendered something: enough text, enough
 * elements, no error string, not a bare connect prompt. Anything else is
 * reported as what it is.
 *
 * Measurement happens in the same visit. Reading rhythm off a screenshot by eye
 * gives numbers that are guesses; reading it off the DOM gives numbers.
 */

const OUT = join(process.cwd(), "refs");
const WIDTH = 1440;

const TARGETS = [
  { file: "reya-trading.png", url: "https://app.reya.xyz/trade/eth" },
  { file: "reya-markets.png", url: "https://app.reya.xyz/markets" },
  { file: "morpho-vaults.png", url: "https://app.morpho.org/vaults" },
  { file: "aave-pro.png", url: "https://pro.aave.com" },
  { file: "pendle-markets.png", url: "https://app.pendle.finance/trade/markets" },
  // /vaults 404s. Euler's vault list lives under /markets.
  { file: "euler-vaults.png", url: "https://app.euler.finance/markets" },
  { file: "hyperliquid.png", url: "https://app.hyperliquid.xyz/trade" },
  { file: "zama-protocol.png", url: "https://www.zama.org" },
  { file: "zama-docs.png", url: "https://docs.zama.ai/protocol" },
];

const ERROR_TEXT = /page not found|404|something went wrong|unsupported browser|access denied/i;
const WALL_TEXT = /connect wallet|connect your wallet|sign in to continue/i;

/**
 * Measure vertical rhythm and the balance of labels to prose.
 *
 * Rows are found structurally rather than by class name: any parent with three
 * or more children of the same tag, similar height and stacked vertically is a
 * list, whatever the framework called it. The tallest such group on the page is
 * the one worth measuring, because that is the page's main table.
 */
function measure() {
  const px = (n) => Math.round(n);

  // ---- rows and rhythm -------------------------------------------------
  let best = null;
  for (const parent of document.querySelectorAll("body *")) {
    const kids = [...parent.children].filter((c) => {
      const r = c.getBoundingClientRect();
      return r.height > 24 && r.height < 200 && r.width > 200;
    });
    if (kids.length < 3) continue;

    const rects = kids.map((k) => k.getBoundingClientRect()).sort((a, b) => a.top - b.top);
    const heights = rects.map((r) => r.height);
    const median = heights.slice().sort((a, b) => a - b)[Math.floor(heights.length / 2)];
    // Rows in one list are near-identical in height.
    const uniform = heights.filter((h) => Math.abs(h - median) <= 4).length;
    if (uniform < 3) continue;

    const gaps = [];
    for (let i = 1; i < rects.length; i++) gaps.push(rects[i].top - rects[i - 1].bottom);
    const gap = gaps.length ? gaps.slice().sort((a, b) => a - b)[Math.floor(gaps.length / 2)] : 0;

    const score = uniform * median;
    if (!best || score > best.score) {
      best = {
        score,
        rowCount: uniform,
        rowHeight: px(median),
        rowGap: px(gap),
        pitch: px(median + gap),
        firstTop: rects[0].top + window.scrollY,
        left: rects[0].left,
        width: px(rects[0].width),
      };
    }
  }

  // ---- the label above that list --------------------------------------
  let labelGap = null;
  let labelText = null;
  if (best) {
    let closest = null;
    const candidates = document.querySelectorAll(
      "h1,h2,h3,h4,h5,h6,th,[role='columnheader'],label,[class*='label'],[class*='header'],[class*='title']",
    );
    for (const el of candidates) {
      const r = el.getBoundingClientRect();
      const top = r.top + window.scrollY;
      if (r.height === 0 || top >= best.firstTop) continue;
      // Must sit above the list and roughly over it, not in a sidebar.
      if (r.left > best.left + best.width || r.left + r.width < best.left) continue;
      const distance = best.firstTop - (top + r.height);
      if (distance < 0 || distance > 200) continue;
      if (!closest || distance < closest.distance) {
        closest = { distance, text: (el.innerText || "").trim().slice(0, 40) };
      }
    }
    if (closest) {
      labelGap = px(closest.distance);
      labelText = closest.text;
    }
  }

  // ---- labels and numbers against prose --------------------------------
  // A leaf element holding text is one of three things: a number or unit, a
  // short label, or a sentence. The ratio of the first two to the third is what
  // makes a page read as an instrument rather than as a document.
  let dataChars = 0;
  let proseChars = 0;
  for (const el of document.querySelectorAll("body *")) {
    if (el.children.length) continue;
    const r = el.getBoundingClientRect();
    if (r.height === 0 || r.width === 0) continue;
    const t = (el.textContent || "").trim();
    if (!t) continue;
    const words = t.split(/\s+/).length;
    const numeric = /[\d]/.test(t);
    if (t.length > 70 && words > 12) proseChars += t.length;
    else if (numeric || words <= 4) dataChars += t.length;
    else if (t.length <= 40) dataChars += t.length;
    else proseChars += t.length;
  }

  const bodyText = (document.body.innerText || "").replace(/\s+/g, " ");

  return {
    rows: best
      ? {
          count: best.rowCount,
          rowHeight: best.rowHeight,
          rowGap: best.rowGap,
          pitch: best.pitch,
        }
      : null,
    labelGap,
    labelText,
    dataChars,
    proseChars,
    ratio: proseChars ? +(dataChars / proseChars).toFixed(1) : null,
    textLength: bodyText.length,
    elementCount: document.querySelectorAll("body *").length,
    scrollHeight: document.body.scrollHeight,
  };
}

async function attempt(browser, target, waitMs) {
  const context = await browser.newContext({
    viewport: { width: WIDTH, height: 1200 },
    deviceScaleFactor: 1,
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    locale: "en-US",
  });
  const page = await context.newPage();

  try {
    await page.goto(target.url, { waitUntil: "domcontentloaded", timeout: 60_000 });
    await page.waitForTimeout(waitMs);

    for (const label of [/reject all/i, /decline/i, /only necessary/i, /essential only/i, /accept/i]) {
      const button = page.getByRole("button", { name: label }).first();
      if (await button.isVisible().catch(() => false)) {
        await button.click().catch(() => {});
        await page.waitForTimeout(900);
        break;
      }
    }

    const m = await page.evaluate(measure);
    const text = await page.evaluate(() => (document.body.innerText || "").slice(0, 3000));

    if (ERROR_TEXT.test(text) && m.textLength < 400) {
      return { context, verdict: "error", detail: text.replace(/\s+/g, " ").slice(0, 70), m };
    }
    if (m.textLength < 120 || m.elementCount < 40) {
      return { context, verdict: "blank", detail: `${m.textLength} chars, ${m.elementCount} nodes`, m };
    }
    if (WALL_TEXT.test(text) && m.textLength < 700) {
      return { context, verdict: "wall", detail: "wallet gate, nothing behind it", m };
    }

    await page.screenshot({ path: join(OUT, target.file), fullPage: true });
    return { context, verdict: "captured", detail: `${m.scrollHeight}px`, m };
  } catch (error) {
    return {
      context,
      verdict: "failed",
      detail: (error instanceof Error ? error.message : String(error)).split("\n")[0].slice(0, 70),
      m: null,
    };
  }
}

async function main() {
  mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch();
  const results = [];

  for (const target of TARGETS) {
    // One patient retry. These are heavy client-rendered apps and a slow first
    // paint is not the same thing as a broken page.
    let r = await attempt(browser, target, 10_000);
    if (r.verdict === "blank" || r.verdict === "failed") {
      await r.context.close().catch(() => {});
      r = await attempt(browser, target, 25_000);
    }
    await r.context.close().catch(() => {});

    results.push({ ...target, verdict: r.verdict, detail: r.detail, measure: r.m });
    console.log(`${r.verdict.padEnd(9)} ${target.file.padEnd(22)} ${r.detail ?? ""}`);
    if (r.verdict === "captured" && r.m) {
      const rows = r.m.rows;
      console.log(
        `          rows ${rows ? `${rows.count} at ${rows.rowHeight}px, gap ${rows.rowGap}px, pitch ${rows.pitch}px` : "none found"}` +
          ` | label gap ${r.m.labelGap ?? "n/a"}px | data:prose ${r.m.ratio ?? "n/a"}:1`,
      );
    }
  }

  await browser.close();
  writeFileSync(join(OUT, "captures.json"), JSON.stringify(results, null, 2) + "\n");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
