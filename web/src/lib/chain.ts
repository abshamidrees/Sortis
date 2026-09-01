"use client";

import { createPublicClient, http, parseAbiItem, type Address } from "viem";

/**
 * Everything about this shard that cannot change, frozen at build time by
 * scripts/snapshot.ts: the immutable constructor arguments, the append-only
 * leaf assignment, and every draw that has already settled.
 *
 * This is not a cache. Nothing in it can go stale, only incomplete, and the
 * live reads below fill in what came after it. It exists because the free RPC
 * tier answers by request COUNT with 429, and the cheapest request is the one
 * that is never sent.
 */
import LEAF_SNAPSHOT from "./snapshot.json";
import { sepolia } from "viem/chains";

import { CUSDT_ABI, DRAW_ABI, POOL_ABI, YIELD_ABI } from "./abi";
import { ADDRESSES, RPC_FALLBACK } from "./measurements";

/**
 * Event signatures for log queries.
 *
 * Declared with `parseAbiItem` rather than pulled out of the ABI arrays,
 * because narrowing an array member by name gives viem no type to infer the
 * log shape from and every `log.args` comes back as `never`.
 */
const EV_DRAWN = parseAbiItem(
  "event Drawn(uint256 indexed drawId, bytes32 lotHandle, bytes32 resolvedLeafHandle, uint64 totalWeight)"
);
const EV_LEAF_ASSIGNED = parseAbiItem(
  "event LeafAssigned(address indexed owner, uint256 indexed leaf)"
);
const EV_COMMITTED = parseAbiItem(
  "event Committed(address indexed owner, uint256 indexed leaf)"
);
const EV_RELEASED = parseAbiItem(
  "event Released(address indexed owner, uint256 indexed leaf)"
);

/**
 * Reads of the deployed shard.
 *
 * Everything here is a public read over a public RPC and needs no wallet. The
 * stat strip, the draw route and the verify route all run on it, and Verify in
 * particular has to work disconnected: verification is a public act, and
 * requiring a wallet to perform it would contradict the claim.
 */

/**
 * One client, batching hard.
 *
 * These pages read a lot of small values: seven for the stat strip, two per
 * register slot, several per draw. Sent individually that is dozens of
 * eth_calls per page load plus more on every poll, and a free Infura tier
 * answers that with 429.
 *
 * `multicall` collapses them into a single aggregate call, and `batch` on the
 * transport packs whatever is left into one HTTP request. The reads are the
 * same; the request count is not.
 */
export const publicClient = createPublicClient({
  chain: sepolia,
  transport: http(process.env.NEXT_PUBLIC_SEPOLIA_RPC_URL ?? RPC_FALLBACK, {
    batch: { wait: 24 },
    retryCount: 3,
    retryDelay: 400,
  }),
  /*
    batchSize matters as much as the batching.

    viem's automatic multicall batcher defaults to 1024 bytes of calldata per
    aggregate call, so a full register's 48 reads were being SPLIT back into
    several eth_calls after being deliberately collapsed into one. Under rate
    limiting some of those sub-batches were refused, which is how the register
    ended up with a contiguous run of empty slots while the same multicall
    returned 48 of 48 from a node script whose client had no batcher at all.
  */
  batch: { multicall: { wait: 24, batchSize: 8192 } },
});

/**
 * Retry a read that failed for transport reasons.
 *
 * These pages fire reads in parallel bursts, and a throttled provider answers
 * some and drops others with "missing response for request". That is a dropped
 * packet, not a missing function: the same call succeeds a moment later. One
 * dropped read used to blank the stat strip and put "Chain unreachable" under
 * a register that was perfectly reachable.
 */
export async function resilientRead<T>(
  fn: () => Promise<T>,
  attempts = 3
): Promise<T> {
  let last: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (error) {
      last = error;
      await new Promise((r) => setTimeout(r, 400 * (i + 1)));
    }
  }
  throw last;
}

export const POOL = ADDRESSES.pool as Address;
export const DRAW = ADDRESSES.draw as Address;
export const CUSDT = ADDRESSES.cUSDT as Address;
export const YIELD = (process.env.NEXT_PUBLIC_YIELD_ADDRESS ?? "") as Address;

export const CONFIGURED = Boolean(
  ADDRESSES.pool && ADDRESSES.draw && ADDRESSES.cUSDT
);

/**
 * Earliest block worth scanning for this deployment's logs.
 *
 * Public RPCs reject an unbounded `fromBlock: 0` range, which is why the
 * history table came back empty while every direct read on the same page
 * succeeded. Scanning from the deployment instead keeps the range small and
 * costs nothing, since nothing before it can contain this contract's events.
 */
export const DEPLOY_BLOCK = BigInt(
  process.env.NEXT_PUBLIC_DEPLOY_BLOCK ?? "11578000"
);

