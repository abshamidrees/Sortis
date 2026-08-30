import { expect } from "chai";
import hre from "hardhat";

import type { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

const { ethers, fhevm } = hre;

/**
 * Does the FHEVM mock's HCU accounting match the real coprocessor's?
 *
 * The whole shard size rests on it. `test/HCU.t.ts` measures the ceiling
 * against the mock and the product is designed around that number, so if the
 * chain disagrees the shard is wrong.
 *
 * scripts/calibrate.ts ran a real draw on Sepolia at active height 2 and the
 * coprocessor reported 2,199,000 of depth. This measures the SAME call, the
 * same way, against the mock, so the two are comparable.
 *
 * Comparing against the walk-only harness number instead would be wrong by
 * about 1,177,000, because `drawLot` reduces the lot modulo the published
 * total first and `FHE.rem` is a 1,153,000 chain that everything after it
 * hangs off.
 */

/** What the real Sepolia coprocessor reported. deployments/sepolia-calibration.json. */
const SEPOLIA_DRAWLOT_HEIGHT_2 = 2_199_000;

/** Tolerance. The two implementations should agree closely or not at all. */
const TOLERANCE = 0.05;

const HOUR = 3_600;

/**
 * The sweep in test/HCU.t.ts measures the WALK. A draw is more than the walk:
 * `drawLot` reduces the lot modulo the published total first, and `FHE.rem` is
 * a 1,153,000 chain that the whole descent then hangs off. So the shard size
 * has to be set by what `drawLot` costs, not by what `_walk` costs, and this
 * finds that ceiling the same way, by sweeping until it reverts.
 */
describe("the drawLot ceiling", function () {
  let deployer: HardhatEthersSigner;

  before(async function () {
    if (!fhevm.isMock) this.skip();
    [deployer] = await ethers.getSigners();
  });

  async function drawAtHeight(height: number) {
    const usdt = await (await ethers.getContractFactory("MockConfidentialUSDT", deployer)).deploy();
    await usdt.waitForDeployment();
    const usdtAddress = await usdt.getAddress();

    const pool = await (
      await ethers.getContractFactory("SortisPoolHarness", deployer)
    ).deploy(usdtAddress, 6);
    await pool.waitForDeployment();
    const poolAddress = await pool.getAddress();

    const yieldAdapter = await (
      await ethers.getContractFactory("MockYieldAdapter", deployer)
    ).deploy(usdtAddress);
    await yieldAdapter.waitForDeployment();

    const draw = await (
      await ethers.getContractFactory("SortisDraw", deployer)
    ).deploy(poolAddress, await yieldAdapter.getAddress(), 0);
    await draw.waitForDeployment();
    await (await pool.setDrawContract(await draw.getAddress())).wait();

    // One stake at leaf 0 to carry the weight, and one at the far end so that
    // activeHeight is exactly `height`.
    await (await pool.seedAt(0, 1_000_000n)).wait();
    if (height > 0) await (await pool.seedAt(2 ** height - 1, 1_000n)).wait();

    await ethers.provider.send("evm_increaseTime", [HOUR + 60]);
    await ethers.provider.send("evm_mine", []);
    expect(await pool.activeHeight(), `height for ${2 ** height} stakes`).to.equal(height);

    await (await draw.openDraw()).wait();
    const drawId = await draw.drawCount();
    const [rootHandle] = await draw.drawInfo(drawId);
    const decrypted = await fhevm.publicDecrypt([rootHandle]);

    try {
      const receipt = await (
        await draw.drawLot(drawId, decrypted.abiEncodedClearValues, decrypted.decryptionProof)
      ).wait();
      const hcu = fhevm.computeTransactionHCU(receipt!);
      return { fits: true, depth: hcu.maxHCUDepth, global: hcu.globalHCU };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        fits: false,
        depth: null,
        global: null,
        binding: message.includes("HCUTransactionDepthLimitExceeded") ? "depth" : "global",
      } as const;
    }
  }

  it("sweeps drawLot until it stops fitting", async function () {
    const rows: { height: number; stakes: number; result: Awaited<ReturnType<typeof drawAtHeight>> }[] =
      [];
    for (let height = 2; height <= 6; height++) {
      rows.push({ height, stakes: 2 ** height, result: await drawAtHeight(height) });
    }

    console.log("");
    console.log(`  drawLot, the whole transaction, not just the walk`);
    console.log(`  ${"-".repeat(62)}`);
    console.log(`  ${"stakes".padEnd(10)}${"seq depth".padStart(12)}${"of budget".padStart(12)}  result`);
    console.log(`  ${"-".repeat(62)}`);
    for (const row of rows) {
      const r = row.result;
      console.log(
        r.fits
          ? `  ${String(row.stakes).padEnd(10)}${r.depth!.toLocaleString("en-US").padStart(12)}` +
              `${`${((r.depth! / 5_000_000) * 100).toFixed(2)}%`.padStart(12)}  fits`
          : `  ${String(row.stakes).padEnd(10)}${"-".padStart(12)}${"-".padStart(12)}` +
              `  reverts, ${(r as { binding: string }).binding} budget`,
      );
    }
    const fitting = rows.filter((r) => r.result.fits);
    const ceiling = fitting[fitting.length - 1];
    console.log(`  ${"-".repeat(62)}`);
    console.log(`  a complete draw settles up to ${ceiling.stakes} stakes.`);
    console.log("");

    expect(fitting.length, "no height completed a draw").to.be.greaterThan(0);
    // Pinned. The shard deploys at this height, so a change that moves it has
    // to move it here too rather than quietly shipping a shard that cannot
    // settle its own draw.
    expect(ceiling.stakes, "the shard size a draw can actually settle").to.equal(32);
  });
});

