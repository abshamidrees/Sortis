import hre from "hardhat";

import { installResilientDns } from "./net";

// Must run before any HTTP client is constructed. See scripts/net.ts.
installResilientDns();
import { readFileSync, writeFileSync } from "fs";
import { join } from "path";

const { ethers, fhevm } = hre;

/**
 * Fill the shard, then run a draw that actually descends.
 *
 *     npx hardhat run scripts/seed.ts --network sepolia
 *
 * Every live draw so far resolved with `walk height 0`, because the register
 * held one stake carrying weight and `activeHeight` short-circuits at that
 * point. A draw that performs zero encrypted comparisons proves nothing about
 * the mechanism this whole submission argues for.
 *
 * This seeds to TARGET_LEAVES with VARIED amounts, waits for the register to
 * cross an hour boundary so every stake carries weight proportional to what it
 * holds, and then draws. The spread matters: with equal stakes a correct
 * weighted selection and a uniform one are indistinguishable, so a uniform
 * bug would pass unnoticed.
 */

const TARGET_LEAVES = Number(process.env.SEED_TARGET ?? 24);

/**
 * Stake sizes, in cUSDT base units. A 15x spread between the smallest and the
 * largest, so the weighting is visible in the outcome rather than assumed.
 */
const AMOUNTS = [
  3_000_000n, 200_000n, 1_400_000n, 450_000n, 2_600_000n, 320_000n, 900_000n, 1_800_000n,
  260_000n, 2_100_000n, 640_000n, 1_150_000n, 380_000n, 2_900_000n, 520_000n, 1_600_000n,
  240_000n, 1_050_000n, 780_000n, 2_400_000n, 420_000n, 1_300_000n, 610_000n, 1_950_000n,
];

/** Explicit gas pricing. ethers reserves at maxFeePerGas, not at the going
 *  rate, so leaving it to the default doubles what each account has to hold. */
const MAX_FEE = 1_600_000_000n; // 1.6 gwei
const MAX_PRIORITY = 100_000_000n; // 0.1 gwei
const FUND_PER_ACCOUNT = ethers.parseEther("0.0032");

/**
 * A dropped socket must not lose twenty minutes of work.
 *
 * The relayer is in eu-west-1 and this link drops connections often enough
 * that a twenty minute run is unlikely to finish uninterrupted. undici throws
 * ConnectTimeoutError from its own timer, outside any promise this script
 * awaits, so a try/catch around the call cannot see it and the process dies.
 *
 * Exiting cleanly is the right response: the script resumes from the register's
 * own leaf count, so re-running continues where it stopped rather than
 * starting over or double-seeding.
 */
process.on("uncaughtException", (error) => {
  console.error(`INTERRUPTED: ${(error as Error)?.message ?? error}`);
  console.error("Progress is on chain. Re-run to continue from the current leaf count.");
  process.exit(1);
});
process.on("unhandledRejection", (error) => {
  console.error(`INTERRUPTED: ${(error as Error)?.message ?? error}`);
  console.error("Progress is on chain. Re-run to continue from the current leaf count.");
  process.exit(1);
});

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
      const message = error instanceof Error ? error.message : String(error);
      if (i === attempts) throw error;
      log(`  retry ${i}`, `${label}: ${message.slice(0, 60)}`);
      await new Promise((r) => setTimeout(r, 4_000 * i));
    }
  }
  throw last;
}