/**
 * Largest block span one getLogs call may cover.
 *
 * Infura rejects anything wider than 10,000 blocks, and the deployment is
 * already further behind the head than that, so a single query from
 * DEPLOY_BLOCK to latest fails outright and takes the draw history and the
 * register slots down with it. The window only gets wider as the chain
 * advances, so this is not a problem that waits: it is load-bearing.
 */
const LOG_WINDOW = 9_000n;

/**
 * getLogs across an arbitrary span, in windows the provider will accept.
 *
 * Windows are queried oldest first and failures are skipped rather than
 * thrown. One unavailable window should cost the rows inside it, not the whole
 * table: a partial history is useful and an error page is not.
 */
async function getLogsChunked<T>(
  params: Omit<
    Parameters<typeof publicClient.getLogs>[0],
    "fromBlock" | "toBlock"
  >,
  fromBlock: bigint,
  toBlock: bigint
): Promise<T[]> {
  const out: T[] = [];
  let failedWindows = 0;
  let lastError: unknown = null;
  for (let start = fromBlock; start <= toBlock; start += LOG_WINDOW + 1n) {
    const end = start + LOG_WINDOW > toBlock ? toBlock : start + LOG_WINDOW;
    try {
      const logs = await publicClient.getLogs({
        ...params,
        fromBlock: start,
        toBlock: end,
      } as never);
      out.push(...(logs as unknown as T[]));
    } catch (error) {
      // Skip the window, but say so. Swallowing this silently is how the
      // register rendered two stakes out of twenty-four with a clean console.
      failedWindows++;
      lastError = error;
    }
  }
  return out;
}

/**
 * Seconds per accrual unit. SortisTwab.TIME_UNIT.
 *
 * Needed because the two time values the pool exposes are in DIFFERENT UNITS
 * and look interchangeable:
 *
 *   timeUnitsNow()   (block.timestamp - GENESIS) / TIME_UNIT, an hour INDEX
 *   lastChangeOf()   block.timestamp at the last change, raw SECONDS
 *
 * Subtracting the second from the first is meaningless, and because the result
 * is hugely negative it clamps to zero, so every stake reported "0h held" and
 * looked like it carried no weight. The draw gate refused to open on that for
 * hours while all 24 leaves had in fact been accruing the whole time.
 */
const TIME_UNIT_SECONDS = 3600;

/** A ciphertext handle that has never been written. */
export const ZERO_HANDLE = `0x${"0".repeat(64)}` as const;

/**
 * Truncate a handle for display: 0x7f2a…c091.
 *
 * The brand rule: an encrypted value renders as its REAL handle, in IBM Plex
 * Mono, in --seal. Never asterisks, never a lock icon, never a blurred number.
 */
export function truncate(handle: string | null | undefined, size = 4): string {
  if (!handle || handle === ZERO_HANDLE) return "not set";
  const hex = handle.startsWith("0x") ? handle.slice(2) : handle;
  if (hex.length <= size * 2) return `0x${hex}`;
  return `0x${hex.slice(0, size)}…${hex.slice(-size)}`;
}

/** cUSDT has 6 decimals, matching USDT. */
export function formatUnits6(value: bigint): string {
  const whole = value / 1_000_000n;
  const frac = (value % 1_000_000n)
    .toString()
    .padStart(6, "0")
    .replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : `${whole}`;
}

export type ShardState = {
  depth: number;
  capacity: number;
  leafCount: number;
  activeHeight: number;
  hour: bigint;
  pot: bigint;
  drawCount: bigint;
  blockNumber: bigint;
  current: DrawRow | null;
  /** An open draw sitting in front of `current`, when one exists. */
  pendingDraw: DrawRow | null;
  rpcOk: boolean;
};

/**
 * The four states a draw can be in, derived from ONE source.
 *
 *   open     root committed, no lot yet
 *   drawn    lot exists and a leaf is resolved
 *   claimed  a claimPrize has landed for this draw
 *   void     the register moved since the snapshot, so it can never settle
 *
 * Derived from contract state, never from log presence. The app previously
 * showed a badge reading "drawn" beside a lot handle reading "not drawn"
 * beside a populated resolved handle, because the badge came from state and
 * the handle came from an event the RPC had failed to serve. Those three
 * cannot disagree if they all come from the same place.
 */
export type DrawStatus = "open" | "drawn" | "claimed" | "void";

export type DrawRow = {
  id: bigint;
  rootHandle: `0x${string}`;
  openedAtBlock: bigint;
  prize: bigint;
  totalWeight: bigint;
  walkHeight: number;
  lotDrawn: boolean;
  refHour: bigint;
  resolvedLeaf: `0x${string}`;
  status: DrawStatus;
  /**
   * From the Drawn event, when the RPC serves it.
   *
   * NULL MEANS UNKNOWN, NOT ABSENT. `lotDrawn` is the authority on whether a
   * lot exists; this is only the handle's value. Rendering null as "not drawn"
   * is what produced the contradiction this type exists to prevent.
   */
  lotHandle: `0x${string}` | null;
  drawnAtBlock: bigint | null;
};

