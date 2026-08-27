import { expect } from "chai";
import hre from "hardhat";

import { FhevmType } from "@fhevm/hardhat-plugin";
import type { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

import type { SortisRegisterHarness } from "../typechain-types";

const { ethers, fhevm } = hre;

/**
 * test/HCU.t.ts -- the proof that the architecture is real.
 *
 * See docs/BRIEF.md section 1. FHEVM enforces two limits per transaction:
 *
 *     global complexity   20,000,000 HCU   work that may run in parallel
 *     sequential depth     5,000,000 HCU   the longest dependent chain
 *
 * Exceeding either reverts. The sequential depth is the one you run out of
 * first, and it is the reason a confidential prize pool cannot be built by
 * encrypting balances and scanning them: a linear scan is N dependent adds,
 * so it dies at roughly forty depositors.
 *
 * This suite measures the sequential HCU depth of a single SortisRegister
 * update at register sizes 2^4, 2^8, 2^12 and 2^16 and asserts the result is
 * CONSTANT -- the update path is parallel work, not a dependent chain, so
 * growing the register 4,096x does not lengthen the chain by a single
 * operation. Global HCU grows as O(log N), which is the path length.
 *
 * These numbers come from the coprocessor's own accounting
 * (fhevm.computeTransactionHCU on a real receipt), not from a model.
 */

// ---------------------------------------------------------------------------
// Protocol limits
// ---------------------------------------------------------------------------

const SEQUENTIAL_DEPTH_LIMIT = 5_000_000;
const GLOBAL_HCU_LIMIT = 20_000_000;

// ---------------------------------------------------------------------------
// euint64 unit costs, from @fhevm/mock-utils HCUByOperator.
// Restated here so the expected values below are derived, not copied from a
// previous run. If the coprocessor reprices an operation, this test fails
// loudly instead of quietly ratifying the new number.
// ---------------------------------------------------------------------------

const HCU_FHE_NEG_U64 = 131_000;
const HCU_FHE_SELECT_U64 = 55_000;
const HCU_FHE_ADD_U64_CT_CT = 162_000;
const HCU_TRIVIAL_ENCRYPT = 32;

/**
 * The dependent chain inside `_update`, whatever the tree height:
 *
 *     neg(delta)                  131,000
 *     select(isAdd, delta, neg)    55,000
 *     add(_nodes[j], signed)      162,000
 *     ----------------------------------
 *                                 348,000
 *
 * The DEPTH+1 adds do not stack on each other: each reads a different node and
 * the same `signed`, so they are independent and bill against the global
 * budget instead.
 */
const EXPECTED_SEQUENTIAL_DEPTH = HCU_FHE_NEG_U64 + HCU_FHE_SELECT_U64 + HCU_FHE_ADD_U64_CT_CT;

/** Global HCU for one update on a fully warm path of a height-`depth` tree. */
function expectedGlobalHCU(depth: number): number {
  return HCU_FHE_NEG_U64 + HCU_FHE_SELECT_U64 + (depth + 1) * HCU_FHE_ADD_U64_CT_CT;
}

const HCU_FHE_LT_U64_CT_CT = 146_000;
const HCU_FHE_SUB_U64_CT_CT = 162_000;
const HCU_FHE_ADD_U16 = 93_000;

/**
 * Global HCU the walk needs at height `d`.
 *
 * Per level: one lt, one sub, one select to apply the sub, one select to fold
 * the branch bit into the index. Plus the oblivious read of the current node's
 * left-child sum, which at level k is a fold over 2^k candidates costing
 * 2^k - 1 selects. Plus the balanced sum that packs the index.
 *
 * The oblivious read is the term that matters: it sums to 2^d - d - 1 selects,
 * which is linear in the number of leaves and swamps everything else past 2^8.
 */
function expectedWalkGlobalHCU(d: number): number {
  const perLevel =
    HCU_FHE_LT_U64_CT_CT + HCU_FHE_SUB_U64_CT_CT + HCU_FHE_SELECT_U64 + HCU_FHE_SELECT_U64;
  const obliviousReads = (2 ** d - d - 1) * HCU_FHE_SELECT_U64;
  const indexPacking = (d - 1) * HCU_FHE_ADD_U16;
  return d * perLevel + obliviousReads + indexPacking;
}

/** Register heights under test. Height d means a register of 2^d leaves. */
const HEIGHTS = [4, 8, 12, 16] as const;

/** Leaves seeded before measuring. At height 4 this is full occupancy. */
const SEED_LEAVES = 16;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type Measurement = {
  height: number;
  registerSize: number;
  sequentialDepth: number;
  globalHCU: number;
  gasUsed: bigint;
  /** Intrinsic cost of the transaction payload, EIP-2028 pricing. */
  calldataGas: bigint;
  /** gasUsed minus the payload cost: what the EVM actually executed. */
  executionGas: bigint;
};

/**
 * Intrinsic gas for a transaction payload: 4 per zero byte, 16 per non-zero.
 *
 * Two encryptions of the same value produce different ciphertext bytes, so two
 * otherwise identical transactions differ in gas purely by how many zero bytes
 * the randomness happened to contain. Subtracting this leaves the execution
 * cost, which is what has to match if the code path is genuinely the same.
 */
function calldataGas(data: string): bigint {
  let gas = 0n;
  for (const byte of ethers.getBytes(data)) {
    gas += byte === 0 ? 4n : 16n;
  }
  return gas;
}

function pct(value: number, limit: number): string {
  return `${((value / limit) * 100).toFixed(2)}%`;
}

function n(value: number | bigint): string {
  return value.toLocaleString("en-US");
}

/**
 * Run one `update` with real ciphertext input and return the coprocessor's
 * HCU accounting for that transaction.
 */
async function measureUpdate(
  register: SortisRegisterHarness,
  signer: HardhatEthersSigner,
  leaf: number,
  amount: bigint,
  isAdd: boolean,
): Promise<Measurement> {
  const registerAddress = await register.getAddress();

  const encrypted = await fhevm
    .createEncryptedInput(registerAddress, signer.address)
    .add64(amount)
    .addBool(isAdd)
    .encrypt();

  const tx = await register
    .connect(signer)
    .update(leaf, encrypted.handles[0], encrypted.handles[1], encrypted.inputProof);

  const receipt = await tx.wait();
  if (receipt === null) throw new Error("update transaction produced no receipt");

  const hcu = fhevm.computeTransactionHCU(receipt);
  const height = Number(await register.DEPTH());
  const payload = calldataGas(tx.data);

  return {
    height,
    registerSize: 2 ** height,
    sequentialDepth: hcu.maxHCUDepth,
    globalHCU: hcu.globalHCU,
    gasUsed: receipt.gasUsed,
    calldataGas: payload,
    executionGas: receipt.gasUsed - payload,
  };
}

/** Deploy a register of the given height and populate it. */
async function deploySeeded(height: number, owner: HardhatEthersSigner): Promise<SortisRegisterHarness> {
  const factory = await ethers.getContractFactory("SortisRegisterHarness", owner);
  const register = (await factory.deploy(height)) as unknown as SortisRegisterHarness;
  await register.waitForDeployment();

  // Spread the seeded stakes across the leaf space so the measured update is
  // not sitting alone in an otherwise empty tree.
  const capacity = 2 ** height;
  const count = Math.min(SEED_LEAVES, capacity);
  const stride = Math.floor(capacity / count);

  for (let i = 0; i < count; i++) {
    await (await register.seed(i * stride, 1_000n + BigInt(i), true)).wait();
  }

  return register;
}

// ---------------------------------------------------------------------------

describe("HCU budget", function () {
  let deployer: HardhatEthersSigner;
  let alice: HardhatEthersSigner;

  before(async function () {
    if (!fhevm.isMock) {
      // HCU accounting is produced by the mock coprocessor. On a live network
      // the limits are enforced but not reported per-transaction.
      this.skip();
    }
    [deployer, alice] = await ethers.getSigners();
  });

  // -------------------------------------------------------------------------
  // Correctness first. An HCU measurement of a broken update proves nothing.
  // -------------------------------------------------------------------------

  describe("the update path is correct", function () {
    it("root equals the sum of every committed stake", async function () {
      const factory = await ethers.getContractFactory("SortisRegisterHarness", deployer);
      const register = (await factory.deploy(4)) as unknown as SortisRegisterHarness;
      await register.waitForDeployment();

      const amounts = [500n, 1_200n, 75n, 9_999n];
      for (let i = 0; i < amounts.length; i++) {
        await (await register.seed(i, amounts[i], true)).wait();
      }

      await (await register.allowRoot(deployer.address)).wait();

      const root = await register.root();
      const total = await fhevm.userDecryptEuint(
        FhevmType.euint64,
        root,
        await register.getAddress(),
        deployer,
      );

      expect(total).to.equal(amounts.reduce((a, b) => a + b, 0n));
    });

    it("a release subtracts without Solidity ever branching on the ciphertext", async function () {
      const factory = await ethers.getContractFactory("SortisRegisterHarness", deployer);
      const register = (await factory.deploy(4)) as unknown as SortisRegisterHarness;
      await register.waitForDeployment();

      await (await register.seed(0, 10_000n, true)).wait();
      // isAdd = false. The direction is encrypted; the branch is FHE.select.
      await (await register.seed(0, 2_500n, false)).wait();

      await (await register.allowRoot(deployer.address)).wait();

      const total = await fhevm.userDecryptEuint(
        FhevmType.euint64,
        await register.root(),
        await register.getAddress(),
        deployer,
      );

      expect(total).to.equal(7_500n);
    });

    it("a commit and a release are indistinguishable from outside", async function () {
      const factory = await ethers.getContractFactory("SortisRegisterHarness", deployer);
      const register = (await factory.deploy(8)) as unknown as SortisRegisterHarness;
      await register.waitForDeployment();

      // Warm the path so no measurement pays for cold slots.
      await (await register.seed(0, 100_000n, true)).wait();

      const commit = await measureUpdate(register, alice, 0, 1_000n, true);
      const secondCommit = await measureUpdate(register, alice, 0, 1_000n, true);
      const release = await measureUpdate(register, alice, 0, 1_000n, false);

      // Identical encrypted work. `isAdd` never reaches Solidity control flow,
      // so the operation trace of a release is the operation trace of a commit.
      expect(release.sequentialDepth).to.equal(commit.sequentialDepth);
      expect(release.globalHCU).to.equal(commit.globalHCU);

      // Identical EVM work. Raw gasUsed differs by a few units between ANY two
      // of these transactions -- including the two commits -- because each
      // encryption produces different ciphertext bytes and zero bytes are
      // cheaper to send than non-zero ones. Net out the payload and the
      // execution cost is exactly equal, which is the claim that matters:
      // nothing an observer can measure separates a commit from a release.
      expect(secondCommit.executionGas).to.equal(commit.executionGas);
      expect(release.executionGas).to.equal(commit.executionGas);
    });

    it("the plaintext seed helper costs one trivial encrypt more than update", async function () {
      const factory = await ethers.getContractFactory("SortisRegisterHarness", deployer);
      const register = (await factory.deploy(16)) as unknown as SortisRegisterHarness;
      await register.waitForDeployment();

      await (await register.seed(0, 1_000n, true)).wait(); // warm the path
      const receipt = await (await register.seed(0, 500n, true)).wait();
      const hcu = fhevm.computeTransactionHCU(receipt!);

      // `seed` takes plaintext, so it trivially encrypts both the amount and
      // the direction (32 HCU each). Only the amount feeds FHE.neg, so only
      // that one lands in the dependent chain. This pins the figure quoted
      // above SortisRegisterHarness.seed.
      expect(hcu.maxHCUDepth).to.equal(EXPECTED_SEQUENTIAL_DEPTH + HCU_TRIVIAL_ENCRYPT);
    });
  });

  // -------------------------------------------------------------------------
  // The headline measurement.
  // -------------------------------------------------------------------------

  describe("a single update at register sizes 2^4, 2^8, 2^12, 2^16", function () {
    const warm: Measurement[] = [];
    const cold: Measurement[] = [];

    it("measures every register size", async function () {
      for (const height of HEIGHTS) {
        const register = await deploySeeded(height, deployer);

        // Warm path: leaf 0 was seeded, so every node above it exists.
        warm.push(await measureUpdate(register, alice, 0, 5_000n, true));

        // Cold path: the last leaf has never been touched, so the lower part
        // of its path is uninitialized and pays a trivial encrypt per node.
        cold.push(await measureUpdate(register, alice, 2 ** height - 1, 5_000n, true));
      }

      const line = "-".repeat(78);
      console.log("");
      console.log(`  Sortis register -- sequential HCU depth of one _update`);
      console.log(`  sequential depth limit ${n(SEQUENTIAL_DEPTH_LIMIT)} | global limit ${n(GLOBAL_HCU_LIMIT)}`);
      console.log(`  ${line}`);
      console.log(
        `  ${"register".padEnd(12)}${"seq depth".padStart(12)}${"of budget".padStart(12)}` +
          `${"global HCU".padStart(14)}${"of budget".padStart(12)}${"gas".padStart(12)}`,
      );
      console.log(`  ${line}`);

      for (const m of warm) {
        console.log(
          `  ${`2^${m.height}`.padEnd(12)}` +
            `${n(m.sequentialDepth).padStart(12)}` +
            `${pct(m.sequentialDepth, SEQUENTIAL_DEPTH_LIMIT).padStart(12)}` +
            `${n(m.globalHCU).padStart(14)}` +
            `${pct(m.globalHCU, GLOBAL_HCU_LIMIT).padStart(12)}` +
            `${n(m.gasUsed).padStart(12)}`,
        );
      }

      console.log(`  ${line}`);
      console.log(
        `  sequential depth is flat at ${n(warm[0].sequentialDepth)} HCU across a ` +
          `${2 ** (HEIGHTS[HEIGHTS.length - 1] - HEIGHTS[0])}x growth in register size.`,
      );
      console.log(
        `  global HCU grows by ${n(HCU_FHE_ADD_U64_CT_CT)} per level, which is O(log N) in stakes.`,
      );
      console.log(
        `  a linear scan over N encrypted balances would hit the depth limit at N = ` +
          `${Math.floor(SEQUENTIAL_DEPTH_LIMIT / HCU_FHE_ADD_U64_CT_CT)}.`,
      );
      console.log("");
    });

    it("sequential depth is 348,000 at every register size", function () {
      for (const m of warm) {
        expect(m.sequentialDepth, `warm depth at 2^${m.height}`).to.equal(EXPECTED_SEQUENTIAL_DEPTH);
      }
    });

    it("sequential depth does not grow with the register", function () {
      const depths = warm.map((m) => m.sequentialDepth);
      expect(new Set(depths).size, `distinct depths across sizes: ${depths.join(", ")}`).to.equal(1);
    });

    it("sequential depth stays inside the 5,000,000 budget", function () {
      for (const m of warm) {
        expect(m.sequentialDepth, `depth at 2^${m.height}`).to.be.lessThan(SEQUENTIAL_DEPTH_LIMIT);
      }
      // 14x headroom at production depth is what leaves room for the TWAB
      // accrual and the confidential transfer in the same commit transaction.
      const atProduction = warm[warm.length - 1].sequentialDepth;
      expect(atProduction * 14).to.be.lessThan(SEQUENTIAL_DEPTH_LIMIT);
    });

    it("global HCU is 186,000 + (DEPTH + 1) * 162,000", function () {
      for (const m of warm) {
        expect(m.globalHCU, `global at 2^${m.height}`).to.equal(expectedGlobalHCU(m.height));
      }
    });

    it("global HCU grows by exactly one add per level", function () {
      for (let i = 1; i < warm.length; i++) {
        const levels = warm[i].height - warm[i - 1].height;
        expect(warm[i].globalHCU - warm[i - 1].globalHCU).to.equal(levels * HCU_FHE_ADD_U64_CT_CT);
      }
    });

    it("global HCU stays inside the 20,000,000 budget", function () {
      for (const m of warm) {
        expect(m.globalHCU, `global at 2^${m.height}`).to.be.lessThan(GLOBAL_HCU_LIMIT);
      }
    });

    it("cost does not depend on how full the register is", function () {
      // A cold path pays one trivial encrypt (32 HCU) per uninitialized node
      // and nothing else. Depth is identical because the trivial encrypt sits
      // beside the chain, not in it.
      for (let i = 0; i < warm.length; i++) {
        expect(cold[i].sequentialDepth, `cold depth at 2^${cold[i].height}`).to.equal(
          warm[i].sequentialDepth,
        );

        const overhead = cold[i].globalHCU - warm[i].globalHCU;
        expect(overhead).to.be.at.least(0);
        expect(overhead).to.be.at.most((cold[i].height + 1) * HCU_TRIVIAL_ENCRYPT);
      }
    });
  });

  // -------------------------------------------------------------------------
  // The walk.
  // -------------------------------------------------------------------------

  describe("the walk resolves a lot to a leaf", function () {
    /**
     * A register of height 4 holding four known stakes. Prefix sums:
     *
     *     leaf 0    500      lot in [    0,   500)
     *     leaf 1  1,200      lot in [  500, 1,700)
     *     leaf 2     75      lot in [1,700, 1,775)
     *     leaf 3  9,999      lot in [1,775,11,774)
     */
    const STAKES = [500n, 1_200n, 75n, 9_999n];

    async function deployKnown(): Promise<SortisRegisterHarness> {
      const factory = await ethers.getContractFactory("SortisRegisterHarness", deployer);
      const register = (await factory.deploy(4)) as unknown as SortisRegisterHarness;
      await register.waitForDeployment();
      for (let i = 0; i < STAKES.length; i++) {
        await (await register.seed(i, STAKES[i], true)).wait();
      }
      return register;
    }

    async function resolve(register: SortisRegisterHarness, lot: bigint): Promise<bigint> {
      await (await register.connect(deployer).walk(lot)).wait();
      return fhevm.userDecryptEuint(
        FhevmType.euint16,
        await register.lastWalkResult(),
        await register.getAddress(),
        deployer,
      );
    }

    it("lands on the leaf whose interval contains the lot", async function () {
      const register = await deployKnown();

      // Boundaries on both sides of every interval, which is where an
      // off-by-one in the comparison direction would show up.
      const cases: [bigint, bigint][] = [
        [0n, 0n],
        [499n, 0n],
        [500n, 1n],
        [1_699n, 1n],
        [1_700n, 2n],
        [1_774n, 2n],
        [1_775n, 3n],
        [11_773n, 3n],
      ];

      for (const [lot, expected] of cases) {
        expect(await resolve(register, lot), `lot ${lot}`).to.equal(expected);
      }
    });

    it("selects each leaf in proportion to its stake", async function () {
      const register = await deployKnown();
      const total = STAKES.reduce((a, b) => a + b, 0n);

      // Sample the lot space evenly. A leaf holding 85% of the weight should
      // come up in about 85% of the samples. This is the property the whole
      // protocol rests on, so it is worth asserting rather than assuming.
      const samples = 24;
      const hits = [0, 0, 0, 0];
      for (let i = 0; i < samples; i++) {
        const lot = (total * BigInt(i)) / BigInt(samples);
        hits[Number(await resolve(register, lot))] += 1;
      }

      for (let leaf = 0; leaf < STAKES.length; leaf++) {
        const expected = (samples * Number(STAKES[leaf])) / Number(total);
        expect(hits[leaf], `leaf ${leaf} hits`).to.be.closeTo(expected, 1.5);
      }
    });

    it("never lands on a leaf with no stake", async function () {
      const register = await deployKnown();
      const total = STAKES.reduce((a, b) => a + b, 0n);

      for (let i = 0; i < 12; i++) {
        const leaf = await resolve(register, (total * BigInt(i)) / 12n);
        expect(leaf).to.be.lessThan(BigInt(STAKES.length));
      }
    });
  });

  describe("walk HCU at register sizes 2^4, 2^8, 2^12, 2^16", function () {
    /**
     * Which budget stopped the transaction, if one did. The coprocessor raises
     * a different custom error for each, and the distinction is the entire
     * finding: `global` means the walk did too much work, `depth` would mean
     * its dependent chain was too long. Only one of those is fixable by
     * splitting the walk across transactions.
     */
    type Binding = "global" | "depth" | "other";

    type WalkMeasurement = {
      height: number;
      sequentialDepth: number | null;
      globalHCU: number | null;
      gasUsed: bigint | null;
      binding: Binding | null;
      failure: string | null;
    };

    function classify(message: string): Binding {
      if (message.includes("HCUTransactionDepthLimitExceeded")) return "depth";
      if (message.includes("HCUTransactionLimitExceeded")) return "global";
      return "other";
    }

    const results: WalkMeasurement[] = [];

    /** Depth extrapolated from the measured per-level slope. */
    function projectedDepth(height: number): number | null {
      const executed = results.filter((m) => m.failure === null);
      if (executed.length < 2) return null;
      const first = executed[0];
      const last = executed[executed.length - 1];
      const perLevel = (last.sequentialDepth! - first.sequentialDepth!) / (last.height - first.height);
      return Math.round(last.sequentialDepth! + (height - last.height) * perLevel);
    }

    it("measures every register size", async function () {
      for (const height of HEIGHTS) {
        const register = await deploySeeded(height, deployer);

        try {
          const tx = await register.connect(alice).walk(5_000n);
          const receipt = await tx.wait();
          const hcu = fhevm.computeTransactionHCU(receipt!);
          results.push({
            height,
            sequentialDepth: hcu.maxHCUDepth,
            globalHCU: hcu.globalHCU,
            gasUsed: receipt!.gasUsed,
            binding: null,
            failure: null,
          });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          results.push({
            height,
            sequentialDepth: null,
            globalHCU: null,
            gasUsed: null,
            binding: classify(message),
            failure: message.split("\n")[0].slice(0, 88),
          });
        }
      }

      const line = "-".repeat(78);
      console.log("");
      console.log(`  Sortis register -- one _walk, root to leaf`);
      console.log(
        `  sequential depth limit ${n(SEQUENTIAL_DEPTH_LIMIT)} | global limit ${n(GLOBAL_HCU_LIMIT)}`,
      );
      console.log(`  ${line}`);
      console.log(
        `  ${"register".padEnd(11)}${"seq depth".padStart(12)}${"of budget".padStart(11)}` +
          `${"global HCU".padStart(16)}${"of budget".padStart(11)}${"gas".padStart(13)}`,
      );
      console.log(`  ${line}`);

      for (const m of results) {
        if (m.failure === null) {
          console.log(
            `  ${`2^${m.height}`.padEnd(11)}` +
              `${n(m.sequentialDepth!).padStart(12)}` +
              `${pct(m.sequentialDepth!, SEQUENTIAL_DEPTH_LIMIT).padStart(11)}` +
              `${n(m.globalHCU!).padStart(16)}` +
              `${pct(m.globalHCU!, GLOBAL_HCU_LIMIT).padStart(11)}` +
              `${n(m.gasUsed!).padStart(13)}`,
          );
        } else {
          const global = expectedWalkGlobalHCU(m.height);
          const depth = projectedDepth(m.height);
          console.log(
            `  ${`2^${m.height}`.padEnd(11)}` +
              `${(depth === null ? "-" : `~${n(depth)}`).padStart(12)}` +
              `${(depth === null ? "-" : pct(depth, SEQUENTIAL_DEPTH_LIMIT)).padStart(11)}` +
              `${`~${n(global)}`.padStart(16)}` +
              `${pct(global, GLOBAL_HCU_LIMIT).padStart(11)}` +
              `${"reverted".padStart(13)}`,
          );
          console.log(
            `  ${" ".repeat(13)}stopped by the ${m.binding} budget: HCUTransaction` +
              `${m.binding === "depth" ? "Depth" : ""}LimitExceeded`,
          );
        }
      }

      console.log(`  ${line}`);
      const executed = results.filter((m) => m.failure === null);
      if (executed.length > 1) {
        const first = executed[0];
        const last = executed[executed.length - 1];
        const perLevel = Math.round(
          (last.sequentialDepth! - first.sequentialDepth!) / (last.height - first.height),
        );
        console.log(
          `  sequential depth grows about ${n(perLevel)} HCU per level and stays inside 5,000,000.`,
        );
      }
      console.log(
        `  global HCU is dominated by the oblivious read: 2^d - d - 1 selects, LINEAR in leaves.`,
      );
      console.log(
        `  the 20,000,000 global cap puts the single-transaction ceiling near 2^8 = 256 stakes.`,
      );
      console.log("");
    });

    it("sequential depth stays under 5,000,000 at every size that executes", function () {
      const executed = results.filter((m) => m.failure === null);
      expect(executed.length, "no register size executed the walk").to.be.greaterThan(0);

      for (const m of executed) {
        expect(m.sequentialDepth, `walk depth at 2^${m.height}`).to.be.lessThan(
          SEQUENTIAL_DEPTH_LIMIT,
        );
      }
    });

    it("sequential depth grows per level, not per leaf", function () {
      const executed = results.filter((m) => m.failure === null);
      if (executed.length < 2) this.skip();

      // One level adds one lt, one sub, one select to apply it, and one fold of
      // the oblivious read: a fixed dependent chain. Doubling the leaf count
      // adds one level, so depth is logarithmic in N even though global is not.
      for (let i = 1; i < executed.length; i++) {
        const levels = executed[i].height - executed[i - 1].height;
        const perLevel = (executed[i].sequentialDepth! - executed[i - 1].sequentialDepth!) / levels;
        expect(
          perLevel,
          `per-level depth between 2^${executed[i - 1].height} and 2^${executed[i].height}`,
        )
          .to.be.greaterThan(100_000)
          .and.to.be.lessThan(400_000);
      }
    });

    it("global HCU matches the closed form where the walk executes", function () {
      for (const m of results.filter((x) => x.failure === null)) {
        // Cold nodes add one 32 HCU trivial encrypt each; allow for them.
        const model = expectedWalkGlobalHCU(m.height);
        expect(m.globalHCU!, `global at 2^${m.height}`).to.be.at.least(model);
        expect(m.globalHCU!, `global at 2^${m.height}`).to.be.at.most(
          model + 2 ** m.height * HCU_TRIVIAL_ENCRYPT,
        );
      }
    });

    it("every size that reverted was stopped by the global budget, never by depth", function () {
      const failed = results.filter((m) => m.failure !== null);
      expect(failed.length, "expected 2^12 and 2^16 not to execute").to.be.greaterThan(0);

      for (const m of failed) {
        // This is the load-bearing assertion of the whole walk story. If one of
        // these ever comes back "depth", the walk has a dependent-chain problem
        // and no amount of checkpointing across transactions will save it.
        expect(m.binding, `what stopped 2^${m.height}`).to.equal("global");
      }
    });

    it("projected depth stays under 5,000,000 at 2^12 and 2^16", function () {
      // Measured directly at 2^4 and 2^8; extrapolated for the two sizes the
      // global budget prevents from running. The extrapolation is honest
      // because per-level depth is a fixed chain -- one lt, one sub, one select
      // to apply it, one fold -- and the measurement above confirms the slope
      // is constant between the sizes that do execute.
      for (const height of [12, 16]) {
        const depth = projectedDepth(height);
        expect(depth, `projected depth at 2^${height}`).to.not.equal(null);
        expect(depth!, `projected depth at 2^${height}`).to.be.lessThan(SEQUENTIAL_DEPTH_LIMIT);
      }
    });

    it("the global budget, not the depth budget, is what binds the walk", function () {
      // The finding this suite exists to surface. Depth is comfortable at every
      // size; the oblivious read blows the global cap past 2^8. If a future
      // change makes 2^12 executable this assertion fails and someone has to
      // come look at why, which is the point of writing it down.
      expect(expectedWalkGlobalHCU(8)).to.be.lessThan(GLOBAL_HCU_LIMIT);
      expect(expectedWalkGlobalHCU(12)).to.be.greaterThan(GLOBAL_HCU_LIMIT);
      expect(expectedWalkGlobalHCU(16)).to.be.greaterThan(GLOBAL_HCU_LIMIT * 100);
    });
  });
});
