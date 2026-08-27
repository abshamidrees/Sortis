# Sortis, final build prompt

Paste this whole document into Claude Code. Attach `docs/BRIEF.md`, `tokens.css`, and the screenshots.

---

## The problem with what is currently shipped

`/app` is a marketing page wearing application chrome. It opens with a 48px Archivo headline and a four-line paragraph that occupy roughly half the viewport and convey nothing a label could not. `/app/register` is eighty percent empty space. Neither reads as software.

**Rule for everything under `/app`: prose is a bug.**

- No headline above 20px on any app route.
- No paragraph longer than two lines, and only where a value genuinely needs explaining.
- Delete "The register, live." and its paragraph entirely. Delete "Your stake" as a page title.
- Labels and numbers. A label is IBM Plex Mono, 11px, uppercase, `--graphite`, tracking `0.08em`. A value is IBM Plex Mono with `font-variant-numeric: tabular-nums`.
- Anything with more than three rows is a table, not a stack of cards.

Marketing routes keep their headlines and prose. This rule applies to `/app` only.

---

## Structural vocabulary to synthesise

Take structure from these, never skin. Every reference below is dark and Sortis is light stone and brass. Do not import a single colour, font, radius or shadow from any of them.

| Source | What to take | Where it goes |
|---|---|---|
| Reya trading | The horizontal stat strip under the nav: seven or eight label-over-value pairs in one 56px row | Persistent across all three app routes |
| Reya trading | Three-panel layout where no single element exceeds half the width | Draw and Register routes |
| Reya trades feed | A dense, scrolling, monospaced event list | Draw history, Register activity |
| Morpho vaults | A real data table with a filter chip row above it | Draw history |
| Morpho portfolio | Sub-tabs inside a route, and the big-number-plus-secondary-metric card | Register position panel |
| Aave Pro | Grouped left navigation with section labels | Docs sidebar only, not the app |
| Aave Pro featured | Compact metric card with an inline sparkline | Stat strip overflow on mobile |

The mix is the point. If any one screen is recognisably one of these sites, it is wrong.

---

## 1. Stat strip

Highest-value single change in this document. Build it first.

Full-width row directly under the nav, 56px tall, `--slab` background, hairline top and bottom. Persistent on all three app routes. Each cell is a mono label above a mono value, cells separated by 1px `--rule` dividers, horizontal scroll below 768px with a right-edge fade.

```
SHARD 001 | HEIGHT 5 | STAKES 12/32 | POT 4.20 cUSDT | DRAW #3
| OPENED 11577168 | DEPTH 4,476,000 / 5,000,000 | SEPOLIA ●
```

- `DEPTH` gets a 2px bar under it filled to 89.5% in `--brass`. The one place on the whole site where the budget constraint is ambient rather than argued.
- `SEPOLIA` gets a 6px `--brass` dot, `--fault` if the RPC is unreachable.
- Every value reads from chain. No hardcoding.

A judge landing on `/app` should learn the entire system state in one glance without scrolling.

---

## 2. Register route

Currently near-empty. Rebuild as an 8/4 split.

**Left, "POSITION" panel.** Label strip, hairline, then a two-column key-value grid:

```
STAKE          0x7f2a…c091   [decrypt]
WEIGHT         0x3b81…44de   [decrypt]
COMMITTED AT   hour 471,203
LEAF INDEX     14
SHARE          encrypted
```

Decrypt swaps the value to `data-state="revealed"` in place. Below the grid, a mono line: `Decrypted in this session only. Nothing is sent anywhere.`

**Left, below the panel, "YOUR ACTIVITY" table.** Columns: TYPE, AMOUNT, BLOCK, HCU, TX. One row per commit or release, newest first, amounts as ciphertext handles, TX linking to Sepolia Etherscan. Empty state is a single mono line inside the table frame, never a floating paragraph.

**Right rail, two stacked forms.** Commit and Release. Each: label strip, amount input, submit button, and a mono cost line under the button reading `commit() 920,000 HCU, flat in shard size`. Pending, mined and failed states named plainly in the button itself.

