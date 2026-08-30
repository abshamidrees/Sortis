import hre from "hardhat";

import { installResilientDns } from "./net";
installResilientDns();

import { readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { FhevmType } from "@fhevm/hardhat-plugin";

const { ethers, fhevm } = hre;

/**
 * Open and settle a draw over a register that actually carries weight.
 *
 *     npx hardhat run scripts/draw.ts --network sepolia
 *
 * Draw 1 was opened when a single leaf carried weight, so activeHeight was 0,
 * the descent short-circuited, and the draw demonstrated nothing about the
 * mechanism. That draw is permanent history. This opens the next one, and it
 * REFUSES to open at all unless the register is in a state worth drawing from.
 *
 * The gate is two conditions, both read from chain:
 *
 *   activeHeight() == 5          the walk descends five levels, not zero
 *   >= 20 leaves with hours > 0  weight exists and is spread across the tree
 *
 * A stake accrues nothing until the register crosses an hour boundary, so a
 * shard seeded and drawn in the same hour produces a uniform selection by
 * accident. This waits rather than proceeding.
 */

const MIN_HEIGHT = 5;
const MIN_WEIGHTED = 20;

/** What the mock measured for a height 5 shard. test/Calibration.t.ts. */
const MOCK_DEPTH = 4_476_000;
const DEPTH_LIMIT = 5_000_000;

const MAX_FEE = 1_400_000_000n;
const MAX_PRIORITY = 100_000_000n;

function log(step: string, detail = "") {
  console.log(`[${new Date().toISOString().slice(11, 19)}] ${step}${detail ? "  " + detail : ""}`);
}

async function resilient<T>(label: string, fn: () => Promise<T>, attempts = 5): Promise<T> {
  let last: unknown;
  for (let i = 1; i <= attempts; i++) {
    try {
      return await fn();
    } catch (error) {
      last = error;
      if (i === attempts) throw error;
      log(`  retry ${i}`, `${label}: ${(error as Error)?.message?.slice(0, 60)}`);
      await new Promise((r) => setTimeout(r, 5_000 * i));
    }
  }
  throw last;
}

process.on("uncaughtException", (e) => {
  console.error(`INTERRUPTED: ${(e as Error)?.message ?? e}`);
  process.exit(1);
});
process.on("unhandledRejection", (e) => {
  console.error(`INTERRUPTED: ${(e as Error)?.message ?? e}`);
  process.exit(1);
});

async function main() {
  const network = hre.network.name;
  const rec = JSON.parse(readFileSync(join(__dirname, "..", "deployments", `${network}.json`), "utf8"));

  log("init", "relayer key material");
  await resilient("init", () => fhevm.initializeCLIApi(), 6);

  const [signer] = await ethers.getSigners();
  const provider = ethers.provider;
  const pool = await ethers.getContractAt("SortisPool", rec.pool, signer);
  const draw = await ethers.getContractAt("SortisDraw", rec.draw, signer);
  const yieldAdapter = await ethers.getContractAt("MockYieldAdapter", rec.yieldAdapter, signer);
  const overrides = { maxFeePerGas: MAX_FEE, maxPriorityFeePerGas: MAX_PRIORITY };

  // ---- the gate ---------------------------------------------------------
  const owners = await readOwners(provider, rec.pool);
  const countWeighted = async () => {
    const nowHour = Number(await pool.timeUnitsNow());
    let n = 0;
    for (const owner of owners.values()) {
      if (nowHour - Number(await pool.lastChangeOf(owner)) > 0) n++;
    }
    return { nowHour, n };
  };

  let height = Number(await pool.activeHeight());
  let { nowHour, n } = await countWeighted();
  log("gate", `activeHeight ${height}, ${n} of ${owners.size} leaves weighted, hour ${nowHour}`);

  while (height < MIN_HEIGHT || n < MIN_WEIGHTED) {
    if (height < MIN_HEIGHT) {
      throw new Error(`activeHeight is ${height}, need ${MIN_HEIGHT}. Seed more leaves first.`);
    }
    log("wait", `${n} of ${MIN_WEIGHTED} leaves carry weight, waiting for hour ${nowHour + 1}`);
    await new Promise((r) => setTimeout(r, 120_000));
    ({ nowHour, n } = await resilient("gate", countWeighted));
    height = Number(await pool.activeHeight());
  }
  log("gate", `PASSED. activeHeight ${height}, ${n} weighted leaves at hour ${nowHour}`);

  // ---- the draw ---------------------------------------------------------
  log("accrue", "3 cUSDT into the pot");
  await resilient("accrue", async () => (await yieldAdapter.accrue(3_000_000n, overrides)).wait());

  log("openDraw", "committing the register before any randomness exists");
  const openReceipt = await resilient("openDraw", async () => (await draw.openDraw(overrides)).wait());
  const drawId = await draw.drawCount();
  const info = await draw.drawInfo(drawId);
  log("  opened", `draw ${drawId} at block ${info[1]}  prize ${info[2]}  hour ${info[6]}`);

  const decrypted = await resilient("publicDecrypt", () => fhevm.publicDecrypt([info[0]]));
  const total = ethers.AbiCoder.defaultAbiCoder().decode(
    ["uint256"],
    decrypted.abiEncodedClearValues,
  )[0] as bigint;
  log("  total weight", `${total.toLocaleString("en-US")}`);
  if (total === 0n) throw new Error("total weight is zero, the register carries nothing");

  while ((await provider.getBlockNumber()) <= Number(info[1])) {
    await new Promise((r) => setTimeout(r, 4_000));
  }

  log("drawLot", `descending ${height} levels over ${owners.size} stakes`);
  const lotReceipt = await resilient("drawLot", async () =>
    (
      await draw.drawLot(drawId, decrypted.abiEncodedClearValues, decrypted.decryptionProof, overrides)
    ).wait(),
  );
  const settled = await draw.drawInfo(drawId);
  log("  drawn", `walk height ${settled[4]}  gas ${lotReceipt!.gasUsed}`);

  let depth: number | null = null;
  let global: number | null = null;
  try {
    const hcu = fhevm.computeTransactionHCU(lotReceipt!);
    depth = hcu.maxHCUDepth;
    global = hcu.globalHCU;
  } catch {
    log("  HCU", "not readable from this receipt");
  }

  log("claimPrize", "");
  const claimReceipt = await resilient("claim", async () =>
    (await draw.claimPrize(drawId, overrides)).wait(),
  );
  log("  claimed", `gas ${claimReceipt!.gasUsed}`);

  // ---- the number that decides the shard size ---------------------------
  console.log("");
  console.log("  LIVE DRAW ON SEPOLIA");
  console.log(`  draw id           ${drawId}`);
  console.log(`  leaves            ${owners.size}`);
  console.log(`  walk height       ${settled[4]}`);
  console.log(`  total weight      ${total.toLocaleString("en-US")}`);
  console.log(`  drawLot gas       ${lotReceipt!.gasUsed}`);

  let diverged = false;
  if (depth !== null) {
    const pct = ((depth / DEPTH_LIMIT) * 100).toFixed(2);
    const delta = ((depth - MOCK_DEPTH) / MOCK_DEPTH) * 100;
    console.log(`  sequential depth  ${depth.toLocaleString("en-US")}  ${pct}% of 5,000,000`);
    console.log(`  global HCU        ${global!.toLocaleString("en-US")}  of 20,000,000`);
    console.log(`  mock said         ${MOCK_DEPTH.toLocaleString("en-US")}`);
    console.log(`  difference        ${delta.toFixed(2)}%`);
    diverged = Math.abs(delta) >= 1;
    console.log(
      diverged
        ? `\n  *** DIVERGENCE. The shard size rests on the mock's figure and the chain\n      disagrees. At ${pct}% of budget there is no margin. Drop to height 4.`
        : `\n  the mock and the chain agree, so the measured ceiling is trustworthy.`,
    );
  }

  writeFileSync(
    join(__dirname, "..", "deployments", `${network}-livedraw.json`),
    JSON.stringify(
      {
        drawId: Number(drawId),
        leaves: owners.size,
        walkHeight: Number(settled[4]),
        totalWeight: total.toString(),
        openGas: openReceipt!.gasUsed.toString(),
        drawLotGas: lotReceipt!.gasUsed.toString(),
        claimGas: claimReceipt!.gasUsed.toString(),
        sequentialDepth: depth,
        globalHCU: global,
        mockDepth: MOCK_DEPTH,
        diverged,
        ranAt: new Date().toISOString(),
      },
      null,
      2,
    ) + "\n",
  );
  console.log("\ndraw complete.");
}

/** Leaf owners, from the public LeafAssigned log. */
async function readOwners(
  provider: typeof ethers.provider,
  poolAddress: string,
): Promise<Map<number, string>> {
  const head = await provider.getBlockNumber();
  const from = Number(process.env.DEPLOY_BLOCK ?? "11578000");
  const topic = ethers.id("LeafAssigned(address,uint256)");
  const owners = new Map<number, string>();
  for (let start = from; start <= head; start += 9_000) {
    const end = Math.min(start + 9_000, head);
    try {
      const logs = await provider.getLogs({
        address: poolAddress,
        topics: [topic],
        fromBlock: start,
        toBlock: end,
      });
      for (const l of logs) {
        owners.set(Number(BigInt(l.topics[2])), ethers.getAddress("0x" + l.topics[1].slice(26)));
      }
    } catch {
      // One unavailable window costs its leaves, not the whole run.
    }
  }
  return owners;
}

main().catch((error) => {
  console.error("DRAW FAILED:", error?.message ?? error);
  process.exitCode = 1;
});
