import hre from "hardhat";

import { installResilientDns } from "./net";
installResilientDns();

import { readFileSync } from "fs";
import { join } from "path";

const { ethers } = hre;

/**
 * Report what the register actually holds, before a draw is opened.
 *
 *     npx hardhat run scripts/weights.ts --network sepolia
 *
 * Read-only. Nothing here sends a transaction.
 *
 * WHAT CAN AND CANNOT BE SHOWN. Per-stake weight is an encrypted euint64 that
 * nobody holds a grant on, so this cannot print it and neither can anyone
 * else. What it can print is everything the weight is derived from:
 *
 *   weight_i(T) = intercept_i + balance_i * T
 *
 * and the two public inputs to that, the amount committed at seeding time and
 * the whole hours elapsed since each stake last changed. A stake whose last
 * change is the current hour has accrued nothing, whatever it holds, which is
 * the state the register was in when draw 1 was opened with one weighted leaf.
 *
 * The amounts come from deployments/sepolia-seed.json, which records what this
 * repository sent. They are not read back from chain, because on chain they
 * are ciphertext. The total IS checkable: openDraw publishes it, and the sum
 * of amount times hours should match.
 */

async function main() {
  const network = hre.network.name;
  const rec = JSON.parse(readFileSync(join(__dirname, "..", "deployments", `${network}.json`), "utf8"));

  let seedRecord: { seeded?: { address: string; amount: string }[] } = {};
  try {
    seedRecord = JSON.parse(
      readFileSync(join(__dirname, "..", "deployments", `${network}-seed.json`), "utf8"),
    );
  } catch {
    // Seeding may have been done elsewhere. The chain-side checks still work.
  }
  const amountByOwner = new Map<string, bigint>();
  for (const s of seedRecord.seeded ?? []) {
    amountByOwner.set(s.address.toLowerCase(), BigInt(s.amount));
  }

  const provider = ethers.provider;
  const pool = await ethers.getContractAt("SortisPool", rec.pool);
  const draw = await ethers.getContractAt("SortisDraw", rec.draw);

  const [depth, capacity, leafCount, activeHeight, nowHour, drawCount] = await Promise.all([
    pool.DEPTH(),
    pool.capacity(),
    pool.leafCount(),
    pool.activeHeight(),
    pool.timeUnitsNow(),
    draw.drawCount(),
  ]);

  console.log(`\nshard   ${rec.pool}`);
  console.log(`depth ${depth}  capacity ${capacity}  leaves ${leafCount}  activeHeight ${activeHeight}`);
  console.log(`hour ${nowHour}  draws so far ${drawCount}\n`);

  // Leaf ownership is public: _update writes a visible path of storage slots,
  // so which leaf moved is on chain regardless. Read with ethers rather than
  // viem, which is a dependency of the web app and not of this project.
  const head = await provider.getBlockNumber();
  const from = Number(process.env.DEPLOY_BLOCK ?? "11578000");
  const topic = ethers.id("LeafAssigned(address,uint256)");
  const owners = new Map<number, string>();

  for (let start = from; start <= head; start += 9_000) {
    const end = Math.min(start + 9_000, head);
    try {
      const logs = await provider.getLogs({
        address: rec.pool,
        topics: [topic],
        fromBlock: start,
        toBlock: end,
      });
      for (const l of logs) {
        // topics[1] is the indexed owner, topics[2] the indexed leaf.
        const owner = ethers.getAddress("0x" + l.topics[1].slice(26));
        owners.set(Number(BigInt(l.topics[2])), owner);
      }
    } catch {
      // One unavailable window costs its leaves, not the whole report.
    }
  }

  console.log("leaf  owner        amount        hours  weight contribution");
  console.log("-".repeat(64));

  let weighted = 0;
  let totalExpected = 0n;
  const contributions: bigint[] = [];

  for (const leaf of [...owners.keys()].sort((a, b) => a - b)) {
    const owner = owners.get(leaf)!;
    const lastChange = Number(await pool.lastChangeOf(owner));
    const hours = Math.max(0, Number(nowHour) - lastChange);
    const amount = amountByOwner.get(owner.toLowerCase());
    const contribution = amount !== undefined ? amount * BigInt(hours) : null;

    if (hours > 0) weighted++;
    if (contribution !== null) {
      totalExpected += contribution;
      if (contribution > 0n) contributions.push(contribution);
    }

    console.log(
      `${String(leaf).padStart(4)}  ${owner.slice(0, 10)}  ` +
        `${(amount !== undefined ? amount.toString() : "unknown").padStart(11)}  ` +
        `${String(hours).padStart(5)}  ` +
        `${contribution !== null ? contribution.toString() : "unknown"}`,
    );
  }

  console.log("-".repeat(64));
  console.log(`leaves with a non-zero weight line: ${weighted} of ${owners.size}`);
  console.log(`expected total weight:              ${totalExpected}`);

  if (contributions.length > 1) {
    const min = contributions.reduce((a, b) => (b < a ? b : a));
    const max = contributions.reduce((a, b) => (b > a ? b : a));
    const distinct = new Set(contributions.map(String)).size;
    console.log(`spread:                             ${min} to ${max}, ${distinct} distinct values`);
    console.log(
      distinct > 1
        ? `weighting is varied, so a uniform selection would be visible as a bug.`
        : `WEIGHTS ARE UNIFORM. A weighting bug would be invisible in this draw.`,
    );
  }

  const ready = Number(activeHeight) === 5 && weighted >= 20;
  console.log("");
  console.log(
    ready
      ? `READY. activeHeight is 5 and ${weighted} leaves carry weight.`
      : `NOT READY. activeHeight ${activeHeight} (need 5), ${weighted} weighted leaves (need 20).`,
  );
  process.exitCode = ready ? 0 : 2;
}

main().catch((error) => {
  console.error("FAILED:", error?.message ?? error);
  process.exitCode = 1;
});