async function readDraw(id: bigint): Promise<DrawRow> {
  /*
    Settled draws come from the bundle. Only an open one needs the chain.

    A draw that has been drawn is fixed for all time: root, block, prize, total
    weight, walk height and resolved leaf never move again. Re-reading two
    contract calls per settled draw on every page load spent request budget on
    answers that could not have changed.
  */
  const frozen = SETTLED_DRAWS.get(Number(id));
  if (frozen) {
    return {
      id,
      rootHandle: frozen.rootHandle as `0x${string}`,
      openedAtBlock: BigInt(frozen.openedAtBlock),
      prize: BigInt(frozen.prize),
      totalWeight: BigInt(frozen.totalWeight),
      walkHeight: frozen.walkHeight,
      lotDrawn: true,
      refHour: BigInt(frozen.refHour),
      resolvedLeaf: frozen.resolvedLeaf as `0x${string}`,
      status: "drawn",
      lotHandle: (frozen.lotHandle as `0x${string}` | null) ?? null,
      drawnAtBlock:
        frozen.drawnAtBlock === null ? null : BigInt(frozen.drawnAtBlock),
    };
  }

  const [info, resolved] = await Promise.all([
    publicClient.readContract({
      address: DRAW,
      abi: DRAW_ABI,
      functionName: "drawInfo",
      args: [id],
    }),
    publicClient.readContract({
      address: DRAW,
      abi: DRAW_ABI,
      functionName: "resolvedLeafHandle",
      args: [id],
    }),
  ]);
  const [
    rootHandle,
    openedAtBlock,
    prize,
    totalWeight,
    walkHeight,
    lotDrawn,
    refHour,
  ] = info as readonly [
    `0x${string}`,
    bigint,
    bigint,
    bigint,
    number,
    boolean,
    bigint
  ];
  return {
    id,
    rootHandle,
    openedAtBlock,
    prize,
    totalWeight,
    walkHeight,
    lotDrawn,
    refHour,
    resolvedLeaf: resolved as `0x${string}`,
    status: lotDrawn ? "drawn" : "open",
    lotHandle: null,
    drawnAtBlock: null,
  };
}

/**
 * The Drawn events, keyed by draw id.
 *
 * The lot and the resolved leaf are published as HANDLES. Publishing them is
 * what makes the walk auditable, and it costs nothing because they decrypt for
 * nobody without a grant, and no grant is issued for either.
 */
async function readDrawnEvents(): Promise<
  Map<string, { lot: `0x${string}`; block: bigint }>
> {
  const out = new Map<string, { lot: `0x${string}`; block: bigint }>();
  try {
    const head = await publicClient.getBlockNumber();
    const logs = await getLogsChunked<{
      args: { drawId?: bigint; lotHandle?: `0x${string}` };
      blockNumber: bigint | null;
    }>({ address: DRAW, event: EV_DRAWN }, DEPLOY_BLOCK, head);
    for (const log of logs) {
      if (log.args.drawId !== undefined && log.args.lotHandle !== undefined) {
        out.set(log.args.drawId.toString(), {
          lot: log.args.lotHandle,
          block: log.blockNumber!,
        });
      }
    }
  } catch {
    // A node that will not serve a full log range is not a reason to fail the
    // whole page. The handles are supplementary; drawInfo carries the rest.
  }
  return out;
}

/**
 * The Drawn event for one draw, through the chunker.
 *
 * Exported because Verify needs it. It used to call `publicClient.getLogs`
 * directly with an unbounded range, which is exactly the query the provider
 * rejects: "range 17850 exceeds limit of 10000". The chunker existed by then
 * and this call site simply was not moved onto it, so Verify failed in
 * production while every other log query on the site worked.
 */
