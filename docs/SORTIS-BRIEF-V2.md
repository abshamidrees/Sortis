# Sortis, build brief v2

Supersedes v1 for everything below. Sections 0, 1 and 4 of v1 as rewritten by Claude Code stand. This document replaces v1's sections 6, 7 and 8 entirely and adds the chrome spec that v1 never had.

Date: August 27 2026. Deadline: September 5 23:59 AOE, which is September 6 16:59 PKT.

---

## 0. Corrected numbers

Every figure here is measured, not projected. Anything on the site that disagrees with this table is wrong.

```
stakes   seq depth   of budget    global HCU   of budget   result
    16   3,098,000      61.96%     5,269,896      26.35%   fits
    32   3,826,000      76.52%     7,958,888      39.79%   fits
    64   4,647,000      92.94%    12,408,904      62.04%   fits
   128     reverts           -             -           -   depth budget
```

- **Shard capacity is 64 stakes.** Deployed at height 6. The 65th depositor is rejected, not silently broken.
- **Sequential depth binds, not global.** 774,500 per level, of which 527,000 is evaluating intercept and slope into a weight on the critical path.
- **This makes 64 a hard ceiling.** Global work splits across checkpointed transactions. A chain that is too long does not.
- `commit()` is 920,000 depth: 207,000 from the ERC-7984 transfer settling `transferred`, plus a 713,000 register chain. Flat in shard size.

**92.94% of budget is uncomfortably tight and you should know it.** If the live draw reverts on real Sepolia, drop to height 5 (32 stakes, 76.5%) and redeploy the same day. Do not debug it under deadline pressure. Take the smaller shard.

### The one contract change worth making if there is slack

Materialise the weights once at `openDraw` instead of evaluating intercept and slope at every level of the walk. Each node's evaluation is independent of every other node's, so a snapshot pass bills against the 20,000,000 global budget rather than the 5,000,000 depth budget. `drawLot` then walks a plain weight tree at roughly 247,500 per level instead of 774,500.

This does not make the shard much bigger, because global cost roughly doubles per level and takes over around the same place. What it does is **convert a hard ceiling into a soft one**, because global work is checkpointable and depth is not. That is a materially better story.

Do this only if the live run is green and the frontend is done. If there is no time, put it on the `limitations` page as the named path to raising the ceiling. Stating the fix you did not have time to ship reads as engineering judgement, not as a gap.

---

## 1. What is wrong right now

From the screenshots, in priority order.

1. **There is no top nav on any surface.** The most visible miss and the one a judge notices in the first second.
2. **The chart is broken.** The y-axis label is clipped to "TIAL HCU". Four annotations overlap in the same region and are unreadable. This is the single most important visual on the site and it currently looks like a rendering bug.
3. **The hero is unbalanced.** Content sits at the bottom left under roughly 700px of dead space, the two CTAs from v1 section 7 are missing entirely, and the 64-slot plate overflows the viewport instead of being a bounded object.
4. **`/app` is a landing section, not an application.** A headline and a paragraph, no wallet connect, no controls, no live data.
5. **Vertical rhythm is broken.** Multi-hundred-pixel dead gaps between sections.
6. **The footer says "Not deployed"** while three contracts are live on Sepolia. Env is not wired locally.
7. **A console error ships on every page load.** The Base Account SDK wants `Cross-Origin-Opener-Policy` not set to `same-origin`.
8. **Every section is the same object.** Eyebrow, headline, prose, bordered card. Five times. Nothing carries different visual weight, so nothing reads as important.

Point 8 is the design problem underneath the others. v1 said spend the boldness in one place and that place was the draw column. The column is good. Everything else went so quiet it reads as unfinished rather than restrained.

---

## 2. The chrome v1 never specified

### Top nav, marketing surface

Fixed. 64px tall. Background `--stone` at 92% opacity with `backdrop-filter: blur(12px)`. Hairline bottom in `--rule`. Full width, inner content capped at the same max-width as the page grid.

- **Left:** the mark at 20px, then "Sortis" in Archivo 600, 17px, `--ink`, tracking `-0.02em`. Clicking returns to the top.
- **Centre:** Architecture, Privacy, Verify, Docs. Inter 500, 14px, `--graphite`. Hover to `--ink` over 120ms. No underlines, no pills.
- **Right:** Repo as a text link in `--graphite`, then "Open the app" as a solid `--brass` button, 14px Inter 600, `--stone` text, `--r-card` radius, 8px by 16px padding.
- **Scrolled state:** below 40px the hairline appears, above it there is none. Nothing else changes. No shrinking, no colour shift.
- **Mobile below 768px:** mark and wordmark left, "Open the app" right, nav links collapse into a sheet behind a two-line hamburger.