**Right rail, below the forms, "COST" card.** Commit 920,000. Release 920,000. Draw 4,476,000 of 5,000,000. Three rows, mono, no prose.

**Relayer initialisation must be surfaced, not hidden.** First fetch pulls 4.6 MB of key material and can take up to twenty minutes on a cold cache, 27 seconds once cached. Render a progress line: `Fetching key material, 4.6 MB. First run only.` with bytes received. A spinner that hangs silently for twenty minutes is worse than a slow operation you can watch.

---

## 3. Draw route

**Delete the headline and the paragraph.** Then a 60/40 split.

**Left, the plate.** Keep it, it is the best thing in the build. Add a label strip above it reading `REGISTER, SHARD 001` with `32 / 32` right-aligned. Keep the beat counter and REPLAY in the footer strip.

**Right, two stacked panels.**

`CURRENT DRAW`, as a key-value grid: DRAW ID, ROOT HANDLE, OPENED BLOCK, LOT HANDLE, RESOLVED HANDLE, STATUS. Handles truncated in `.ciphertext` treatment. Status is one of `open`, `drawn`, `claimed`.

`HISTORY`, a table: ID, BLOCK, ROOT, RESOLVED, and a VERIFY link per row routing to `/app/verify?draw=N`. Filter chips above it: All, Drawn, Claimed. This is the Morpho table pattern in stone and brass.

**Wire the column to Sepolia.** Handles come from real `stakeOf` reads. The footnote currently saying the column runs a local simulation must be deleted, because it sits under a route titled "live" and that contradiction is the most damaging thing on the site. If the wiring cannot be finished, rename the route and say what it is. Do not ship the contradiction.

---

## 4. Verify route

Full-width input row: draw id field, VERIFY button, and a mono line stating this works without a wallet.

Then the checks as a table, not cards. Columns: CHECK, EXPECTED, OBSERVED, RESULT. Result is a mono `PASS` in `--brass` or `FAIL` in `--fault`. One row per public fact.

Then, in its own bordered panel below with the label `NOT REPLAYABLE`, the one step a client cannot re-derive and why: every register node is a ciphertext nobody holds a grant on, and publishing per-node decryptions so a verifier could replay the descent would hand everyone the register.

Keep that panel. Naming the limit of your own verifiability is worth more to a cryptography judge than a green checkmark that overclaims.

---

## 5. Bugs to fix

1. **Two connect buttons on `/app`.** One in the nav, one floating in the content area. Delete the floating one.
2. Docs is a placeholder that says six pages are planned and none written. Cut to four real pages: overview, architecture, privacy-model, limitations. A short honest page beats a promise.
3. Verify the chart's provenance line cites the commit that produced the current `drawLot` sweep, not an older walk-only run.
4. Zero console errors on all six routes. Check each one.

---

## 6. Build order

1. Stat strip
2. Draw route rebuild, including wiring the column to Sepolia
3. Register route rebuild
4. Verify route as a table
5. Duplicate connect button and any remaining console errors
6. Docs, four pages
7. README with the corrected `drawLot` table

Screenshot after every component at 1440px and 390px, view the screenshot, critique it against this document, then iterate. Do not batch the screenshots to the end of the session. The last three rounds each shipped a visual bug that DOM assertions passed straight over.

---

## 7. Density check before you call any route done

Open the route at 1440px and answer:

- What fraction of the viewport is text that is not a label or a value? Above ten percent on an app route, cut.
- How many distinct facts are visible without scrolling? Under eight, the screen is too empty.
- Is there a headline above 20px? Delete it.
- Does every panel have a label strip and a hairline? If a panel floats without a frame, it reads unfinished.

---

## 8. Craft standard

Unchanged. No em dashes anywhere, including code comments. No emoji. No placeholder data. Every number traces to a real call or to `src/lib/measurements.ts` with its commit.
