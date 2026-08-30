import { expect } from "chai";
import hre from "hardhat";

import { FhevmType } from "@fhevm/hardhat-plugin";
import type { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

import type {
  MockConfidentialUSDT,
  MockUSDT,
  MockYieldAdapter,
  SortisDraw,
  SortisPool,
  SortisWrapQueue,
} from "../typechain-types";

const { ethers, fhevm } = hre;

/**
 * test/Draw.t.ts -- the prize round and the wrap queue.
 *
 * The draw is two transactions and the gap between them is the security
 * argument, so most of what is asserted here is about ORDER: that the root is
 * committed before randomness exists, that a lot cannot be drawn in the opening
 * block, and that a register which moved in between voids the draw.
 */

const DEPTH = 8;
const EPOCH = 4 * 60 * 60; // 4 hours, the Sepolia default
const HOUR = 3_600;

type Rig = {
  usdt: MockUSDT;
  cusdt: MockConfidentialUSDT;
  pool: SortisPool;
  draw: SortisDraw;
  queue: SortisWrapQueue;
  yieldAdapter: MockYieldAdapter;
  poolAddress: string;
  cusdtAddress: string;
  drawAddress: string;
};

async function deployRig(deployer: HardhatEthersSigner): Promise<Rig> {
  const usdt = (await (await ethers.getContractFactory("MockUSDT", deployer)).deploy()) as unknown as MockUSDT;
  await usdt.waitForDeployment();

  const cusdt = (await (
    await ethers.getContractFactory("MockConfidentialUSDT", deployer)
  ).deploy()) as unknown as MockConfidentialUSDT;
  await cusdt.waitForDeployment();
  const cusdtAddress = await cusdt.getAddress();

  const pool = (await (
    await ethers.getContractFactory("SortisPool", deployer)
  ).deploy(cusdtAddress, DEPTH)) as unknown as SortisPool;
  await pool.waitForDeployment();
  const poolAddress = await pool.getAddress();

  const yieldAdapter = (await (
    await ethers.getContractFactory("MockYieldAdapter", deployer)
  ).deploy(cusdtAddress)) as unknown as MockYieldAdapter;
  await yieldAdapter.waitForDeployment();

  const draw = (await (
    await ethers.getContractFactory("SortisDraw", deployer)
  ).deploy(poolAddress, await yieldAdapter.getAddress(), 0)) as unknown as SortisDraw;
  await draw.waitForDeployment();
  const drawAddress = await draw.getAddress();

  const queue = (await (
    await ethers.getContractFactory("SortisWrapQueue", deployer)
  ).deploy(await usdt.getAddress(), cusdtAddress, poolAddress, EPOCH)) as unknown as SortisWrapQueue;
  await queue.waitForDeployment();

  await (await pool.setDrawContract(drawAddress)).wait();
  await (await pool.setWrapQueue(await queue.getAddress())).wait();

  return { usdt, cusdt, pool, draw, queue, yieldAdapter, poolAddress, cusdtAddress, drawAddress };
}

async function commit(rig: Rig, who: HardhatEthersSigner, amount: bigint) {
  await (await rig.cusdt.mint(who.address, amount)).wait();
  await (await rig.cusdt.connect(who).setOperator(rig.poolAddress, 2n ** 47n)).wait();
  const enc = await fhevm.createEncryptedInput(rig.poolAddress, who.address).add64(amount).encrypt();
  await (await rig.pool.connect(who).commit(enc.handles[0], enc.inputProof)).wait();
}

async function advanceHours(hours: number) {
  await ethers.provider.send("evm_increaseTime", [Math.round(hours * HOUR)]);
  await ethers.provider.send("evm_mine", []);
}

/**
 * Fetch the KMS public decryption proof for the committed root and settle the
 * lot. On Sepolia this proof comes from the relayer; the mock plugin exposes an
 * equivalent signer so the same code path runs locally.
 */
async function kmsProof(handle: string) {
  const result = await fhevm.publicDecrypt([handle]);
  return { encoded: result.abiEncodedClearValues, proof: result.decryptionProof };
}

async function drawLot(rig: Rig, drawId: bigint, caller: HardhatEthersSigner) {
  const [rootHandle] = await rig.draw.drawInfo(drawId);
  const { encoded, proof } = await kmsProof(rootHandle);
  return (await rig.draw.connect(caller).drawLot(drawId, encoded, proof)).wait();
}

// ---------------------------------------------------------------------------

describe("SortisDraw", function () {
  let deployer: HardhatEthersSigner;
  let alice: HardhatEthersSigner;
  let bob: HardhatEthersSigner;
  let carol: HardhatEthersSigner;

  before(async function () {
    if (!fhevm.isMock) this.skip();
    [deployer, alice, bob, carol] = await ethers.getSigners();
  });

  describe("openDraw commits the root before any randomness exists", function () {
    it("publishes the root handle and the block, and leaves the register untouched", async function () {
      const rig = await deployRig(deployer);
      await commit(rig, alice, 1_000_000n);
      await advanceHours(5);
      await commit(rig, alice, 0n); // accrue

      await (await rig.yieldAdapter.accrue(50_000n)).wait();

      const interceptBefore = await rig.pool.rootIntercept();
      const slopeBefore = await rig.pool.rootSlope();

      const receipt = await (await rig.draw.openDraw()).wait();
      const [rootHandle, openedAtBlock, prize] = await rig.draw.drawInfo(1);

      expect(openedAtBlock).to.equal(BigInt(receipt!.blockNumber));
      expect(prize, "prize is public and harvested at open").to.equal(50_000n);
      expect(rootHandle, "a total was committed").to.not.equal(ethers.ZeroHash);

      // Opening a draw reads the register and must not move it. Handles are
      // content-derived, so equality on both trees is proof the tree was not
      // reshaped in the same breath as the commitment to it.
      expect(await rig.pool.rootIntercept(), "intercept tree untouched").to.equal(interceptBefore);
      expect(await rig.pool.rootSlope(), "slope tree untouched").to.equal(slopeBefore);

      // openDraw does perform FHE work, but none of it is the draw's: it is the
      // yield adapter minting the prize into this contract, which settles the
      // ASSET's ciphertexts and never reads the register. What matters is that
      // no randomness exists yet -- FHE.randEuint64 is not called until
      // drawLot, one block later.
      expect(await rig.yieldAdapter.pending(), "harvest emptied the adapter").to.equal(0n);
    });

    it("refuses a lot in the same block as the open", async function () {
      const rig = await deployRig(deployer);
      await commit(rig, alice, 1_000_000n);
      await advanceHours(5);

      // The committed total is a fresh ciphertext per open, so a proof cannot
      // be built for a draw that does not exist yet. It does not need to be:
      // drawLot checks the block before it checks the proof, so a same-block
      // call fails on the block guard whatever it is handed.
      await ethers.provider.send("evm_setAutomine", [false]);
      const openTx = await rig.draw.openDraw({ gasLimit: 3_000_000 });
      const lotTx = await rig.draw.drawLot(1, "0x", "0x", { gasLimit: 8_000_000 });
      await ethers.provider.send("evm_mine", []);
      await ethers.provider.send("evm_setAutomine", [true]);

      const openReceipt = await ethers.provider.getTransactionReceipt(openTx.hash);
      const lotReceipt = await ethers.provider.getTransactionReceipt(lotTx.hash);

      expect(openReceipt!.status, "the open itself is fine").to.equal(1);
      expect(openReceipt!.blockNumber).to.equal(lotReceipt!.blockNumber);
      // Same block as the open means the opener could have seen the lot before
      // broadcasting. That has to fail.
      expect(lotReceipt!.status, "a lot drawn in the opening block must fail").to.equal(0);

      // And one block later the same draw settles, which is what isolates the
      // block guard from every other reason a lot might be refused.
      await advanceHours(1);
      const settled = await drawLot(rig, 1n, deployer);
      expect(settled!.status).to.equal(1);
    });

    it("voids the draw if the register moved after the open", async function () {
      const rig = await deployRig(deployer);
      await commit(rig, alice, 1_000_000n);
      await advanceHours(5);
      await commit(rig, alice, 0n);

      await (await rig.draw.openDraw()).wait();

      // Someone commits. The root handle is content-derived, so it changes.
      await advanceHours(2);
      await commit(rig, bob, 500_000n);

      await expect(drawLot(rig, 1n, deployer)).to.be.revertedWithCustomError(
        rig.draw,
        "RegisterMovedSinceOpen",
      );
    });
  });

  describe("drawLot resolves a leaf without revealing it", function () {
    it("draws a lot, walks, and keeps the resolved leaf encrypted", async function () {
      const rig = await deployRig(deployer);
      await commit(rig, alice, 1_000_000n);
      await commit(rig, bob, 1_000_000n);
      await advanceHours(5);
      await commit(rig, alice, 0n);
      await commit(rig, bob, 0n);

      await (await rig.yieldAdapter.accrue(80_000n)).wait();
      await (await rig.draw.openDraw()).wait();
      await advanceHours(1);

      const receipt = await drawLot(rig, 1n, deployer);
      expect(receipt!.status).to.equal(1);

      const [, , , totalWeight, walkHeight, lotDrawn] = await rig.draw.drawInfo(1);
      expect(lotDrawn).to.equal(true);
      expect(totalWeight, "10,000,000 of weight from two stakes over 5h").to.equal(10_000_000n);
      // Two leaves in use, so the walk descends a height-1 subtree regardless
      // of the pool being deployed at depth 8.
      expect(walkHeight).to.equal(1);

      const handle = await rig.draw.resolvedLeafHandle(1);
      expect(handle, "a resolved leaf must exist").to.not.equal(ethers.ZeroHash);

      // Nobody holds a grant on it. The only thing anyone can do with this
      // handle is compare against it inside claimPrize.
      await expect(
        fhevm.userDecryptEuint(FhevmType.euint16, handle, rig.drawAddress, deployer),
      ).to.be.rejected;
    });

    it("rejects a forged total weight", async function () {
      const rig = await deployRig(deployer);
      await commit(rig, alice, 1_000_000n);
      await advanceHours(5);
      await commit(rig, alice, 0n);

      await (await rig.draw.openDraw()).wait();
      await advanceHours(1);

      const [rootHandle] = await rig.draw.drawInfo(1);
      const { encoded, proof } = await kmsProof(rootHandle);

      // Keep the real proof but submit a halved total. checkSignatures must
      // reject: an operator who can skew the denominator can skew the odds.
      const real = ethers.AbiCoder.defaultAbiCoder().decode(["uint256"], encoded)[0] as bigint;
      const forged = ethers.AbiCoder.defaultAbiCoder().encode(["uint256"], [real / 2n]);

      await expect(rig.draw.drawLot(1, forged, proof)).to.be.rejected;
    });

    it("cannot be drawn twice", async function () {
      const rig = await deployRig(deployer);
      await commit(rig, alice, 1_000_000n);
      await advanceHours(5);
      await commit(rig, alice, 0n);

      await (await rig.draw.openDraw()).wait();
      await advanceHours(1);
      await drawLot(rig, 1n, deployer);

      await expect(drawLot(rig, 1n, deployer)).to.be.revertedWithCustomError(
        rig.draw,
        "DrawAlreadySettled",
      );
    });
  });

  describe("claimPrize pays only the drawn leaf, and says nothing", function () {
    it("pays exactly one claimant the full prize and everyone else zero", async function () {
      const rig = await deployRig(deployer);
      await commit(rig, alice, 1_000_000n);
      await commit(rig, bob, 1_000_000n);
      await commit(rig, carol, 1_000_000n);
      await advanceHours(5);
      await commit(rig, alice, 0n);
      await commit(rig, bob, 0n);
      await commit(rig, carol, 0n);

      const PRIZE = 90_000n;
      await (await rig.yieldAdapter.accrue(PRIZE)).wait();
      await (await rig.draw.openDraw()).wait();
      await advanceHours(1);
      await drawLot(rig, 1n, deployer);

      const before: bigint[] = [];
      for (const who of [alice, bob, carol]) {
        before.push(
          await fhevm.userDecryptEuint(
            FhevmType.euint64,
            await rig.cusdt.confidentialBalanceOf(who.address),
            rig.cusdtAddress,
            who,
          ),
        );
      }

      const receipts = [];
      for (const who of [alice, bob, carol]) {
        receipts.push(await (await rig.draw.connect(who).claimPrize(1)).wait());
      }

      const gains: bigint[] = [];
      for (let i = 0; i < 3; i++) {
        const who = [alice, bob, carol][i];
        const after = await fhevm.userDecryptEuint(
          FhevmType.euint64,
          await rig.cusdt.confidentialBalanceOf(who.address),
          rig.cusdtAddress,
          who,
        );
        gains.push(after - before[i]);
      }

      // Exactly one winner, paid in full.
      expect(gains.filter((g) => g === PRIZE).length, "exactly one winner").to.equal(1);
      expect(gains.filter((g) => g === 0n).length, "two losers paid nothing").to.equal(2);

      // And the three claims are indistinguishable in HCU. Only the encrypted
      // amount differed.
      const hcus = receipts.map((r) => fhevm.computeTransactionHCU(r!));
      expect(new Set(hcus.map((h) => h.maxHCUDepth)).size, "claim depth must not vary").to.equal(1);
      expect(new Set(hcus.map((h) => h.globalHCU)).size, "claim global must not vary").to.equal(1);
    });

    it("marks losers as claimed too, so the flag is not a winner announcement", async function () {
      const rig = await deployRig(deployer);
      await commit(rig, alice, 1_000_000n);
      await commit(rig, bob, 1_000_000n);
      await advanceHours(5);
      await commit(rig, alice, 0n);
      await commit(rig, bob, 0n);

      await (await rig.yieldAdapter.accrue(10_000n)).wait();
      await (await rig.draw.openDraw()).wait();
      await advanceHours(1);
      await drawLot(rig, 1n, deployer);

      await (await rig.draw.connect(alice).claimPrize(1)).wait();
      await (await rig.draw.connect(bob).claimPrize(1)).wait();

      expect(await rig.draw.hasClaimed(1, alice.address)).to.equal(true);
      expect(await rig.draw.hasClaimed(1, bob.address)).to.equal(true);

      await expect(rig.draw.connect(alice).claimPrize(1)).to.be.revertedWithCustomError(
        rig.draw,
        "AlreadyClaimed",
      );
    });

    it("pays nothing to someone who never staked", async function () {
      const rig = await deployRig(deployer);
      await commit(rig, alice, 1_000_000n);
      await advanceHours(5);
      await commit(rig, alice, 0n);

      await (await rig.yieldAdapter.accrue(10_000n)).wait();
      await (await rig.draw.openDraw()).wait();
      await advanceHours(1);
      await drawLot(rig, 1n, deployer);

      // carol has no leaf. She must not be paid, and must not revert either --
      // reverting would tell her something the winner-hiding design should not.
      const receipt = await (await rig.draw.connect(carol).claimPrize(1)).wait();
      expect(receipt!.status).to.equal(1);

      const paid = await fhevm.userDecryptEuint(
        FhevmType.euint64,
        await rig.cusdt.confidentialBalanceOf(carol.address),
        rig.cusdtAddress,
        carol,
      );
      expect(paid).to.equal(0n);
    });
  });

  describe("the draw is affordable on a production-sized register", function () {
    it("descends only the occupied subtree, so DEPTH 16 costs what the stakes cost", async function () {
      const usdt = (await (
        await ethers.getContractFactory("MockConfidentialUSDT", deployer)
      ).deploy()) as unknown as MockConfidentialUSDT;
      await usdt.waitForDeployment();

      // The production register: 65,536 slots.
      const pool = (await (
        await ethers.getContractFactory("SortisPool", deployer)
      ).deploy(await usdt.getAddress(), 16)) as unknown as SortisPool;
      await pool.waitForDeployment();

      const yieldAdapter = (await (
        await ethers.getContractFactory("MockYieldAdapter", deployer)
      ).deploy(await usdt.getAddress())) as unknown as MockYieldAdapter;
      await yieldAdapter.waitForDeployment();

      const draw = (await (
        await ethers.getContractFactory("SortisDraw", deployer)
      ).deploy(await pool.getAddress(), await yieldAdapter.getAddress(), 0)) as unknown as SortisDraw;
      await draw.waitForDeployment();
      await (await pool.setDrawContract(await draw.getAddress())).wait();

      const rig = {
        cusdt: usdt,
        pool,
        draw,
        yieldAdapter,
        poolAddress: await pool.getAddress(),
        cusdtAddress: await usdt.getAddress(),
        drawAddress: await draw.getAddress(),
      } as Rig;

      const signers = await ethers.getSigners();
      const stakers = signers.slice(1, 6);
      for (const who of stakers) await commit(rig, who, 1_000_000n);
      await advanceHours(5);
      for (const who of stakers) await commit(rig, who, 0n);

      expect(await pool.DEPTH(), "deployed at production depth").to.equal(16);
      expect(await pool.activeHeight(), "five stakes fit in a height-3 subtree").to.equal(3);

      await (await yieldAdapter.accrue(1_000n)).wait();
      await (await draw.openDraw()).wait();
      await advanceHours(1);
      const receipt = await drawLot(rig, 1n, deployer);
      const hcu = fhevm.computeTransactionHCU(receipt!);

      console.log("");
      console.log(`  drawLot on a DEPTH 16 register holding ${stakers.length} stakes`);
      console.log(`  active height  ${await pool.activeHeight()}`);
      console.log(
        `  seq depth      ${hcu.maxHCUDepth.toLocaleString("en-US")}  ` +
          `(${((hcu.maxHCUDepth / 5_000_000) * 100).toFixed(2)}% of 5,000,000)`,
      );
      console.log(
        `  global HCU     ${hcu.globalHCU.toLocaleString("en-US")}  ` +
          `(${((hcu.globalHCU / 20_000_000) * 100).toFixed(2)}% of 20,000,000)`,
      );
      console.log(`  gas            ${receipt!.gasUsed.toLocaleString("en-US")}`);
      console.log("");

      // The whole point: a walk on the full 2^16 tree would need ~3.6 billion
      // global HCU and revert. Descending only the occupied subtree makes the
      // production register drawable.
      expect(hcu.maxHCUDepth).to.be.lessThan(5_000_000);
      expect(hcu.globalHCU).to.be.lessThan(20_000_000);
    });
  });
});

// ---------------------------------------------------------------------------

describe("anyone may run a draw, and not too often", function () {
  let deployer: HardhatEthersSigner;
  let alice: HardhatEthersSigner;

  before(async function () {
    if (!fhevm.isMock) this.skip();
    [deployer, alice] = await ethers.getSigners();
  });

  /** A rig whose draw contract enforces a real interval. */
  async function deployWithInterval(seconds: number) {
    const usdt = (await (
      await ethers.getContractFactory("MockConfidentialUSDT", deployer)
    ).deploy()) as unknown as MockConfidentialUSDT;
    await usdt.waitForDeployment();
    const usdtAddress = await usdt.getAddress();

    const pool = (await (
      await ethers.getContractFactory("SortisPool", deployer)
    ).deploy(usdtAddress, DEPTH)) as unknown as SortisPool;
    await pool.waitForDeployment();

    const yieldAdapter = (await (
      await ethers.getContractFactory("MockYieldAdapter", deployer)
    ).deploy(usdtAddress)) as unknown as MockYieldAdapter;
    await yieldAdapter.waitForDeployment();

    const draw = (await (
      await ethers.getContractFactory("SortisDraw", deployer)
    ).deploy(await pool.getAddress(), await yieldAdapter.getAddress(), seconds)) as unknown as SortisDraw;
    await draw.waitForDeployment();
    await (await pool.setDrawContract(await draw.getAddress())).wait();

    const rig = {
      cusdt: usdt,
      pool,
      draw,
      yieldAdapter,
      poolAddress: await pool.getAddress(),
      cusdtAddress: usdtAddress,
      drawAddress: await draw.getAddress(),
    } as Rig;

    await commit(rig, alice, 1_000_000n);
    await advanceHours(5);
    await commit(rig, alice, 0n);
    return rig;
  }

  it("lets a wallet that is not the deployer open and settle a draw", async function () {
    const rig = await deployWithInterval(0);
    await (await rig.yieldAdapter.accrue(10_000n)).wait();

    // alice deployed nothing and owns nothing. The bounty requires a judge to
    // be able to try every feature, so a draw an operator alone can trigger
    // fails the brief regardless of how well it works.
    await (await rig.draw.connect(alice).openDraw()).wait();
    await advanceHours(0);
    await drawLot(rig, 1n, alice);

    const [, , , , , lotDrawn] = await rig.draw.drawInfo(1);
    expect(lotDrawn, "a non-owner settled the draw").to.equal(true);
  });

  it("refuses a second draw inside the interval, and allows it after", async function () {
    const rig = await deployWithInterval(600);
    await (await rig.yieldAdapter.accrue(10_000n)).wait();
    await (await rig.draw.openDraw()).wait();

    expect(await rig.draw.secondsUntilNextDraw()).to.be.greaterThan(0);
    await expect(rig.draw.connect(alice).openDraw()).to.be.revertedWithCustomError(
      rig.draw,
      "DrawTooSoon",
    );

    await ethers.provider.send("evm_increaseTime", [601]);
    await ethers.provider.send("evm_mine", []);

    expect(await rig.draw.secondsUntilNextDraw()).to.equal(0);
    await (await rig.draw.connect(alice).openDraw()).wait();
    expect(await rig.draw.drawCount()).to.equal(2n);
  });

  it("opens immediately the first time, whatever the interval", async function () {
    // nextDrawAt is zero until a draw has been opened, so a fresh deployment
    // is not locked out for its own interval before it has done anything.
    const rig = await deployWithInterval(86_400);
    expect(await rig.draw.secondsUntilNextDraw()).to.equal(0);
    await (await rig.draw.connect(alice).openDraw()).wait();
    expect(await rig.draw.drawCount()).to.equal(1n);
  });
});

describe("SortisWrapQueue", function () {
  let deployer: HardhatEthersSigner;
  let alice: HardhatEthersSigner;
  let bob: HardhatEthersSigner;
  let carol: HardhatEthersSigner;

  before(async function () {
    if (!fhevm.isMock) this.skip();
    [deployer, alice, bob, carol] = await ethers.getSigners();
  });

  async function queueUp(rig: Rig, who: HardhatEthersSigner, amount: bigint) {
    await (await rig.usdt.mint(who.address, amount)).wait();
    await (await rig.usdt.connect(who).approve(await rig.queue.getAddress(), amount)).wait();
    await (await rig.queue.connect(who).enqueue(amount)).wait();
  }

  it("takes public USDT without performing any FHE work", async function () {
    const rig = await deployRig(deployer);
    await (await rig.usdt.mint(alice.address, 1_000_000n)).wait();
    await (await rig.usdt.connect(alice).approve(await rig.queue.getAddress(), 1_000_000n)).wait();

    const receipt = await (await rig.queue.connect(alice).enqueue(1_000_000n)).wait();

    // The public leg and the confidential leg have to be in different
    // transactions or the batching buys nothing.
    const hcu = fhevm.computeTransactionHCU(receipt!);
    expect(hcu.globalHCU, "enqueue must do no FHE work").to.equal(0);

    const epoch = await rig.queue.currentEpoch();
    const [entries, , total] = await rig.queue.epochInfo(epoch);
    expect(entries).to.equal(1n);
    expect(total).to.equal(1_000_000n);
  });

  it("refuses to settle an epoch that is still open", async function () {
    const rig = await deployRig(deployer);
    await queueUp(rig, alice, 1_000_000n);
    const epoch = await rig.queue.currentEpoch();

    await expect(rig.queue.settleEpoch(epoch)).to.be.revertedWithCustomError(
      rig.queue,
      "EpochStillOpen",
    );
  });

  it("credits the whole epoch as one batch", async function () {
    const rig = await deployRig(deployer);
    const epoch = await rig.queue.currentEpoch();

    await queueUp(rig, alice, 1_000_000n);
    await queueUp(rig, bob, 250_000n);
    await queueUp(rig, carol, 40_000n);

    await advanceHours(5); // past the 4h epoch

    const [credited, closed] = await rig.queue.settleEpoch.staticCall(epoch);
    expect(credited).to.equal(3n);
    expect(closed).to.equal(true);
    await (await rig.queue.settleEpoch(epoch)).wait();

    for (const [who, amount] of [
      [alice, 1_000_000n],
      [bob, 250_000n],
      [carol, 40_000n],
    ] as const) {
      const staked = await fhevm.userDecryptEuint(
        FhevmType.euint64,
        await rig.pool.stakeOf(who.address),
        rig.poolAddress,
        who,
      );
      expect(staked, `${await who.getAddress()} stake`).to.equal(amount);
    }

    const [, settled, , isClosed] = await rig.queue.epochInfo(epoch);
    expect(settled).to.equal(3n);
    expect(isClosed).to.equal(true);
  });

  it("paginates a large epoch across checkpointed transactions", async function () {
    const rig = await deployRig(deployer);
    const epoch = await rig.queue.currentEpoch();

    const signers = (await ethers.getSigners()).slice(1, 10); // 9 depositors
    for (const who of signers) await queueUp(rig, who, 100_000n);

    await advanceHours(5);

    // MAX_SETTLE_BATCH is 4, sized by the 20,000,000 global HCU cap.
    const first = await (await rig.queue.settleEpoch(epoch)).wait();
    let [, settled, , closed] = await rig.queue.epochInfo(epoch);
    expect(settled).to.equal(4n);
    expect(closed).to.equal(false);

    const firstHcu = fhevm.computeTransactionHCU(first!);
    expect(firstHcu.globalHCU, "a full batch must fit the global budget").to.be.lessThan(20_000_000);

    // The six CREDITS are independent of each other, but the batch is still
    // deep, and the cause is the wrap rather than the credit: ERC-7984 mint
    // folds every mint into one shared total-supply ciphertext, so six mints
    // form a six-long dependent chain. That, not the register work, is what
    // caps MAX_SETTLE_BATCH.
    expect(firstHcu.maxHCUDepth, "batch depth").to.be.lessThan(5_000_000);
    console.log(
      `\n  settleEpoch batch of 6: depth ${firstHcu.maxHCUDepth.toLocaleString("en-US")}, ` +
        `global ${firstHcu.globalHCU.toLocaleString("en-US")}\n`,
    );

    await (await rig.queue.settleEpoch(epoch)).wait();
    await (await rig.queue.settleEpoch(epoch)).wait();
    [, settled, , closed] = await rig.queue.epochInfo(epoch);
    expect(settled).to.equal(9n);
    expect(closed).to.equal(true);

    await expect(rig.queue.settleEpoch(epoch)).to.be.revertedWithCustomError(
      rig.queue,
      "EpochAlreadyClosed",
    );
  });

  it("gives a lone depositor no anonymity set, as documented", async function () {
    const rig = await deployRig(deployer);
    const epoch = await rig.queue.currentEpoch();

    await queueUp(rig, alice, 777_000n);
    await advanceHours(5);
    await (await rig.queue.settleEpoch(epoch)).wait();

    // One entry in, one stake out, and the public amount matches the private
    // one exactly. This is the limitation the contract comment calls out, and
    // asserting it keeps the claim honest rather than aspirational.
    const [entries, , total] = await rig.queue.epochInfo(epoch);
    expect(entries).to.equal(1n);

    const staked = await fhevm.userDecryptEuint(
      FhevmType.euint64,
      await rig.pool.stakeOf(alice.address),
      rig.poolAddress,
      alice,
    );
    expect(staked).to.equal(total);
  });
});
