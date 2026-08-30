import hre from "hardhat";

import { installResilientDns } from "./net";

// Must run before any HTTP client is constructed. See scripts/net.ts.
installResilientDns();
import { readFileSync, writeFileSync } from "fs";
import { join } from "path";

const { ethers, fhevm } = hre;

/**
 * Force a REAL walk on Sepolia and measure what it costs.
 *
 *     npx hardhat run scripts/calibrate.ts --network sepolia
 *
 * The first live draw resolved with `walk height 0`: the register held one
 * stake, so `activeHeight()` was zero and `_walk` short-circuited without a
 * single encrypted comparison. It proved the two-transaction flow, the KMS
 * proof and the claim path, and proved nothing at all about the descent.
 *
 * `activeHeight()` is driven by the highest leaf ever written, not by weight,
 * so filling leaves is enough to force a descent even if the new stakes carry
 * no weight yet. This seeds enough of them to reach height 3 and then runs a
 * draw, which gives a real coprocessor number to compare against the mock's.
 *
 * WHY THIS IS THE TEST THAT MATTERS. The shipped shard is height 6 at 92.94%
 * of the depth budget, measured against the FHEVM mock. If the real
 * coprocessor's accounting agrees with the mock at height 3, it will agree at
 * height 6. If it does not, the shard has to shrink, and it is much better to
 * learn that from an eight-leaf probe than from a draw that reverts.
 */

/**
 * Extra depositors to fund and commit. Three more on top of the existing one
 * is four leaves, which is activeHeight 2 and a real two-level descent. Enough
 * to calibrate, and sized to the deployer's remaining Sepolia balance.
 */
const EXTRA_STAKES = Number(process.env.CALIBRATE_STAKES ?? 3);

/**
 * Funding per depositor.
 *
 * ethers reserves gas at maxFeePerGas, not at the current gas price, and a
 * commit is 1.67M gas. At a 2 gwei ceiling that reserve is 0.0034 ETH, so
 * anything below it fails with "insufficient funds" before the transaction is
 * ever submitted, however cheap the block actually turns out to be.
 */
const FUND_PER_ACCOUNT = ethers.parseEther("0.0042");

const STAKE_AMOUNT = 500_000n;

/** What the mock measured, for comparison. From test/HCU.t.ts. */
const MOCK = { 4: 1_549_000, 8: 2_370_000, 16: 3_098_000, 32: 3_826_000, 64: 4_647_000 } as const;

function log(step: string, detail = "") {
  console.log(`[${new Date().toISOString().slice(11, 19)}] ${step}${detail ? "  " + detail : ""}`);
}