export async function readDrawnEvent(
  drawId: bigint,
  /**
   * Skip the snapshot and go to the chain.
   *
   * VERIFY MUST PASS TRUE. A screen whose entire purpose is checking what the
   * chain says cannot answer from a file this repository shipped: that would
   * verify the build, not the deployment, and it is exactly the kind of
   * shortcut that makes a verification page worthless. Every other caller is
   * displaying a settled value and may take the frozen one.
   */
  fromChain = false
): Promise<{ lot: `0x${string}`; block: bigint } | null> {
  /*
    A settled draw's lot handle is final, so it is in the bundle.

    This function was a full log scan across every window since deployment,
    run on the draw route and again by Verify, to fetch a value that stopped
    changing the moment the draw settled. On a provider that rate limits by
    request count, that was one of the most expensive things the app did and
    none of it was necessary.
  */
  const frozen = fromChain ? undefined : SETTLED_DRAWS.get(Number(drawId));
  if (frozen?.lotHandle && frozen.drawnAtBlock !== null) {
    return {
      lot: frozen.lotHandle as `0x${string}`,
      block: BigInt(frozen.drawnAtBlock),
    };
  }

  /*
    Start the scan at the block the draw OPENED, not at deployment.

    A Drawn event cannot precede its own openDraw, so every window before that
    is guaranteed empty and scanning them is pure cost. The bound comes from a
    live drawInfo read rather than from the snapshot, so this narrows the
    search without taking the answer on trust: whatever the scan finds is still
    whatever the chain holds.
  */
  const head = await publicClient.getBlockNumber();
  let from = DEPLOY_BLOCK;
  try {
    const info = (await publicClient.readContract({
      address: DRAW,
      abi: DRAW_ABI,
      functionName: "drawInfo",
      args: [drawId],
    })) as readonly [string, bigint, ...unknown[]];
    if (info[1] > 0n) from = info[1];
  } catch {
    // Fall back to the full span rather than skipping blocks that may matter.
  }

  const logs = await getLogsChunked<{
    args: { lotHandle?: `0x${string}` };
    blockNumber: bigint | null;
  }>({ address: DRAW, event: EV_DRAWN, args: { drawId } }, from, head);

  const log = logs[0];
  if (!log?.args?.lotHandle || log.blockNumber === null) return null;
  return { lot: log.args.lotHandle, block: log.blockNumber };
}

/** Everything the stat strip shows, in one round of reads. */
export async function readShardState(): Promise<ShardState> {
  const [
    depth,
    capacity,
    leafCount,
    activeHeight,
    hour,
    drawCount,
    blockNumber,
  ] = await resilientRead(() =>
    Promise.all([
      publicClient.readContract({
        address: POOL,
        abi: POOL_ABI,
        functionName: "DEPTH",
      }),
      publicClient.readContract({
        address: POOL,
        abi: POOL_ABI,
        functionName: "capacity",
      }),
      publicClient.readContract({
        address: POOL,
        abi: POOL_ABI,
        functionName: "leafCount",
      }),
      publicClient.readContract({
        address: POOL,
        abi: POOL_ABI,
        functionName: "activeHeight",
      }),
      publicClient.readContract({
        address: POOL,
        abi: POOL_ABI,
        functionName: "timeUnitsNow",
      }),
      publicClient.readContract({
        address: DRAW,
        abi: DRAW_ABI,
        functionName: "drawCount",
      }),
      publicClient.getBlockNumber(),
    ])
  );

  const count = drawCount as bigint;
  /*
    NO LOG SCAN HERE.

    This used to enrich `current` with the lot handle from the Drawn event,
    which meant a chunked getLogs across every window since deployment on every
    strip poll, on every app route, forever. The strip does not render the lot
    handle. Only the draw route does, and it fetches its own.

    That scan was why /app/register still read "reading" after sixteen seconds
    while competing with the position and activity queries.
  */
  /*
    The latest SETTLED draw, not simply the latest.

    /app/verify already walks back to the newest settled draw and /app did not,
    so opening a draw from the Trigger panel replaced a finished draw showing a
    five level descent with an empty one: total weight 0, lot not drawn, walk
    height 0. The most impressive thing the protocol does was one click away
    behind a history panel, and the landing state was a column of zeroes.

    An unsettled draw is still surfaced, as `pending`, because hiding it would
    make the Trigger control look like it did nothing.
  */
  let current: DrawRow | null = null;
  let pendingDraw: DrawRow | null = null;
  if (count > 0n) {
    const newest = await readDraw(count);
    if (newest.lotDrawn) {
      current = newest;
    } else {
      pendingDraw = newest;
      // Walk back to the newest draw that actually settled. Bounded at four so
      // a long unsettled tail cannot turn one strip poll into a dozen reads.
      for (
        let id = count - 1n, tries = 0;
        id > 0n && tries < 4;
        id--, tries++
      ) {
        const row = await readDraw(id);
        if (row.lotDrawn) {
          current = row;
          break;
        }
      }
      // Nothing has ever settled. Show the open one rather than nothing at all.
      if (!current) current = newest;
    }
  }

  // The pot is what the draw contract already holds plus what has accrued but
  // not been harvested. Both are public: the prize size is not a secret, only
  // who wins it.
  let pending = 0n;
  if (YIELD) {
    try {
      pending = (await publicClient.readContract({
        address: YIELD,
        abi: YIELD_ABI,
        functionName: "pending",
      })) as bigint;
    } catch {
      pending = 0n;
    }
  }

  return {
    depth: Number(depth),
    capacity: Number(capacity),
    leafCount: Number(leafCount),
    activeHeight: Number(activeHeight),
    hour: hour as bigint,
    pot: (current?.prize ?? 0n) + pending,
    drawCount: count,
    blockNumber,
    current,
    pendingDraw,
    rpcOk: true,
  };
}