### Top nav, app surface

Same shell, different contents.

- **Left:** mark and wordmark, then a `--rule` vertical divider, then `SHARD 001` in IBM Plex Mono 12px `--graphite`.
- **Centre:** Register, Draw, Verify as tabs. Active tab is `--ink` with a 2px `--brass` underline. Inactive is `--graphite`.
- **Right:** wallet connect. Themed brass, never RainbowKit's default blue, because that blue is within a shade of `--seal` and in this palette `--seal` means encrypted. A connect button that reads as a privacy state is a real bug.
- **Connected state:** truncated address in IBM Plex Mono, a 6px `--brass` dot, disconnect on click.

### Footer

Read addresses from `NEXT_PUBLIC_*` env. Write the three live addresses into `.env.example` and `.env.local` now:

```
SortisPool       0xe797Ce8f0F642045d93F329054BDF8895A6A505D
SortisDraw       0x4D319809028802278620E06e9FC46414ccAec57A
SortisWrapQueue  0x8ef3E4BA6Fd255Afb1e900E24bbDB188E8efBb46
```

Each links to Sepolia Etherscan. "Not deployed" is a legitimate fallback and should stay in the code, but it must not be what a judge sees.

---

## 3. Hero, rebuilt

`min-height: calc(100vh - 64px)`. Content vertically centred. Twelve-column grid, content in 1 through 6, plate in 7 through 12, 64px gutter.

**Left column, in order:**
- Eyebrow: CONFIDENTIAL PRIZE-LINKED SAVINGS. IBM Plex Mono 12px, `--graphite`, tracking `--track-eyebrow`.
- Headline: "Save. Never lose. Nobody sees." Archivo 800, clamp between 44px and 76px, three lines maximum, tracking `-0.03em`, leading 1.02.
- Subhead: one sentence, Inter 400, 18px, `--graphite`, `max-width: 46ch`.
- Buttons: "Open the app" solid `--brass`, and "Read the architecture" as a ghost with a `--rule` border. 16px gap, side by side, stacked below 640px.
- Under the buttons, a single mono line in `--graphite`: `64 stakes per shard. Six levels. 4,647,000 HCU.`

**Right column, the plate:**
- `max-height: 72vh`, `overflow: hidden`, and a 96px linear-gradient mask fading the bottom edge into `--stone` so it terminates deliberately rather than getting cut off.
- The plate gets a header strip: a hairline, then `REGISTER, SHARD 001` on the left in mono 11px and a live count on the right, `64 / 64`.
- Caption under the plate, mono 11px `--graphite`: `The lot descends six levels. Every slot stays encrypted.`

The plate is a bounded object with a top and a bottom. Right now it is a list that runs off the screen, which reads as a layout failure rather than as depth.

---

## 4. The chart section, rebuilt

**This section gets an inverted ground.** Background `--ink`, text `--stone`, hairlines at `--rule` 20% opacity. It is the only inverted section on the page.

Reason: v1 said spend the boldness in one place, and the draw column took it. But the chart is the argument that wins the bounty, and right now it carries the same visual weight as the footer. Inverting one section solves both the monotony problem and the emphasis problem with one move, and it stays disciplined because it happens exactly once.

**Chart fixes, all mandatory:**

- Reserve a 64px left gutter for the axis label. It currently clips to "TIAL HCU", which looks like a bug and undermines every number next to it.
- **Exactly two annotations. No more.** One label on the 5,000,000 dashed line, set at its left end where the curves are not. One marker dot at 64 with its label placed below the axis, not floating in the plot area.
- Curve endpoint labels go at the end of each curve, right-aligned, on the curve's own colour. "Reverts at 30" on the linear curve, "Reverts at 128" on the Sortis curve. Never in the middle of the plot.
- Linear curve in `--fault`, Sortis curve in `--gleam` so it survives the dark ground.
- Below 768px the chart stays in its own horizontally scrolling container with a right-edge fade. Never shrink the labels.

**Update the provenance line.** It currently cites commit `b741488`, which predates the TWAB rewrite that changed every number. Cite the commit that actually produced the current table.

