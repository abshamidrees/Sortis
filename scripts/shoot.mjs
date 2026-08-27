import { chromium } from "@playwright/test";
import { mkdirSync } from "fs";
import { join } from "path";

/**
 * Screenshot the running site so the design can be looked at rather than
 * assumed.
 *
 *     node scripts/shoot.mjs [baseUrl] [outDir]
 *
 * Captures each surface at desktop and mobile, plus a reduced-motion pass,
 * which is the state the draw column is most likely to get wrong.
 */

const BASE = process.argv[2] ?? "http://127.0.0.1:3138";
const OUT = process.argv[3] ?? join(process.cwd(), "shots");

/**
 * Addressed by path, not by Host header. Chromium refuses to let a client
 * override Host, and the middleware serves every surface by path anyway so
 * that local development works without subdomains.
 */
const SHOTS = [
  { name: "landing-hero", path: "/", width: 1440, height: 900, full: false },
  { name: "landing-desktop", path: "/", width: 1440, height: 900, full: true },
  { name: "landing-mobile", path: "/", width: 390, height: 844, full: true },
  { name: "app-draw", path: "/app/draw", width: 1440, height: 900, full: false },
  { name: "app-verify", path: "/app/verify", width: 1440, height: 900, full: false },
  { name: "docs", path: "/docs", width: 1440, height: 900, full: false },
];

async function main() {
  mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch();

  for (const shot of SHOTS) {
    for (const reduced of [false, true]) {
      if (reduced && shot.full) continue; // one reduced pass per surface is enough
      const context = await browser.newContext({
        viewport: { width: shot.width, height: shot.height },
        deviceScaleFactor: 2,
        reducedMotion: reduced ? "reduce" : "no-preference",
      });
      const page = await context.newPage();

      // Console errors are a submission defect in their own right, so they are
      // collected here rather than left for someone to find in devtools.
      const consoleErrors = [];
      page.on("console", (msg) => {
        if (msg.type() === "error") consoleErrors.push(msg.text().slice(0, 160));
      });
      // The message alone is "Failed to load resource", which names nothing.
      // The request URL is the part that says what to fix.
      page.on("requestfailed", (req) =>
        consoleErrors.push(`requestfailed: ${req.url().slice(0, 120)}`),
      );
      page.on("response", (res) => {
        if (res.status() >= 400) consoleErrors.push(`http ${res.status()}: ${res.url().slice(0, 120)}`);
      });
      page.on("pageerror", (err) => consoleErrors.push(`pageerror: ${err.message.slice(0, 160)}`));

      // "load" rather than "networkidle". A third-party font or an analytics
      // beacon that never settles would otherwise hang the whole run, and the
      // page is painted long before the network goes quiet.
      await page.goto(`${BASE}${shot.path}`, { waitUntil: "load", timeout: 45_000 });

      // Scroll the whole page before capturing. Sections reveal on
      // intersection, and a full-page screenshot stitches without scrolling,
      // so without this everything below the fold is captured mid-reveal.
      if (shot.full) {
        await page.evaluate(async () => {
          const step = window.innerHeight * 0.8;
          for (let y = 0; y < document.body.scrollHeight; y += step) {
            window.scrollTo(0, y);
            await new Promise((r) => setTimeout(r, 120));
          }
          window.scrollTo(0, 0);
        });
        await page.waitForTimeout(700);
      }

      // Let the draw column finish its sixteen beats before capturing, so the
      // shot shows the resolved state rather than a random frame mid-descent.
      await page.waitForTimeout(reduced ? 400 : 2400);

      const file = join(OUT, `${shot.name}${reduced ? "-reduced" : ""}.png`);
      await page.screenshot({ path: file, fullPage: shot.full });
      console.log(`  ${file}`);
      if (consoleErrors.length) {
        for (const e of [...new Set(consoleErrors)]) console.log(`      console: ${e}`);
      }
      await context.close();
    }
  }

  await browser.close();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