/** Every draw, newest first. Small numbers, so read them all. */
export async function readDrawHistory(count: bigint): Promise<DrawRow[]> {
  const ids: bigint[] = [];
  for (let i = count; i > 0n; i--) ids.push(i);
  /*
    Retried, like the stat strip's read and unlike this one used to be.

    resilientRead existed and was wired into exactly one call, the strip's
    multicall. So a rate limited free tier served the strip and refused this,
    and the page rendered "Chain unreachable" in the history panel directly
    beneath a header showing a live draw id. One dropped packet should not
    produce two contradictory claims on the same screen.
  */
  /*
    The bulk Drawn scan runs ONLY if a settled draw is missing its lot handle.

    readDraw now returns settled draws from the bundle, lot handle included, so
    for a shard whose draws are all in the snapshot this whole log scan is
    skipped. It was the single most expensive read on the route: a windowed
    getLogs across every block since deployment, on every load, to enrich rows
    that already carried the value.
  */
  const rows = await resilientRead(() => Promise.all(ids.map(readDraw)));
  const missing = rows.some((row) => row.lotDrawn && !row.lotHandle);
  if (!missing) return rows;

  const drawn = await readDrawnEvents().catch(
    () => new Map<string, { lot: `0x${string}`; block: bigint }>()
  );
  return rows.map((row) => {
    const event = drawn.get(row.id.toString());
    return event && !row.lotHandle
      ? { ...row, lotHandle: event.lot, drawnAtBlock: event.block }
      : row;
  });
}

/**
 * The register's slots, as real ciphertext handles.
 *
 * Leaf ownership is public: `_update` writes a visible path of storage slots,
 * so which leaf moved is on chain whatever the frontend does. `LeafAssigned`
 * is the index of that, and `stakeOf` gives each owner's balance handle. The
 * handles decrypt for nobody without a grant, which is exactly why publishing
 * them costs nothing and makes the register auditable.
 */
export type Slot = {
  /**
   * The leaf's owner, from the build-time snapshot. ALWAYS PRESENT.
   *
   * Leaf assignment is immutable, so this is structure rather than state and
   * it is known before the page has spoken to anything. A slot exists because
   * the snapshot says so, never because a read succeeded.
   */
  owner: Address;
  /**
   * The stake ciphertext, read live. NULL MEANS NOT READ YET.
   *
   * This is the only part of a slot that needs the network, and a slot with a
   * null handle is an occupied slot whose balance handle has not arrived, not
   * an empty one. Conflating those is what made a rate limited RPC render an
   * empty register under a header reading 24 / 32.
   */
  handle: `0x${string}` | null;
  /**
   * Whole hours since this stake last changed.
   *
   * A time-scoped position states its age next to its identity, which is the
   * one device worth taking from Pendle: a maturity-dated market reads
   * `reUSDe 102 days` and nowhere else. Hours held is the input to the weight
   * line, so a register slot that shows only a handle is hiding the number
   * that decides the draw.
   *
   * Null for the same reason `handle` is: not read yet.
   */
  hoursHeld: number | null;
};

/**
 * The register's structure, from the bundle, with no network at all.
 *
 * scripts/snapshot-leaves.ts freezes leaf to owner at build time. Leaves are
 * assigned once and never reassigned, so this is not a cache with a staleness
 * problem: it can only be INCOMPLETE, for anyone who committed after the
 * snapshot was taken, and the live scan below picks those up.
 *
 * Everything the register needs in order to DRAW ITSELF is here. Which slots
 * are occupied, and how many. No promise, no retry, no failure mode.
 */
/** Draws that have settled, and are therefore final. Zero network. */
export const SETTLED_DRAWS: ReadonlyMap<
  number,
  (typeof LEAF_SNAPSHOT.settledDraws)[number]
> = new Map(LEAF_SNAPSHOT.settledDraws.map((d) => [d.id, d]));

/** Immutable constructor arguments. Zero network. */
export const SHARD = LEAF_SNAPSHOT.shard;

export const LEAF_OWNERS: ReadonlyMap<number, Address> = new Map(
  Object.entries(LEAF_SNAPSHOT.leaves).map(([leaf, owner]) => [
    Number(leaf),
    owner as Address,
  ])
);

/**
 * The snapshot's pool, so a redeployed pool cannot render stale structure.
 *
 * If these disagree the snapshot describes a register that is no longer the
 * one being displayed, and showing it would be worse than showing nothing.
 */
export const SNAPSHOT_MATCHES_POOL =
  LEAF_SNAPSHOT.pool.toLowerCase() === (ADDRESSES.pool ?? "").toLowerCase();

/**
 * The register as the bundle knows it. Synchronous, and total.
 *
 * Call this to paint the column on first render, before any effect has run.
 * The handles fill in afterwards.
 */
