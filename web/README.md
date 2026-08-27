# Sortis web

One Next.js app serving all three surfaces, routed by Host header in
[`src/middleware.ts`](src/middleware.ts):

| host | renders | also reachable at |
| --- | --- | --- |
| `sortis.xyz` | landing | `/` |
| `app.sortis.xyz` | product | `/app` |
| `docs.sortis.xyz` | docs | `/docs` |

The brief lists three Vercel projects. This is one, because three deployments
of the same design system drift apart and the middleware costs twelve lines.
Local development has no subdomains, so every surface is also reachable by
path — `localhost:3000/app/draw` serves what `app.sortis.xyz/draw` serves.

```bash
npm install
npm run dev
```

## The draw column

[`src/components/DrawColumn.tsx`](src/components/DrawColumn.tsx) is the
signature element from section 6 of the brief, and the first UI built.

Sixteen slots on a stone plate, each showing a real truncated ciphertext handle
in `--seal`. A brass token descends the channel one level per beat, sixteen
discrete beats, snapping rather than sliding — each step is a tree level and
easing them together would sell a smooth search rather than a logarithmic one.
Each beat eliminates a candidate; one slot survives, turns brass, and flashes
`--gleam` once.

The readout under the plate counts the real candidate set down — 65,536 to 1 in
sixteen steps — which is where the O(log N) argument actually lands. The
sixteen slots are a window onto the register, not the whole of it.

`prefers-reduced-motion: reduce` renders the resolved state directly. Not a
faster animation and not a crossfade: the final frame, immediately.

## Colour is the privacy model

From section 5, and used consistently everywhere:

| token | meaning |
| --- | --- |
| `--seal` | encrypted |
| `--brass` | drawn |
| `--gleam` | decrypting right now |
| `--graphite` | public and unremarkable |

An encrypted value renders as its real handle in IBM Plex Mono — never
asterisks, never a lock icon, never a blurred number. The interface should look
encrypted at rest.

## Status

Built: the middleware, the token pipeline, wagmi + RainbowKit, the relayer SDK
wrapper, and the draw column. The landing hero and the draw screen shell use it.

Not built: the rest of the landing sections, the Register and Verify screens,
Fumadocs, and any live contract reads. The column runs a local simulation.
