import { expect } from "chai";
import hre from "hardhat";

import { FhevmType } from "@fhevm/hardhat-plugin";
import type { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

import type { MockConfidentialUSDT, SortisPoolHarness } from "../typechain-types";

const { ethers, fhevm } = hre;

/**
 * test/Pool.t.ts -- the commit, wait, release cycle.
 *
 * Everything here runs against the FHEVM mock coprocessor, which enforces the
 * same HCU budgets and the same ACL rules as Sepolia. scripts/cycle.ts runs the
 * identical sequence against a live network.
 */

const HOUR = 3_600;

/** Register height used throughout. Small enough to keep the suite fast. */
const DEPTH = 8;

// euint64 unit costs, from the HCUByOperator table in fhevm mock-utils.
const HCU_MUL_SCALAR = 365_000;
const HCU_MUL_CIPHERTEXT = 596_000;
const HCU_ADD_CT_CT = 162_000;

type Deployment = {
  usdt: MockConfidentialUSDT;
  pool: SortisPoolHarness;
  poolAddress: string;
  usdtAddress: string;
};

async function deploy(deployer: HardhatEthersSigner): Promise<Deployment> {
  const usdtFactory = await ethers.getContractFactory("MockConfidentialUSDT", deployer);
  const usdt = (await usdtFactory.deploy()) as unknown as MockConfidentialUSDT;
  await usdt.waitForDeployment();
  const usdtAddress = await usdt.getAddress();

  const poolFactory = await ethers.getContractFactory("SortisPoolHarness", deployer);
  const pool = (await poolFactory.deploy(usdtAddress, DEPTH)) as unknown as SortisPoolHarness;
  await pool.waitForDeployment();
  const poolAddress = await pool.getAddress();

  return { usdt, pool, poolAddress, usdtAddress };
}

/** Mint cUSDT to `who` and authorise the pool to pull from them. */
async function fund(d: Deployment, who: HardhatEthersSigner, amount: bigint): Promise<void> {
  await (await d.usdt.mint(who.address, amount)).wait();
  // ERC-7984 requires an explicit operator authorisation before the pool can
  // call confidentialTransferFrom. Far future expiry keeps the demo simple.
  await (await d.usdt.connect(who).setOperator(d.poolAddress, 2n ** 47n)).wait();
}

/** Encrypt `amount` for `who` against the pool and submit it to `method`. */
async function submit(
  d: Deployment,
  who: HardhatEthersSigner,
  method: "commit" | "release",
  amount: bigint,
) {
  const encrypted = await fhevm
    .createEncryptedInput(d.poolAddress, who.address)
    .add64(amount)
    .encrypt();

  const tx = await d.pool.connect(who)[method](encrypted.handles[0], encrypted.inputProof);
  return tx.wait();
}

async function advanceHours(hours: number): Promise<void> {
  await ethers.provider.send("evm_increaseTime", [hours * HOUR]);
  await ethers.provider.send("evm_mine", []);
}

async function stake(d: Deployment, who: HardhatEthersSigner): Promise<bigint> {
  return fhevm.userDecryptEuint(FhevmType.euint64, await d.pool.stakeOf(who.address), d.poolAddress, who);
}

async function walletBalance(d: Deployment, who: HardhatEthersSigner): Promise<bigint> {
  return fhevm.userDecryptEuint(
    FhevmType.euint64,
    await d.usdt.confidentialBalanceOf(who.address),
    d.usdtAddress,
    who,
  );
}

/** Total register weight at the current hour, decrypted. */
async function registerWeight(d: Deployment, reader: HardhatEthersSigner): Promise<bigint> {
  const t = await d.pool.timeUnitsNow();
  await (await d.pool.weightAt(t)).wait();
  const handle = await d.pool.weightAt.staticCall(t);
  return fhevm.userDecryptEuint(FhevmType.euint64, handle, d.poolAddress, reader);
}

// ---------------------------------------------------------------------------

describe("SortisPool", function () {
  let deployer: HardhatEthersSigner;
  let alice: HardhatEthersSigner;
  let bob: HardhatEthersSigner;

  before(async function () {
    if (!fhevm.isMock) this.skip();
    [deployer, alice, bob] = await ethers.getSigners();
  });

  describe("commit, wait, release", function () {
    it("runs a full cycle and lands on the right numbers", async function () {
      const d = await deploy(deployer);
      await fund(d, alice, 2_000_000n);

      // --- commit -------------------------------------------------------
      await submit(d, alice, "commit", 1_000_000n);

      expect(await stake(d, alice), "stake after first commit").to.equal(1_000_000n);
      expect(await walletBalance(d, alice), "wallet after first commit").to.equal(1_000_000n);
      // No time has passed, so no weight has been earned. This is the property
      // that makes a late commit unable to snipe a draw.
      expect(await registerWeight(d, deployer), "weight at t0").to.equal(0n);

      // --- wait ---------------------------------------------------------
      await advanceHours(5);

      // --- commit again, which accrues the elapsed time ------------------
      await submit(d, alice, "commit", 500_000n);

      expect(await stake(d, alice), "stake after second commit").to.equal(1_500_000n);
      expect(await walletBalance(d, alice), "wallet after second commit").to.equal(500_000n);
      // 1,000,000 held for 5 hours. The accrual used the OLD balance, not the
      // new one: crediting the incoming 500,000 for time it had not been in
      // the pool is exactly the snipe the TWAB prevents.
      expect(await registerWeight(d, deployer), "weight after 5h").to.equal(5_000_000n);

      // --- wait ---------------------------------------------------------
      await advanceHours(3);

      // --- release ------------------------------------------------------
      await submit(d, alice, "release", 400_000n);

      expect(await stake(d, alice), "stake after release").to.equal(1_100_000n);
      expect(await walletBalance(d, alice), "wallet after release").to.equal(900_000n);
      // 1,500,000 held for a further 3 hours: 5,000,000 + 4,500,000.
      expect(await registerWeight(d, deployer), "weight after 8h").to.equal(9_500_000n);
    });

    it("keeps earning for a stake nobody touches", async function () {
      const d = await deploy(deployer);
      await fund(d, alice, 1_000_000n);
      await submit(d, alice, "commit", 1_000_000n);

      // Never touched again. Under the old accrue-on-change design this stake
      // was worth zero forever, which is the bug the weight line fixes.
      await advanceHours(6);
      expect(await registerWeight(d, deployer), "after 6h").to.equal(6_000_000n);
      await advanceHours(6);
      expect(await registerWeight(d, deployer), "after 12h").to.equal(12_000_000n);
    });

    it("weights two stakes in proportion to money and time", async function () {
      const d = await deploy(deployer);
      await fund(d, alice, 1_000_000n);
      await fund(d, bob, 1_000_000n);

      await submit(d, alice, "commit", 1_000_000n);
      await advanceHours(10);
      // Bob arrives late with the same money.
      await submit(d, bob, "commit", 1_000_000n);
      await advanceHours(10);

      // Touch both so each accrues.
      await submit(d, alice, "commit", 0n);
      await submit(d, bob, "commit", 0n);

      // Alice: 1,000,000 for 20h. Bob: 1,000,000 for 10h. Two to one.
      expect(await registerWeight(d, deployer)).to.equal(30_000_000n);
    });
  });

  describe("an over-withdrawal is an encrypted no-op", function () {
    it("does not revert, does not move funds, and leaves the stake intact", async function () {
      const d = await deploy(deployer);
      await fund(d, alice, 1_000_000n);
      await submit(d, alice, "commit", 600_000n);

      const stakeBefore = await stake(d, alice);
      const walletBefore = await walletBalance(d, alice);

      // Ask for far more than the stake holds. FHESafeMath.trySub returns an
      // encrypted failure flag; nothing reverts.
      const receipt = await submit(d, alice, "release", 5_000_000n);
      expect(receipt!.status, "over-withdrawal must not revert").to.equal(1);

      expect(await stake(d, alice), "stake unchanged").to.equal(stakeBefore);
      expect(await walletBalance(d, alice), "wallet unchanged").to.equal(walletBefore);
    });

    it("is indistinguishable from a successful release", async function () {
      const d = await deploy(deployer);
      await fund(d, alice, 4_000_000n);
      await fund(d, bob, 4_000_000n);

      // Same stake, same elapsed time, same requested amount. The only
      // difference is that one of them can afford it.
      await submit(d, alice, "commit", 1_000_000n);
      await submit(d, bob, "commit", 100n);
      await advanceHours(4);

      const good = await submit(d, alice, "release", 100_000n);
      const bad = await submit(d, bob, "release", 100_000n);

      // Both succeed at the EVM level. An observer sees two identical-looking
      // transactions and cannot tell which one actually moved money -- which is
      // the entire point of not reverting. If release reverted on an
      // over-withdrawal, an attacker could binary-search any balance in about
      // 64 transactions by watching which ones revert.
      expect(good!.status).to.equal(1);
      expect(bad!.status).to.equal(1);

      // Raw gasUsed differs by a few units between ANY two of these, because
      // each encryption produces different ciphertext bytes and a zero byte is
      // cheaper to send than a non-zero one. Net out the payload and the
      // execution cost has to match exactly.
      const payload = async (hash: string) => {
        const tx = await ethers.provider.getTransaction(hash);
        let gas = 0n;
        for (const byte of ethers.getBytes(tx!.data)) gas += byte === 0 ? 4n : 16n;
        return gas;
      };
      const goodExecution = good!.gasUsed - (await payload(good!.hash));
      const badExecution = bad!.gasUsed - (await payload(bad!.hash));
      expect(badExecution, "execution gas must be identical").to.equal(goodExecution);

      const goodHcu = fhevm.computeTransactionHCU(good!);
      const badHcu = fhevm.computeTransactionHCU(bad!);
      expect(badHcu.maxHCUDepth).to.equal(goodHcu.maxHCUDepth);
      expect(badHcu.globalHCU).to.equal(goodHcu.globalHCU);

      // And the outcome really did differ, which is what makes the above
      // non-trivial.
      expect(await stake(d, alice)).to.equal(900_000n);
      expect(await stake(d, bob)).to.equal(100n);
    });
  });

  describe("HCU", function () {
    it("uses the scalar multiply for the time term, not ciphertext-ciphertext", async function () {
      const d = await deploy(deployer);
      await fund(d, alice, 2_000_000n);
      await submit(d, alice, "commit", 1_000_000n);
      await advanceHours(6);

      const receipt = await submit(d, alice, "commit", 100_000n);
      const hcu = fhevm.computeTransactionHCU(receipt!);

      // A commit's chain does not start at zero: `transferred` is what
      // ERC-7984 actually moved, and settling that is 207,000 deep before the
      // register work begins. On top of it sits neg, select, multiply, add.
      //
      // The multiplier is a plaintext hour count, so the multiply is the
      // SCALAR overload at 365,000. With the ciphertext-ciphertext overload at
      // 596,000 the same commit would be 231,000 deeper, so the equality below
      // is what catches a regression to the wrong one.
      const HCU_NEG = 131_000;
      const HCU_SELECT = 55_000;
      const TRANSFER_DEPTH = 207_000;
      const scalarChain = HCU_NEG + HCU_SELECT + HCU_MUL_SCALAR + HCU_ADD_CT_CT;
      const ciphertextChain = HCU_NEG + HCU_SELECT + HCU_MUL_CIPHERTEXT + HCU_ADD_CT_CT;

      expect(hcu.maxHCUDepth, "commit depth").to.equal(TRANSFER_DEPTH + scalarChain);
      expect(hcu.maxHCUDepth, "would be deeper with a ciphertext multiply").to.be.lessThan(
        TRANSFER_DEPTH + ciphertextChain,
      );
    });

    it("keeps commit and release inside both budgets", async function () {
      const d = await deploy(deployer);
      await fund(d, alice, 2_000_000n);

      await submit(d, alice, "commit", 1_000_000n);
      await advanceHours(6);
      const commit = await submit(d, alice, "commit", 100_000n);
      await advanceHours(6);
      const release = await submit(d, alice, "release", 100_000n);

      const c = fhevm.computeTransactionHCU(commit!);
      const r = fhevm.computeTransactionHCU(release!);

      const line = "-".repeat(66);
      console.log("");
      console.log(`  SortisPool -- HCU per user action (register 2^${DEPTH})`);
      console.log(`  ${line}`);
      console.log(
        `  ${"action".padEnd(10)}${"seq depth".padStart(12)}${"of 5,000,000".padStart(14)}` +
          `${"global".padStart(12)}${"of 20,000,000".padStart(15)}`,
      );
      console.log(`  ${line}`);
      for (const [name, h] of [
        ["commit", c],
        ["release", r],
      ] as const) {
        console.log(
          `  ${name.padEnd(10)}${h.maxHCUDepth.toLocaleString("en-US").padStart(12)}` +
            `${`${((h.maxHCUDepth / 5_000_000) * 100).toFixed(2)}%`.padStart(14)}` +
            `${h.globalHCU.toLocaleString("en-US").padStart(12)}` +
            `${`${((h.globalHCU / 20_000_000) * 100).toFixed(2)}%`.padStart(15)}`,
        );
      }
      console.log(`  ${line}`);
      console.log("");

      expect(c.maxHCUDepth).to.be.lessThan(5_000_000);
      expect(c.globalHCU).to.be.lessThan(20_000_000);
      expect(r.maxHCUDepth).to.be.lessThan(5_000_000);
      expect(r.globalHCU).to.be.lessThan(20_000_000);
    });
  });
});