describe("mock and chain agree on HCU", function () {
  let deployer: HardhatEthersSigner;

  before(async function () {
    if (!fhevm.isMock) this.skip();
    [deployer] = await ethers.getSigners();
  });

  it("drawLot at active height 2 costs what Sepolia charged", async function () {
    const usdt = await (await ethers.getContractFactory("MockConfidentialUSDT", deployer)).deploy();
    await usdt.waitForDeployment();
    const usdtAddress = await usdt.getAddress();

    // Same shard shape as the live deployment.
    const pool = await (
      await ethers.getContractFactory("SortisPool", deployer)
    ).deploy(usdtAddress, 6);
    await pool.waitForDeployment();
    const poolAddress = await pool.getAddress();

    const yieldAdapter = await (
      await ethers.getContractFactory("MockYieldAdapter", deployer)
    ).deploy(usdtAddress);
    await yieldAdapter.waitForDeployment();

    const draw = await (
      await ethers.getContractFactory("SortisDraw", deployer)
    ).deploy(poolAddress, await yieldAdapter.getAddress(), 0);
    await draw.waitForDeployment();
    await (await pool.setDrawContract(await draw.getAddress())).wait();

    // Four leaves is active height 2, matching the Sepolia probe.
    const signers = (await ethers.getSigners()).slice(1, 5);
    for (const who of signers) {
      await (await usdt.mint(who.address, 500_000n)).wait();
      await (await (usdt.connect(who) as typeof usdt).setOperator(poolAddress, 2n ** 47n)).wait();
      const enc = await fhevm
        .createEncryptedInput(poolAddress, who.address)
        .add64(500_000n)
        .encrypt();
      await (
        await (pool.connect(who) as typeof pool).commit(enc.handles[0], enc.inputProof)
      ).wait();
    }

    // One hour so the register carries weight, as it did on Sepolia.
    await ethers.provider.send("evm_increaseTime", [HOUR + 60]);
    await ethers.provider.send("evm_mine", []);

    expect(await pool.activeHeight(), "same height as the Sepolia probe").to.equal(2);

    await (await draw.openDraw()).wait();
    const drawId = await draw.drawCount();
    const [rootHandle] = await draw.drawInfo(drawId);
    const decrypted = await fhevm.publicDecrypt([rootHandle]);

    const receipt = await (
      await draw.drawLot(drawId, decrypted.abiEncodedClearValues, decrypted.decryptionProof)
    ).wait();
    const hcu = fhevm.computeTransactionHCU(receipt!);

    const delta = (hcu.maxHCUDepth - SEPOLIA_DRAWLOT_HEIGHT_2) / SEPOLIA_DRAWLOT_HEIGHT_2;

    console.log("");
    console.log(`  drawLot at active height 2`);
    console.log(`    mock     ${hcu.maxHCUDepth.toLocaleString("en-US")} depth`);
    console.log(`    Sepolia  ${SEPOLIA_DRAWLOT_HEIGHT_2.toLocaleString("en-US")} depth`);
    console.log(`    delta    ${(delta * 100).toFixed(2)}%`);
    console.log(
      Math.abs(delta) <= TOLERANCE
        ? `  the mock's accounting holds, so the measured ceiling is trustworthy.`
        : `  the mock and the chain disagree. The shard size is not safe.`,
    );
    console.log("");

    expect(
      Math.abs(delta),
      `mock ${hcu.maxHCUDepth} against Sepolia ${SEPOLIA_DRAWLOT_HEIGHT_2}`,
    ).to.be.at.most(TOLERANCE);
  });
});