---

## 5. App screens

Three routes under the app nav. These are applications, not landing sections: no big Archivo headlines, no prose paragraphs, no eyebrows. A section title at 20px and then controls.

### Register
- **Not connected:** a single centred panel, one connect button, one line explaining what happens next. Nothing else on the page.
- **Connected:** a two-column grid.
  - Left, "Your stake": the ciphertext handle in the `.ciphertext` treatment, a "Decrypt" button that runs the relayer user-decryption and swaps to `data-state="revealed"` in place. Below it, your weight, same treatment. A mono line stating the decryption is local to this session.
  - Right, two stacked forms: Commit and Release. Amount input, submit, and a live HCU cost line under each (`commit() 920,000 HCU`). Pending, mined and failed states each named plainly.
- Relayer init takes about 27 seconds when the key material is cached and up to 20 minutes on a cold machine. **Surface that.** A spinner that hangs for twenty minutes with no explanation is worse than a slow operation with a progress line: `Fetching key material, 4.6 MB. First run only.`

### Draw
- Status strip along the top: shard id, stakes filled, pot size in plaintext, current draw id, block, countdown.
- The column, wired to Sepolia rather than the local simulation. Handles come from real `stakeOf` calls.
- Below it, draw history as a table: draw id, root handle, block, resolved handle, and a Verify link per row.

### Verify
The screen most entries will not build, and the bounty explicitly asks for public verifiability.

- One input: a draw id. One button.
- Output: the committed root handle, the block, the lot handle, then the walk re-derived client-side level by level, each level as a row that either matches or does not.
- Terminal line: matches the contract, or does not, in `--brass` or `--fault`.
- This screen must work while disconnected. Verification is a public act and requiring a wallet to perform it contradicts the claim.

---

## 6. Rhythm and the remaining defects

- Section padding: 144px top and bottom on desktop, 80px below 768px. One value, applied by a single `Section` component. The current gaps are several hundred pixels and read as broken layout.
- Fix the COOP console error. Simplest route is trimming the wagmi connector list to injected, MetaMask and WalletConnect, since Sortis does not offer Coinbase Smart Wallet. Alternatively set `Cross-Origin-Opener-Policy: same-origin-allow-popups` in `next.config`. Either way, zero console errors before submission. A judge opening devtools and finding an error on load is a credibility hit disproportionate to the bug.
- Bump Next.js off 15.5.24.
- Confirm `.agents/`, `artifacts/`, `cache/`, `fhevmTemp/`, `typechain-types/` and the four `*-design/` folders are gitignored. They are on disk, which is fine. They must not be in the repo.

---

## 7. Order of work, and what to drop

Live run result first. If `drawLot` reverts on real Sepolia, redeploy at height 5 before anything else.

Then:

1. Top nav, both surfaces
2. Chart section rebuild, inverted ground
3. Hero rebuild
4. Section rhythm and the COOP error
5. Verify screen
6. Register screen
7. Draw screen wired to Sepolia
8. Footer env
9. README with the corrected HCU table
10. Docs, down to four pages: overview, architecture, privacy-model, limitations
11. Demo video

**If time runs short, drop in this order:** docs from four pages to two, then the Register screen, then the Draw screen's history table. **Never drop the nav, the chart, or Verify.** Those three are what the submission is judged on.

Cairn takes five to seven days from September 1. That leaves roughly four working days here. Items 1 through 4 are one day and they are what turns the site from unfinished into finished.

---

## 8. Deployment

Install the Vercel plugin in Claude Code so deploys stop being your job.

```
vercel mcp
```

configures Claude Code against Vercel's hosted endpoint at `mcp.vercel.com`. Then in Claude Code, `/vercel-setup` links the project, `/deploy` pushes to production, and `/vercel-logs` pulls build logs when something breaks.

Scope the token to this project only. Read-only is not enough here because you want deploys, but do not hand it account-wide write.

One deployment, one project, host-header rewrites already handle the three surfaces. Do not create three Vercel projects.

---

## 9. Craft standard

Unchanged from v1 section 13, plus:

- **Zero console errors on any route before submission.**
- Every number on the site traces to `src/lib/measurements.ts`, and every constant there carries the commit that produced it.
- No section may be the same shape as the section above it. If two adjacent sections are both eyebrow, headline, prose, bordered card, one of them is wrong.