export function slotsFromSnapshot(capacity: number): (Slot | null)[] {
  const slots: (Slot | null)[] = Array.from({ length: capacity }, () => null);
  if (!SNAPSHOT_MATCHES_POOL) return slots;
  for (const [leaf, owner] of LEAF_OWNERS) {
    if (leaf < capacity) slots[leaf] = { owner, handle: null, hoursHeld: null };
  }
  return slots;
}

const SLOT_CACHE_KEY = "sortis.slots";
const SLOT_CACHE_MS = 120_000;

function readSlotCache(): (Slot | null)[] | null {
  try {
    const raw = sessionStorage.getItem(SLOT_CACHE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (Date.now() - parsed.at > SLOT_CACHE_MS) return null;

    /*
      Refuse a partial cache, including one written by an older build.

      Caching used to accept any result with at least one slot in it, so a
      browser that stored ten of twenty-four replays that until the entry
      expires. Checking on read as well as on write means an existing poisoned
      entry is discarded rather than waited out.
    */
    // Handles only. Structure comes from the bundle, so there is nothing here
    // whose absence could blank the register.
    return parsed.slots as (Slot | null)[];
  } catch {
    return null;
  }
}

/**
 * The register's slots, as real ciphertext handles.
 *
 * CACHED FOR TWO MINUTES. A full shard is one log scan plus 48 contract reads,
 * and re-running that on every navigation is what got this app rate limited to
 * 429 by the RPC. The slots only change when somebody commits or releases, so
 * a short cache costs nothing and removes most of the traffic.
 */
export async function readSlotHandles(
  capacity: number
): Promise<(Slot | null)[]> {
  /*
    STRUCTURE FIRST, AND STRUCTURE NEVER FAILS.

    The register begins fully drawn, from the bundle. Which slots are occupied
    is immutable data that scripts/snapshot-leaves.ts froze at build time, so
    it is known before this function has spoken to anything, and no network
    outcome can take it away. Every slot below already exists; the only thing
    this function adds is each one's live handle.

    That inversion is the whole fix. Previously the slot array started empty
    and was populated only if a read succeeded, so a refused RPC produced a
    register of thirty-two empty cells under a header reading 24 / 32, which is
    a confident statement that the shard is unfilled. Structure and state are
    different kinds of thing and only one of them needs the network.
  */
  const slots = slotsFromSnapshot(capacity);

  const owners = new Map(LEAF_OWNERS);

  const cached = readSlotCache();
  if (cached) {
    // The cache only ever holds handles. Structure still comes from above, so
    // a stale or partial cache cannot empty the register either.
    cached.forEach((slot, i) => {
      if (slot && slots[i])
        slots[i] = {
          ...slots[i]!,
          handle: slot.handle,
          hoursHeld: slot.hoursHeld,
        };
    });
    if (cached.every((slot, i) => !slots[i] || slot?.handle)) return slots;
  }

  /*
    The log scan now looks ONLY for leaves added since the snapshot.

    It is the least reliable read in the app and it is no longer load bearing:
    a refused scan costs the newest depositors their slot until the next build,
    rather than costing everyone the whole register.
  */
  try {
    const head = await publicClient.getBlockNumber();
    // Start from the snapshot, never before it. Both as bigints, because
    // Math.max would coerce and lose precision on a block number.
    const snapshotAt = BigInt(LEAF_SNAPSHOT.takenAtBlock);
    const from = snapshotAt > DEPLOY_BLOCK ? snapshotAt : DEPLOY_BLOCK;
    if (head > from) {
      const logs = await getLogsChunked<{
        args: { owner?: Address; leaf?: bigint };
      }>({ address: POOL, event: EV_LEAF_ASSIGNED }, from, head);
      for (const log of logs) {
        if (log.args.owner !== undefined && log.args.leaf !== undefined) {
          owners.set(Number(log.args.leaf), log.args.owner);
          const leaf = Number(log.args.leaf);
          if (leaf < capacity && !slots[leaf]) {
            slots[leaf] = {
              owner: log.args.owner,
              handle: null,
              hoursHeld: null,
            };
          }
        }
      }
    }
  } catch {
    // Only the leaves added since the snapshot are missing, and the register
    // still renders everything the snapshot knows about.
    console.warn("sortis: could not scan for leaves added since the snapshot.");
  }

  /*
    The chain's clock, falling back to the browser's.
    
    hoursHeld is whole hours, so a few seconds of drift between a Sepolia block
    timestamp and the local clock cannot change the rendered figure. Making the
    whole register wait on one more network read, and fail with it, buys
    nothing at that resolution.
  */
  let nowSeconds = Math.floor(Date.now() / 1000);
  try {
    nowSeconds = Number((await publicClient.getBlock()).timestamp);
  } catch {
    // Local clock it is.
  }

  /*
    ONE multicall, not 48 reads.

    Every owner needs stakeOf and lastChangeOf, so a full shard is 64 calls.
    Issued as separate readContract calls they rely on viem batching them
    heuristically, and on a free RPC tier that is answered with 429: the
    register rendered nothing on a cold load while the console stayed clean,
    because each call was individually "fine" and simply refused.

    `multicall` sends them as a single eth_call through the Multicall3
    aggregator, so the whole register is one request. allowFailure keeps a
    single bad slot from voiding the rest.
  */
  const entries = [...owners.entries()].filter(([leaf]) => leaf < capacity);

  /*
    CHUNKED, AND EACH CHUNK RETRIED.

    A full register in one aggregate call is 48 reads and about 10.8KB of
    calldata, and that request was being refused in the browser while the
    identical call succeeded from a node script against the same endpoint.
    Rather than keep bisecting a provider's undocumented limits, this asks for
    less at a time and asks again when a chunk is dropped.

    Eight owners per chunk is 16 reads and roughly 3.6KB, which has proved
    reliable, and three chunks issued in parallel are still far fewer requests
    than the 48 individual reads this replaced. resilientRead retries each one
    independently, so a single dropped packet costs one chunk's slots for one
    attempt rather than emptying the register.
  */
  const OWNERS_PER_CHUNK = 8;
  const chunks: (typeof entries)[] = [];
  for (let i = 0; i < entries.length; i += OWNERS_PER_CHUNK) {
    chunks.push(entries.slice(i, i + OWNERS_PER_CHUNK));
  }

  const chunkResults = await Promise.all(
    chunks.map((chunk) =>
      resilientRead(() =>
        publicClient.multicall({
          allowFailure: true,
          // Never split further: the chunk size above is the request size.
          batchSize: 0,
          contracts: chunk.flatMap(([, owner]) => [
            {
              address: POOL,
              abi: POOL_ABI,
              functionName: "stakeOf",
              args: [owner],
            } as const,
            {
              address: POOL,
              abi: POOL_ABI,
              functionName: "lastChangeOf",
              args: [owner],
            } as const,
          ]),
        })
      ).catch(() =>
        // A chunk that exhausted its retries yields failures for its own
        // slots, in the shape the mapping below expects, and leaves the rest
        // of the register alone.
        chunk.flatMap(() => [
          {
            status: "failure" as const,
            error: new Error("chunk unavailable"),
            result: undefined,
          },
          {
            status: "failure" as const,
            error: new Error("chunk unavailable"),
            result: undefined,
          },
        ])
      )
    )
  );

  const results = chunkResults.flat();

  let failed = 0;
  entries.forEach(([leaf], i) => {
    const handleResult = results[i * 2];
    const changeResult = results[i * 2 + 1];
    const existing = slots[leaf];
    if (!existing) return;

    /*
      A FAILED READ LEAVES THE SLOT STANDING.

      This used to write null here, which deleted a leaf the snapshot knows
      exists because one eth_call was refused. The slot is occupied whatever
      the RPC says; only its handle is unknown, and `handle: null` already
      means exactly that.
    */
    if (
      handleResult?.status !== "success" ||
      changeResult?.status !== "success"
    ) {
      failed++;
      return;
    }

    const handle = handleResult.result as `0x${string}`;
    slots[leaf] = {
      ...existing,
      /*
        A zero handle is a leaf whose stake has been fully released. The leaf
        is still assigned and still occupies its slot, so this keeps the slot
        and records that there is no ciphertext to show, rather than pretending
        the depositor was never here.
      */
      handle: handle === ZERO_HANDLE ? null : handle,
      hoursHeld: Math.max(
        0,
        Math.floor(
          (nowSeconds - Number(changeResult.result)) / TIME_UNIT_SECONDS
        )
      ),
    };
  });

  if (failed > 0) {
    console.warn(
      `sortis: ${failed} of ${entries.length} register slots could not be read`
    );
  }

  /*
    NEVER CACHE AN EMPTY REGISTER.

    Caching unconditionally meant one failed read poisoned the next two
    minutes: the register found no owners, wrote all-nulls, and every
    subsequent call returned that without retrying. A shard with leaves that
    reads as empty is a failure, not a result, and failures must not be
    remembered.
  */
  /*
    CACHE ONLY A COMPLETE READ.

    This used to cache whenever ANY slot came back, which meant a partial read
    was stored and then replayed for the whole cache window. The register sat
    at ten of twenty-four filled, identically, on every load, and the cache
    made a transient failure look like a permanent one. An all-null result was
    already refused; a partial one is the same bug with a smaller blast radius.

    A read is complete when every owner the snapshot knows about resolved.
  */
  /*
    The cache holds HANDLES, and only a complete set of them.

    Structure is never cached because it is never fetched, so a cache miss or a
    poisoned entry can no longer empty the register: the worst it can do is
    leave the handles unread, which the slots already express.
  */
  const withHandles = slots.filter((slot) => slot?.handle).length;
  const expected = [...owners.keys()].filter((leaf) => leaf < capacity).length;

  if (expected > 0 && failed === 0) {
    try {
      sessionStorage.setItem(
        SLOT_CACHE_KEY,
        JSON.stringify({ at: Date.now(), slots })
      );
    } catch {
      // A private window refuses storage. The reads still work, they just repeat.
    }
  } else if (expected > 0) {
    console.warn(
      `sortis: ${withHandles} of ${expected} slot handles read. Structure is from the bundle and is unaffected.`
    );
  }

  return slots;
}

export type Position = {
  hasLeaf: boolean;
  leaf: number | null;
  stakeHandle: `0x${string}`;
  weightHandle: `0x${string}`;
  lastChange: number;
  walletHandle: `0x${string}`;
  isOperator: boolean;
  /** Whole hours since the last balance change. Drives the weight line. */
  hoursHeld: number;
  /** Leaves in use, so a position can state its share of the shard. */
  leafCount: number;
  capacity: number;
};

export async function readPosition(account: Address): Promise<Position> {
  const [
    hasLeaf,
    stakeHandle,
    weightHandle,
    lastChange,
    walletHandle,
    isOperator,
  ] = await resilientRead(() =>
    Promise.all([
      publicClient.readContract({
        address: POOL,
        abi: POOL_ABI,
        functionName: "hasLeaf",
        args: [account],
      }),
      publicClient.readContract({
        address: POOL,
        abi: POOL_ABI,
        functionName: "stakeOf",
        args: [account],
      }),
      publicClient.readContract({
        address: POOL,
        abi: POOL_ABI,
        functionName: "interceptOf",
        args: [account],
      }),
      publicClient.readContract({
        address: POOL,
        abi: POOL_ABI,
        functionName: "lastChangeOf",
        args: [account],
      }),
      publicClient.readContract({
        address: CUSDT,
        abi: CUSDT_ABI,
        functionName: "confidentialBalanceOf",
        args: [account],
      }),
      publicClient.readContract({
        address: CUSDT,
        abi: CUSDT_ABI,
        functionName: "isOperator",
        args: [account, POOL],
      }),
    ])
  );

  const [block, leafCount, capacity] = await resilientRead(() =>
    Promise.all([
      publicClient.getBlock(),
      publicClient.readContract({
        address: POOL,
        abi: POOL_ABI,
        functionName: "leafCount",
      }),
      publicClient.readContract({
        address: POOL,
        abi: POOL_ABI,
        functionName: "capacity",
      }),
    ])
  );

  let leaf: number | null = null;
  if (hasLeaf as boolean) {
    leaf = Number(
      await publicClient.readContract({
        address: POOL,
        abi: POOL_ABI,
        functionName: "leafOf",
        args: [account],
      })
    );
  }

  return {
    hasLeaf: hasLeaf as boolean,
    leaf,
    stakeHandle: stakeHandle as `0x${string}`,
    weightHandle: weightHandle as `0x${string}`,
    lastChange: Number(lastChange),
    walletHandle: walletHandle as `0x${string}`,
    isOperator: isOperator as boolean,
    hoursHeld: Math.max(
      0,
      Math.floor(
        (Number(block.timestamp) - Number(lastChange)) / TIME_UNIT_SECONDS
      )
    ),
    leafCount: Number(leafCount),
    capacity: Number(capacity),
  };
}

export type ActivityRow = {
  kind: "Committed" | "Released";
  block: bigint;
  tx: `0x${string}`;
  leaf: bigint;
};

export async function readActivity(account: Address): Promise<ActivityRow[]> {
  const head = await publicClient.getBlockNumber();
  type PoolLog = {
    args: { leaf?: bigint };
    blockNumber: bigint | null;
    transactionHash: `0x${string}` | null;
  };
  // Both events in ONE pass. Committed and Released share their indexed
  // signature, so a single filter matches both and halves the number of
  // windows the provider has to serve.
  const logs = await getLogsChunked<PoolLog & { eventName?: string }>(
    {
      address: POOL,
      events: [EV_COMMITTED, EV_RELEASED],
      args: { owner: account },
    },
    DEPLOY_BLOCK,
    head
  );

  const committed = logs.filter((l) => l.eventName === "Committed");
  const released = logs.filter((l) => l.eventName === "Released");

  const rows: ActivityRow[] = [
    ...committed.map((l) => ({
      kind: "Committed" as const,
      block: l.blockNumber!,
      tx: l.transactionHash!,
      leaf: l.args.leaf ?? 0n,
    })),
    ...released.map((l) => ({
      kind: "Released" as const,
      block: l.blockNumber!,
      tx: l.transactionHash!,
      leaf: l.args.leaf ?? 0n,
    })),
  ];

  return rows.sort((a, b) => Number(b.block - a.block));
}
