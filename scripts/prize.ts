import hre from "hardhat";

import { installResilientDns } from "./net";
installResilientDns();

import { readFileSync, writeFileSync } from "fs";
import { join } from "path";

const { ethers, fhevm } = hre;

/**
 * Clear the open draws, book real yield, and settle a draw that pays.
 *
 *     npx hardhat run scripts/prize.ts --network sepolia
 *
 * WHY THIS IS ONE SCRIPT AND NOT FOUR RUNS. `initializeCLIApi` downloads the
 * 4.6MB PKE CRS on every process and does not cache it between them, so four
 * invocations is four downloads. The whole sequence runs in one.
 *
 * WHY A NEW DRAW RATHER THAN SETTLING AN EXISTING ONE. `openDraw` calls
 * `yieldAdapter.harvest` and writes the result into the draw, so a draw's prize
 * is fixed at the moment it opens. Draws 3 and 4 were opened from the app when
 * nothing had accrued, and both carry a prize of zero permanently. Accruing now
 * cannot reach back into them. They are settled anyway, because an open draw
 * that will never be settled is worse in the history than a settled one that
 * paid nothing, and every settled draw is independently verifiable.
 */

const ACCRUE = 25_000_000n; // 25 cUSDT, six decimals.

const MAX_FEE = 1_400_000_000n;
const MAX_PRIORITY = 100_000_000n;
const DEPTH_LIMIT = 5_000_000;
const MOCK_DEPTH = 4_476_000;

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
      log(`  retry ${i}`, `${label}: ${(error as Error)?.message?.slice(0, 70)}`);
      await new Promise((r) => setTimeout(r, 5_000 * i));
    }
  }
  throw last;
}

async function main() {
  const network = hre.network.name;
  const rec = JSON.parse(readFileSync(join(__dirname, "..", "deployments", `${network}.json`), "utf8"));

  log("init", "relayer key material");
  await resilient("init", () => fhevm.initializeCLIApi(), 6);

  const [signer] = await ethers.getSigners();
  const provider = ethers.provider;
  const draw = await ethers.getContractAt("SortisDraw", rec.draw, signer);
  const pool = await ethers.getContractAt("SortisPool", rec.pool, signer);
  const yieldAdapter = await ethers.getContractAt("MockYieldAdapter", rec.yieldAdapter, signer);
  const overrides = { maxFeePerGas: MAX_FEE, maxPriorityFeePerGas: MAX_PRIORITY };

  const settle = async (id: bigint) => {
    const info = await draw.drawInfo(id);
    if (info[5]) {
      log("  skip", `draw ${id} already settled`);
      return null;
    }
    const decrypted = await resilient("publicDecrypt", () => fhevm.publicDecrypt([info[0]]));
    const total = ethers.AbiCoder.defaultAbiCoder().decode(
      ["uint256"],
      decrypted.abiEncodedClearValues,
    )[0] as bigint;
    if (total === 0n) throw new Error(`draw ${id} has zero total weight`);

    while ((await provider.getBlockNumber()) <= Number(info[1])) {
      await new Promise((r) => setTimeout(r, 4_000));
    }

    const receipt = await resilient("drawLot", async () =>
      (
        await draw.drawLot(id, decrypted.abiEncodedClearValues, decrypted.decryptionProof, overrides)
      ).wait(),
    );
    const settled = await draw.drawInfo(id);
    let depth: number | null = null;
    let global: number | null = null;
    try {
      const hcu = fhevm.computeTransactionHCU(receipt!);
      depth = hcu.maxHCUDepth;
      global = hcu.globalHCU;
    } catch {
      /* not readable from this receipt */
    }
    log(
      "  settled",
      `draw ${id}  height ${settled[4]}  weight ${total.toLocaleString("en-US")}  prize ${settled[2]}  gas ${receipt!.gasUsed}`,
    );
    return { id, depth, global, total, prize: settled[2] as bigint, walkHeight: Number(settled[4]) };
  };

  // ---- 1. clear the backlog ---------------------------------------------
  const before = await draw.drawCount();
  log("backlog", `draw count ${before}`);
  for (let id = 1n; id <= before; id++) {
    const info = await draw.drawInfo(id);
    if (!info[5]) {
      log("settle", `draw ${id} (prize ${info[2]}, fixed when it opened)`);
      await settle(id);
    }
  }

  // ---- 2. book real yield ------------------------------------------------
  log("accrue", `${Number(ACCRUE) / 1e6} cUSDT into the adapter`);
  await resilient("accrue", async () => (await yieldAdapter.accrue(ACCRUE, overrides)).wait());
  log("  pending", `${await yieldAdapter.pending()}`);

  // ---- 3. open a draw that carries it ------------------------------------
  const wait = Number(await draw.secondsUntilNextDraw());
  if (wait > 0) {
    log("wait", `${wait}s for the draw interval`);
    await new Promise((r) => setTimeout(r, (wait + 5) * 1000));
  }
  log("openDraw", "harvests the accrued yield into the draw");
  await resilient("openDraw", async () => (await draw.openDraw(overrides)).wait());
  const id = await draw.drawCount();
  const opened = await draw.drawInfo(id);
  log("  opened", `draw ${id}  prize ${opened[2]}  block ${opened[1]}  hour ${opened[6]}`);

  // ---- 4. settle it -------------------------------------------------------
  const result = await settle(id);

  // ---- 5. report ----------------------------------------------------------
  const finalInfo = await draw.drawInfo(id);
  console.log("");
  console.log("  THE PAYING DRAW");
  console.log(`  draw id           ${id}`);
  console.log(`  prize             ${Number(finalInfo[2]) / 1e6} cUSDT`);
  console.log(`  total weight      ${finalInfo[3].toLocaleString("en-US")}`);
  console.log(`  walk height       ${finalInfo[4]}`);
  console.log(`  leaves            ${await pool.leafCount()} of ${await pool.capacity()}`);
  console.log(`  adapter pending   ${await yieldAdapter.pending()} (harvested into the draw)`);
  if (result?.depth) {
    const pct = ((result.depth / DEPTH_LIMIT) * 100).toFixed(2);
    const delta = ((result.depth - MOCK_DEPTH) / MOCK_DEPTH) * 100;
    console.log(`  sequential depth  ${result.depth.toLocaleString("en-US")}  ${pct}% of 5,000,000`);
    console.log(`  global HCU        ${result.global!.toLocaleString("en-US")}`);
    console.log(`  vs mock           ${delta.toFixed(2)}%`);
  }

  writeFileSync(
    join(__dirname, "..", "deployments", `${network}-prizedraw.json`),
    JSON.stringify(
      {
        drawId: Number(id),
        prize: finalInfo[2].toString(),
        totalWeight: finalInfo[3].toString(),
        walkHeight: Number(finalInfo[4]),
        sequentialDepth: result?.depth ?? null,
        globalHCU: result?.global ?? null,
        settledAt: new Date().toISOString(),
      },
      null,
      2,
    ) + "\n",
  );
  console.log("\ndone.");
}

main().catch((error) => {
  console.error("FAILED:", error?.message ?? error);
  process.exitCode = 1;
});