async function main() {
  const network = hre.network.name;
  const rec = JSON.parse(readFileSync(join(__dirname, "..", "deployments", `${network}.json`), "utf8"));

  log("init", "relayer key material");
  await fhevm.initializeCLIApi();

  const [deployer] = await ethers.getSigners();
  const provider = ethers.provider;
  const pool = await ethers.getContractAt("SortisPool", rec.pool, deployer);
  const draw = await ethers.getContractAt("SortisDraw", rec.draw, deployer);
  const cusdt = await ethers.getContractAt("MockConfidentialUSDT", rec.cUSDT, deployer);

  log("start", `leaves ${await pool.leafHighWater()}, activeHeight ${await pool.activeHeight()}`);
  log("balance", `${ethers.formatEther(await provider.getBalance(deployer.address))} ETH`);

  // ---- seed extra leaves ------------------------------------------------
  for (let i = 0; i < EXTRA_STAKES; i++) {
    const w = ethers.Wallet.createRandom().connect(provider);
    log(`stake ${i + 1}/${EXTRA_STAKES}`, w.address);

    await (
      await deployer.sendTransaction({ to: w.address, value: FUND_PER_ACCOUNT, gasLimit: 21_000 })
    ).wait();
    await (await cusdt.mint(w.address, STAKE_AMOUNT)).wait();
    const cusdtAs = cusdt.connect(w) as typeof cusdt;
    await (await cusdtAs.setOperator(rec.pool, 2n ** 47n)).wait();

    const enc = await fhevm.createEncryptedInput(rec.pool, w.address).add64(STAKE_AMOUNT).encrypt();
    const poolAs = pool.connect(w) as typeof pool;
    const r = await (await poolAs.commit(enc.handles[0], enc.inputProof)).wait();
    log("  committed", `gas ${r!.gasUsed}  leaves ${await pool.leafHighWater()}`);
  }

  const height = await pool.activeHeight();
  log("register", `leaves ${await pool.leafHighWater()}, activeHeight ${height}`);
  if (height === 0n) throw new Error("activeHeight is still 0, the walk would short-circuit again");

  // ---- a draw that actually descends ------------------------------------
  log("openDraw", "");
  const openReceipt = await (await draw.openDraw()).wait();
  const drawId = await draw.drawCount();
  const info = await draw.drawInfo(drawId);
  log("  opened", `draw ${drawId} at block ${info[1]}  hour ${info[6]}`);

  const decrypted = await fhevm.publicDecrypt([info[0]]);
  const total = ethers.AbiCoder.defaultAbiCoder().decode(
    ["uint256"],
    decrypted.abiEncodedClearValues,
  )[0];
  log("  total weight", `${total}`);
  if (total === 0n) throw new Error("total weight is zero, no stake has crossed an hour yet");

  while ((await provider.getBlockNumber()) <= Number(info[1])) {
    await new Promise((r) => setTimeout(r, 4_000));
  }

  log("drawLot", `descending ${height} levels for real`);
  const lotReceipt = await (
    await draw.drawLot(drawId, decrypted.abiEncodedClearValues, decrypted.decryptionProof)
  ).wait();
  const settled = await draw.drawInfo(drawId);
  log("  drawn", `walk height ${settled[4]}  gas ${lotReceipt!.gasUsed}`);

  // The coprocessor emits the same events on Sepolia as the mock does, so the
  // plugin's HCU accounting may work here too. If it does not, the fact that
  // the transaction succeeded at a known height is still the calibration.
  let realDepth: number | null = null;
  let realGlobal: number | null = null;
  try {
    const hcu = fhevm.computeTransactionHCU(lotReceipt!);
    realDepth = hcu.maxHCUDepth;
    realGlobal = hcu.globalHCU;
    log("  HCU", `depth ${realDepth.toLocaleString("en-US")}  global ${realGlobal.toLocaleString("en-US")}`);
  } catch (e) {
    log("  HCU", `not readable on this network: ${(e as Error).message.slice(0, 70)}`);
  }

  const h = Number(settled[4]) as keyof typeof MOCK;
  const stakes = 2 ** Number(settled[4]);
  const mockDepth = MOCK[(stakes as unknown) as keyof typeof MOCK];

  console.log("");
  console.log(`  walk executed on real Sepolia at height ${settled[4]} (${stakes} stakes)`);
  if (realDepth !== null && mockDepth) {
    const delta = ((realDepth - mockDepth) / mockDepth) * 100;
    console.log(`  mock said ${mockDepth.toLocaleString("en-US")}, chain says ${realDepth.toLocaleString("en-US")}`);
    console.log(`  difference ${delta.toFixed(2)}%`);
    console.log(
      delta > 7
        ? `  MARGIN AT RISK: height 6 sits at 92.94% of budget and this gap would break it.`
        : `  the mock's accounting holds, so 92.94% at height 6 is trustworthy.`,
    );
  } else {
    console.log(`  the descent executed and did not revert, which is the calibration.`);
  }

  writeFileSync(
    join(__dirname, "..", "deployments", `${network}-calibration.json`),
    JSON.stringify(
      {
        network,
        pool: rec.pool,
        drawId: Number(drawId),
        activeHeight: Number(settled[4]),
        stakes,
        drawLotGas: lotReceipt!.gasUsed.toString(),
        openGas: openReceipt!.gasUsed.toString(),
        realDepth,
        realGlobal,
        mockDepth: mockDepth ?? null,
        ranAt: new Date().toISOString(),
      },
      null,
      2,
    ) + "\n",
  );
  console.log("\ncalibration complete.");
}

main().catch((error) => {
  console.error("CALIBRATION FAILED:", error?.message ?? error);
  process.exitCode = 1;
});