async function main() {
  const network = hre.network.name;
  const path = join(__dirname, "..", "deployments", `${network}.json`);
  const rec = JSON.parse(readFileSync(path, "utf8"));

  log("init", "relayer key material");
  await resilient("initializeCLIApi", () => fhevm.initializeCLIApi(), 6);

  const [deployer] = await ethers.getSigners();
  const provider = ethers.provider;
  const pool = await ethers.getContractAt("SortisPool", rec.pool, deployer);
  const draw = await ethers.getContractAt("SortisDraw", rec.draw, deployer);
  const cusdt = await ethers.getContractAt("MockConfidentialUSDT", rec.cUSDT, deployer);
  const yieldAdapter = await ethers.getContractAt("MockYieldAdapter", rec.yieldAdapter, deployer);

  const startLeaves = Number(await pool.leafCount());
  const need = Math.max(0, TARGET_LEAVES - startLeaves);

  console.log(`\nshard ${rec.pool}  depth ${rec.depth}  capacity ${2 ** rec.depth}`);
  console.log(`leaves ${startLeaves}, seeding ${need} more to reach ${TARGET_LEAVES}`);
  console.log(`balance ${ethers.formatEther(await provider.getBalance(deployer.address))} ETH\n`);

  const overrides = { maxFeePerGas: MAX_FEE, maxPriorityFeePerGas: MAX_PRIORITY };
  const seeded: { address: string; amount: string }[] = [];

  for (let i = 0; i < need; i++) {
    const amount = AMOUNTS[(startLeaves + i) % AMOUNTS.length];
    const w = ethers.Wallet.createRandom().connect(provider);
    log(`stake ${i + 1}/${need}`, `${amount} to ${w.address.slice(0, 10)}`);

    await resilient("fund", async () =>
      (
        await deployer.sendTransaction({
          to: w.address,
          value: FUND_PER_ACCOUNT,
          gasLimit: 21_000,
          ...overrides,
        })
      ).wait(),
    );
    await resilient("mint", async () => (await cusdt.mint(w.address, amount, overrides)).wait());

    const cusdtAs = cusdt.connect(w) as typeof cusdt;
    await resilient("setOperator", async () =>
      (await cusdtAs.setOperator(rec.pool, 2n ** 47n, overrides)).wait(),
    );

    const enc = await resilient("encrypt", () =>
      fhevm.createEncryptedInput(rec.pool, w.address).add64(amount).encrypt(),
    );
    const poolAs = pool.connect(w) as typeof pool;
    const r = await resilient("commit", async () =>
      (await poolAs.commit(enc.handles[0], enc.inputProof, overrides)).wait(),
    );

    seeded.push({ address: w.address, amount: amount.toString() });
    // Written after every stake, not at the end. A crash twenty stakes in
    // should not lose the record of what was seeded.
    writeFileSync(
      join(__dirname, "..", "deployments", `${network}-seed.json`),
      JSON.stringify({ network, pool: rec.pool, seeded }, null, 2),
    );
    log("  committed", `gas ${r!.gasUsed}  leaves ${await pool.leafCount()}`);
  }

  const leaves = Number(await pool.leafCount());
  const height = Number(await pool.activeHeight());
  log("register", `leaves ${leaves}, activeHeight ${height}`);

  writeFileSync(
    join(__dirname, "..", "deployments", `${network}-seed.json`),
    JSON.stringify({ network, pool: rec.pool, leaves, height, seeded }, null, 2) + "\n",
  );

  // ---- wait for weight --------------------------------------------------
  // A stake accrues nothing until the register crosses an hour boundary, and
  // a draw over stakes that all carry zero weight is uniform by accident.
  const startHour = await pool.timeUnitsNow();
  log("hour", `${startHour} now, waiting for the next boundary so every stake carries weight`);
  while ((await resilient("hour", () => pool.timeUnitsNow())) === startHour) {
    await new Promise((r) => setTimeout(r, 60_000));
  }
  log("hour", `${await pool.timeUnitsNow()}, every stake now carries weight`);

  // ---- the draw ---------------------------------------------------------
  log("accrue", "2 cUSDT of yield into the pot");
  await resilient("accrue", async () => (await yieldAdapter.accrue(2_000_000n, overrides)).wait());

  log("openDraw", "committing the register before any randomness exists");
  const openReceipt = await resilient("openDraw", async () =>
    (await draw.openDraw(overrides)).wait(),
  );
  const drawId = await draw.drawCount();
  const info = await draw.drawInfo(drawId);
  log("  opened", `draw ${drawId} at block ${info[1]}  prize ${info[2]}`);

  const decrypted = await resilient("publicDecrypt", () => fhevm.publicDecrypt([info[0]]));
  log("  total weight", `${ethers.AbiCoder.defaultAbiCoder().decode(["uint256"], decrypted.abiEncodedClearValues)[0]}`);

  while ((await provider.getBlockNumber()) <= Number(info[1])) {
    await new Promise((r) => setTimeout(r, 4_000));
  }

  log("drawLot", `descending ${height} levels over ${leaves} stakes`);
  const lotReceipt = await resilient("drawLot", async () =>
    (
      await draw.drawLot(
        drawId,
        decrypted.abiEncodedClearValues,
        decrypted.decryptionProof,
        overrides,
      )
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

  // What the mock measured for the same shard, from test/Calibration.t.ts.
  const MOCK_DEPTH_BY_HEIGHT: Record<number, number> = {
    2: 2_199_000,
    3: 3_020_000,
    4: 3_748_000,
    5: 4_476_000,
  };
  const mock = MOCK_DEPTH_BY_HEIGHT[Number(settled[4])];

  console.log("");
  console.log(`  LIVE DRAW ON SEPOLIA`);
  console.log(`  leaves            ${leaves}`);
  console.log(`  walk height       ${settled[4]}`);
  console.log(`  drawLot gas       ${lotReceipt!.gasUsed}`);
  if (depth !== null) {
    console.log(`  sequential depth  ${depth.toLocaleString("en-US")}  of 5,000,000`);
    console.log(`  global HCU        ${global!.toLocaleString("en-US")}  of 20,000,000`);
    if (mock) {
      const delta = ((depth - mock) / mock) * 100;
      console.log(`  mock said         ${mock.toLocaleString("en-US")}`);
      console.log(`  difference        ${delta.toFixed(2)}%`);
      console.log(
        Math.abs(delta) < 1
          ? `  the mock and the chain agree.`
          : `  MOCK AND CHAIN DISAGREE. The shard size rests on the mock's figure.`,
      );
    }
  }

  writeFileSync(
    join(__dirname, "..", "deployments", `${network}-livedraw.json`),
    JSON.stringify(
      {
        drawId: Number(drawId),
        leaves,
        walkHeight: Number(settled[4]),
        totalWeight: settled[3].toString(),
        drawLotGas: lotReceipt!.gasUsed.toString(),
        openGas: openReceipt!.gasUsed.toString(),
        sequentialDepth: depth,
        globalHCU: global,
        mockDepth: mock ?? null,
        ranAt: new Date().toISOString(),
      },
      null,
      2,
    ) + "\n",
  );
  console.log("\nseed and draw complete.");
}

main().catch((error) => {
  console.error("SEED FAILED:", error?.message ?? error);
  process.exitCode = 1;
});
