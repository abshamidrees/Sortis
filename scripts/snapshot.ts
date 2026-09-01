import hre from "hardhat";

import { installResilientDns } from "./net";
installResilientDns();

import { writeFileSync, readFileSync } from "fs";
import { join } from "path";

const { ethers } = hre;

/**
 * Freeze everything about this shard that cannot change, into the bundle.
 *
 *     npx hardhat run scripts/snapshot.ts --network sepolia
 *
 * WHY. The free RPC tier answers with 429, and it does so by request COUNT
 * rather than payload size: a two owner multicall of 964 bytes was refused in
 * the same second a sixteen owner one of 7,236 bytes succeeded. A browser
 * loading /app makes far more requests than a script does, because Privy and
 * wagmi make their own before the app makes any, so by the time the register
 * asks for its handles the budget for that second is spent.
 *
 * The fix is not a bigger allowance. It is to stop asking for things that
 * cannot have changed.
 *
 * WHAT GOES IN HERE, and the rule for deciding:
 *
 *   IMMUTABLE          DEPTH, capacity, minDrawInterval. Constructor
 *                      arguments. They cannot change without a redeploy, and
 *                      a redeploy changes the addresses this file records.
 *
 *   APPEND ONLY        leaf to owner. A leaf is assigned once and never
 *                      reassigned, so this can only ever be incomplete, never
 *                      wrong, and the app scans for leaves added since.
 *
 *   SETTLED FOREVER    a draw that has been drawn. Its root, block, prize,
 *                      total weight, walk height and lot handle are fixed for
 *                      all time once lotDrawn is true. An OPEN draw is not
 *                      recorded, because it is still changing.
 *
 * NOT in here, because they genuinely move: every balance handle, the pot,
 * the current block, the seconds until the next draw, and anything scoped to
 * a connected wallet.
 */

const OUT = join(__dirname, "..", "web", "src", "lib", "snapshot.json");

type SettledDraw = {
  id: number;
  rootHandle: string;
  openedAtBlock: number;
  prize: string;
  totalWeight: string;
  walkHeight: number;
  refHour: string;
  resolvedLeaf: string;
  lotHandle: string | null;
  drawnAtBlock: number | null;
};

async function main() {
  const network = hre.network.name;
  const rec = JSON.parse(readFileSync(join(__dirname, "..", "deployments", `${network}.json`), "utf8"));

  const provider = ethers.provider;
  const pool = await ethers.getContractAt("SortisPool", rec.pool);
  const draw = await ethers.getContractAt("SortisDraw", rec.draw);
  const head = await provider.getBlockNumber();

  // ---- immutable shard constants ---------------------------------------
  const depth = Number(await pool.DEPTH());
  const capacity = Number(await pool.capacity());
  const minDrawInterval = Number(await draw.minDrawInterval());

  // ---- append-only leaf assignment --------------------------------------
  const from = Number(process.env.DEPLOY_BLOCK ?? "11578000");
  const topic = ethers.id("LeafAssigned(address,uint256)");
  const owners = new Map<number, string>();
  let failed = 0;
  for (let start = from; start <= head; start += 9_000) {
    const end = Math.min(start + 9_000, head);
    let got = false;
    for (let i = 0; i < 3 && !got; i++) {
      try {
        const logs = await provider.getLogs({ address: rec.pool, topics: [topic], fromBlock: start, toBlock: end });
        for (const l of logs) {
          owners.set(Number(BigInt(l.topics[2])), ethers.getAddress("0x" + l.topics[1].slice(26)));
        }
        got = true;
      } catch {
        await new Promise((r) => setTimeout(r, 2_000 * (i + 1)));
      }
    }
    if (!got) failed++;
  }
  if (failed > 0) {
    throw new Error(
      `${failed} log windows unreadable after three attempts each. Refusing to write an ` +
        `incomplete snapshot: an empty register is a visible bug, a half-full one is a silent one.`,
    );
  }

  const leafCount = Number(await pool.leafCount());
  if (owners.size !== leafCount) {
    throw new Error(`found ${owners.size} LeafAssigned events but leafCount() reports ${leafCount}.`);
  }

  // ---- draws that are settled, and therefore final ----------------------
  const drawCount = Number(await draw.drawCount());
  const drawnTopic = ethers.id("Drawn(uint256,bytes32,bytes32,uint64)");
  const drawnLogs = new Map<number, { lot: string; block: number }>();
  for (let start = from; start <= head; start += 9_000) {
    const end = Math.min(start + 9_000, head);
    try {
      const logs = await provider.getLogs({ address: rec.draw, topics: [drawnTopic], fromBlock: start, toBlock: end });
      for (const l of logs) {
        const id = Number(BigInt(l.topics[1]));
        drawnLogs.set(id, { lot: "0x" + l.data.slice(2, 66), block: l.blockNumber! });
      }
    } catch {
      // A missing Drawn log costs the lot handle, not the draw.
    }
  }

  const settled: SettledDraw[] = [];
  for (let id = 1; id <= drawCount; id++) {
    const info = await draw.drawInfo(id);
    if (!info[5]) continue; // open, still changing, not ours to freeze
    const resolved = await draw.resolvedLeafHandle(id);
    const ev = drawnLogs.get(id);
    settled.push({
      id,
      rootHandle: info[0],
      openedAtBlock: Number(info[1]),
      prize: info[2].toString(),
      totalWeight: info[3].toString(),
      walkHeight: Number(info[4]),
      refHour: info[6].toString(),
      resolvedLeaf: resolved,
      lotHandle: ev?.lot ?? null,
      drawnAtBlock: ev?.block ?? null,
    });
  }

  const out = {
    note:
      "Generated by scripts/snapshot.ts. Everything here is immutable, append only, or settled forever. " +
      "Re-run after seeding or after settling a draw.",
    network,
    pool: rec.pool,
    draw: rec.draw,
    takenAtBlock: head,
    takenAt: new Date().toISOString(),
    shard: { depth, capacity, minDrawInterval },
    leaves: Object.fromEntries([...owners.entries()].sort((a, b) => a[0] - b[0])),
    settledDraws: settled,
  };

  writeFileSync(OUT, JSON.stringify(out, null, 2) + "\n");

  console.log(`snapshot written at block ${head}`);
  console.log(`  shard        depth ${depth}, capacity ${capacity}, interval ${minDrawInterval}s`);
  console.log(`  leaves       ${owners.size}`);
  console.log(`  settled      ${settled.map((d) => `#${d.id} h${d.walkHeight}`).join(", ") || "none"}`);
  console.log(`  drawCount    ${drawCount} (${drawCount - settled.length} open, not recorded)`);
}

main().catch((error) => {
  console.error("SNAPSHOT FAILED:", error?.message ?? error);
  process.exitCode = 1;
});
