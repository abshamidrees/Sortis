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
 * Exceeding either reverts. A confidential prize pool built by encrypting
 * balances and scanning them puts every depositor in one dependent chain, so
 * it dies at thirty. Sortis keeps the weights in a tree.
 *
 * This suite measures the real cost of an update and a draw against both
 * budgets, and finds the largest register a single-transaction draw can
 * actually resolve. That last number is the one the product is designed
 * around, so it is MEASURED by sweeping until the transaction reverts rather
 * than asserted from a model.
 */

const SEQUENTIAL_DEPTH_LIMIT = 5_000_000;
const GLOBAL_HCU_LIMIT = 20_000_000;
const HOUR = 3_600;

// euint64 unit costs, from the HCUByOperator table in fhevm mock-utils.
// Restated so the expectations below are derived rather than copied from a
// previous run: if the coprocessor reprices an operation this fails loudly.
const HCU = {
  ADD_CT_CT: 162_000,
  SUB_CT_CT: 162_000,
  MUL_SCALAR: 365_000,
  MUL_CT_CT: 596_000,
  LT_CT_CT: 146_000,
  NEG: 131_000,
  SELECT: 55_000,
  ADD_U16: 93_000,
  TRIVIAL: 32,
};

/**
 * The dependent chain inside `_update`, whatever the height of the tree:
 *
 *     neg(delta)                   131,000   depth 131,000
 *     select(isAdd, delta, neg)     55,000   depth 186,000
 *     mul(negSigned, hour)         365,000   depth 551,000
 *     add(_intercept[j], .)        162,000   depth 713,000
 *
 * The slope branch runs in parallel off the same selects and tops out at
 * 348,000, so it never reaches the critical path. The 2*(DEPTH+1) node writes
 * all add the SAME two ciphertexts, so they are independent of each other.
 */
const EXPECTED_UPDATE_DEPTH = HCU.NEG + HCU.SELECT + HCU.MUL_SCALAR + HCU.ADD_CT_CT;

/** Global HCU for one update on a fully warm path of a height-`d` tree. */
function expectedUpdateGlobal(d: number): number {
  const prologue = HCU.NEG + 2 * HCU.SELECT + HCU.MUL_SCALAR;
  return prologue + (d + 1) * 2 * HCU.ADD_CT_CT;
}

/**
 * Global HCU for one walk over an active subtree of height `h`.
 *
 * Per level: two oblivious reads collapse to one value each, then one scalar
 * multiply and one add turn the intercept and slope into a weight, then the
 * comparison, the conditional subtraction and the index bit.
 *
 * The oblivious reads are the term that matters. At level k the descent could
 * be on any of 2^k nodes, so every candidate has to be touched, and there are
 * two trees to touch. That sums to 2 * (2^h - h - 1) selects, which is LINEAR
 * in the number of stakes and is what caps a shard.
 */
function expectedWalkGlobal(h: number): number {
  const perLevel =
    HCU.MUL_SCALAR + HCU.ADD_CT_CT + HCU.LT_CT_CT + HCU.SUB_CT_CT + HCU.SELECT + HCU.SELECT;
  const obliviousReads = 2 * (2 ** h - h - 1) * HCU.SELECT;
  const indexPacking = (h - 1) * HCU.ADD_U16;
  return h * perLevel + obliviousReads + indexPacking;
}

const HEIGHTS = [4, 8, 12, 16] as const;

function pct(value: number, limit: number): string {
  return `${((value / limit) * 100).toFixed(2)}%`;
}

function n(value: number | bigint): string {
  return value.toLocaleString("en-US");
}

async function advanceHours(hours: number) {
  await ethers.provider.send("evm_increaseTime", [Math.round(hours * HOUR)]);
  await ethers.provider.send("evm_mine", []);
}

async function deployRegister(
  height: number,
  deployer: HardhatEthersSigner,
): Promise<SortisRegisterHarness> {
  const factory = await ethers.getContractFactory("SortisRegisterHarness", deployer);
  const register = (await factory.deploy(height)) as unknown as SortisRegisterHarness;
  await register.waitForDeployment();
  return register;
}

/** Total register weight at the current hour, decrypted. */
async function totalWeight(
  register: SortisRegisterHarness,
  reader: HardhatEthersSigner,
): Promise<bigint> {
  const t = await register.timeUnitsNow();
  await (await register.weightAt(t)).wait();
  // weightAt stores nothing, so read the handle back from the static call.
  const handle = await register.weightAt.staticCall(t);
  return fhevm.userDecryptEuint(FhevmType.euint64, handle, await register.getAddress(), reader);
}

// ---------------------------------------------------------------------------

describe("HCU budget", function () {
  let deployer: HardhatEthersSigner;
  let alice: HardhatEthersSigner;

  before(async function () {
    if (!fhevm.isMock) this.skip();
    [deployer, alice] = await ethers.getSigners();
  });

  // -------------------------------------------------------------------------
  // The weight line. An HCU measurement of a broken register proves nothing,
  // and this is the part that was broken until the two-tree rewrite.
  // -------------------------------------------------------------------------

  describe("weight is a line, not a stale point", function () {
    it("a stake nobody touches still earns weight", async function () {
      const register = await deployRegister(4, deployer);

      // One commit, and then the stake is never touched again. Under the old
      // accrue-on-change design this stake was worth zero forever, which is
      // the bug the line fixes.
      await (await register.seed(0, 1_000n, true)).wait();
      expect(await totalWeight(register, deployer), "at t0").to.equal(0n);

      await advanceHours(5);
      expect(await totalWeight(register, deployer), "after 5h, untouched").to.equal(5_000n);

      await advanceHours(7);
      expect(await totalWeight(register, deployer), "after 12h, still untouched").to.equal(12_000n);
    });

    it("weight is money multiplied by the hours it sat there", async function () {
      const register = await deployRegister(4, deployer);

      await (await register.seed(0, 1_000n, true)).wait();
      await advanceHours(4);
      // A second stake arrives four hours late.
      await (await register.seed(1, 1_000n, true)).wait();
      await advanceHours(4);

      // Leaf 0: 1,000 for 8h. Leaf 1: 1,000 for 4h.
      expect(await totalWeight(register, deployer)).to.equal(12_000n);
    });

    it("a release stops the clock on the money that left", async function () {
      const register = await deployRegister(4, deployer);

      await (await register.seed(0, 1_000n, true)).wait();
      await advanceHours(10);
      await (await register.seed(0, 600n, false)).wait();
      await advanceHours(10);

      // 1,000 for 10h, then 400 for a further 10h.
      expect(await totalWeight(register, deployer)).to.equal(14_000n);
    });

    it("a stake committed inside the hour is worth nothing", async function () {
      const register = await deployRegister(4, deployer);

      await (await register.seed(0, 1_000n, true)).wait();
      await advanceHours(3);
      // The snipe: a large stake arriving moments before a draw.
      await (await register.seed(1, 1_000_000n, true)).wait();

      // It has been in the pool for zero whole hours, so it carries nothing
      // and cannot move the odds.
      expect(await totalWeight(register, deployer)).to.equal(3_000n);
    });
  });

  // -------------------------------------------------------------------------
  // The update path.
  // -------------------------------------------------------------------------

  describe("one update at register sizes 2^4, 2^8, 2^12, 2^16", function () {
    const measured: { height: number; depth: number; global: number; gas: bigint }[] = [];

    it("measures every register size", async function () {
      for (const height of HEIGHTS) {
        const register = await deployRegister(height, deployer);
        // Warm the path so the measurement is not paying for cold slots.
        await (await register.seed(0, 1_000n, true)).wait();
        await advanceHours(2);

        const encrypted = await fhevm
          .createEncryptedInput(await register.getAddress(), alice.address)
          .add64(5_000n)
          .addBool(true)
          .encrypt();

        const receipt = await (
          await register
            .connect(alice)
            .update(0, encrypted.handles[0], encrypted.handles[1], encrypted.inputProof)
        ).wait();

        const hcu = fhevm.computeTransactionHCU(receipt!);
        measured.push({
          height,
          depth: hcu.maxHCUDepth,
          global: hcu.globalHCU,
          gas: receipt!.gasUsed,
        });
      }

      const line = "-".repeat(74);
      console.log("");
      console.log(`  SortisRegister -- one _update, leaf to root`);
      console.log(`  depth limit ${n(SEQUENTIAL_DEPTH_LIMIT)} | global limit ${n(GLOBAL_HCU_LIMIT)}`);
      console.log(`  ${line}`);
      console.log(
        `  ${"register".padEnd(11)}${"seq depth".padStart(12)}${"of budget".padStart(11)}` +
          `${"global HCU".padStart(13)}${"of budget".padStart(11)}${"gas".padStart(12)}`,
      );
      console.log(`  ${line}`);
      for (const m of measured) {
        console.log(
          `  ${`2^${m.height}`.padEnd(11)}${n(m.depth).padStart(12)}` +
            `${pct(m.depth, SEQUENTIAL_DEPTH_LIMIT).padStart(11)}` +
            `${n(m.global).padStart(13)}${pct(m.global, GLOBAL_HCU_LIMIT).padStart(11)}` +
            `${n(m.gas).padStart(12)}`,
        );
      }
      console.log(`  ${line}`);
      console.log(
        `  depth is flat at ${n(measured[0].depth)} across a ${2 ** (HEIGHTS[3] - HEIGHTS[0])}x growth in capacity.`,
      );
      console.log(
        `  a linear scan over N encrypted balances hits the depth limit at N = ` +
          `${Math.floor(SEQUENTIAL_DEPTH_LIMIT / HCU.ADD_CT_CT)}.`,
      );
      console.log("");
    });

    it("sequential depth is 713,000 at every register size", function () {
      for (const m of measured) {
        expect(m.depth, `depth at 2^${m.height}`).to.equal(EXPECTED_UPDATE_DEPTH);
      }
    });

    it("sequential depth does not grow with the register", function () {
      expect(new Set(measured.map((m) => m.depth)).size).to.equal(1);
    });

    it("global HCU is 606,000 + (DEPTH + 1) * 324,000", function () {
      for (const m of measured) {
        expect(m.global, `global at 2^${m.height}`).to.equal(expectedUpdateGlobal(m.height));
      }
    });

    it("both budgets hold at every size", function () {
      for (const m of measured) {
        expect(m.depth).to.be.lessThan(SEQUENTIAL_DEPTH_LIMIT);
        expect(m.global).to.be.lessThan(GLOBAL_HCU_LIMIT);
      }
    });

    it("uses the scalar multiply for the time term, never ciphertext-ciphertext", function () {
      // The multiply is balance times a plaintext hour count. The scalar
      // overload is 365,000 and the ciphertext one 596,000, and picking the
      // wrong one would also drag the hour into the dependent chain.
      expect(EXPECTED_UPDATE_DEPTH).to.be.lessThan(
        HCU.NEG + HCU.SELECT + HCU.MUL_CT_CT + HCU.ADD_CT_CT,
      );
      for (const m of measured) {
        expect(m.depth).to.equal(EXPECTED_UPDATE_DEPTH);
      }
    });
  });

  // -------------------------------------------------------------------------
  // The walk, and the shard ceiling it sets.
  // -------------------------------------------------------------------------

  describe("the walk resolves a lot to a leaf", function () {
    const STAKES = [500n, 1_200n, 75n, 9_999n];

    async function deployKnown(): Promise<SortisRegisterHarness> {
      const register = await deployRegister(4, deployer);
      for (let i = 0; i < STAKES.length; i++) {
        await (await register.seed(i, STAKES[i], true)).wait();
      }
      // One hour of holding, so every weight is its balance times one.
      await advanceHours(1);
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

      // Prefix sums after one hour: 500, 1,700, 1,775, 11,774.
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

    it("selects each leaf in proportion to its weight", async function () {
      const register = await deployKnown();
      const total = STAKES.reduce((a, b) => a + b, 0n);

      const samples = 24;
      const hits = [0, 0, 0, 0];
      for (let i = 0; i < samples; i++) {
        hits[Number(await resolve(register, (total * BigInt(i)) / BigInt(samples)))] += 1;
      }

      for (let leaf = 0; leaf < STAKES.length; leaf++) {
        const expected = (samples * Number(STAKES[leaf])) / Number(total);
        expect(hits[leaf], `leaf ${leaf} hits`).to.be.closeTo(expected, 1.5);
      }
    });

    it("weights by time held, not by balance", async function () {
      const register = await deployRegister(4, deployer);
      // Equal money, unequal time. Leaf 0 holds for 10h, leaf 1 for 2h.
      await (await register.seed(0, 1_000n, true)).wait();
      await advanceHours(8);
      await (await register.seed(1, 1_000n, true)).wait();
      await advanceHours(2);

      // Weights 10,000 and 2,000. Anything below 10,000 is leaf 0.
      expect(await resolve(register, 9_999n)).to.equal(0n);
      expect(await resolve(register, 10_000n)).to.equal(1n);
    });
  });

  describe("the shard ceiling", function () {
    type Probe = {
      height: number;
      stakes: number;
      depth: number | null;
      global: number | null;
      binding: string | null;
    };

    const probes: Probe[] = [];

    it("sweeps until a draw stops fitting in one transaction", async function () {
      // Sweep upward until the transaction reverts. The ceiling is measured,
      // not modelled: it is the number the sharded design is built around and
      // guessing it would be the one number on the site nobody could check.
      for (let height = 2; height <= 9; height++) {
        const register = await deployRegister(Math.max(height, 4) as number, deployer);

        // Occupy the far end so activeHeight() is exactly `height`.
        await (await register.seed(0, 1_000n, true)).wait();
        await (await register.seed(2 ** height - 1, 1_000n, true)).wait();
        await advanceHours(2);

        try {
          const receipt = await (await register.connect(alice).walk(1_000n)).wait();
          const hcu = fhevm.computeTransactionHCU(receipt!);
          probes.push({
            height,
            stakes: 2 ** height,
            depth: hcu.maxHCUDepth,
            global: hcu.globalHCU,
            binding: null,
          });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          probes.push({
            height,
            stakes: 2 ** height,
            depth: null,
            global: null,
            binding: message.includes("HCUTransactionDepthLimitExceeded")
              ? "depth"
              : message.includes("HCUTransactionLimitExceeded")
                ? "global"
                : "other",
          });
        }
      }

      const line = "-".repeat(74);
      console.log("");
      console.log(`  SortisRegister -- one _walk, and where it stops fitting`);
      console.log(`  depth limit ${n(SEQUENTIAL_DEPTH_LIMIT)} | global limit ${n(GLOBAL_HCU_LIMIT)}`);
      console.log(`  ${line}`);
      console.log(
        `  ${"stakes".padEnd(10)}${"seq depth".padStart(12)}${"of budget".padStart(11)}` +
          `${"global HCU".padStart(13)}${"of budget".padStart(11)}${"  result"}`,
      );
      console.log(`  ${line}`);
      for (const p of probes) {
        if (p.binding === null) {
          console.log(
            `  ${n(p.stakes).padEnd(10)}${n(p.depth!).padStart(12)}` +
              `${pct(p.depth!, SEQUENTIAL_DEPTH_LIMIT).padStart(11)}` +
              `${n(p.global!).padStart(13)}${pct(p.global!, GLOBAL_HCU_LIMIT).padStart(11)}` +
              `  fits`,
          );
        } else {
          const projected = expectedWalkGlobal(p.height);
          console.log(
            `  ${n(p.stakes).padEnd(10)}${"-".padStart(12)}${"-".padStart(11)}` +
              `${`~${n(projected)}`.padStart(13)}${pct(projected, GLOBAL_HCU_LIMIT).padStart(11)}` +
              `  reverts, ${p.binding} budget`,
          );
        }
      }
      console.log(`  ${line}`);
      const fitting = probes.filter((p) => p.binding === null);
      const ceiling = fitting[fitting.length - 1];
      console.log(
        `  a single-transaction winner-hiding draw resolves up to ${n(ceiling.stakes)} stakes.`,
      );
      const perLevel =
        (ceiling.depth! - fitting[0].depth!) / (ceiling.height - fitting[0].height);
      console.log(
        `  DEPTH is what binds, at about ${n(Math.round(perLevel))} HCU per level. Turning a node's`,
      );
      console.log(
        `  intercept and slope into a weight costs a scalar multiply and an add on the`,
      );
      console.log(
        `  critical path, and that is the price of a weight line that never goes stale.`,
      );
      console.log(
        `  A chain too long cannot be split across transactions, so this is a hard ceiling.`,
      );
      console.log("");
    });

    it("finds a ceiling, and it is the depth budget that sets it", function () {
      const fitting = probes.filter((p) => p.binding === null);
      const failing = probes.filter((p) => p.binding !== null);

      expect(fitting.length, "no register size resolved a draw").to.be.greaterThan(0);
      expect(failing.length, "the sweep never found a ceiling").to.be.greaterThan(0);

      // This flipped when weight became a line. The single-tree walk was
      // stopped by the global budget, which is splittable across checkpointed
      // transactions. The two-tree walk is stopped by DEPTH, because turning
      // intercept and slope into a weight puts a scalar multiply and an add on
      // the critical path at every level. A chain that is too long cannot be
      // split, so this ceiling is hard in a way the old one was not.
      for (const p of failing) {
        expect(p.binding, `what stopped ${p.stakes} stakes`).to.equal("depth");
      }
    });

    it("the ceiling is 64 stakes on the current design", function () {
      const fitting = probes.filter((p) => p.binding === null);
      const ceiling = fitting[fitting.length - 1];

      // Pinned so that a change to the walk which moves this number has to
      // move it here too, and cannot quietly change what the product claims.
      expect(ceiling.stakes, "measured shard ceiling").to.equal(64);
      expect(ceiling.depth!).to.be.lessThan(SEQUENTIAL_DEPTH_LIMIT);
      expect(ceiling.global!).to.be.lessThan(GLOBAL_HCU_LIMIT);
    });

    it("keeps depth far inside its budget at every size that fits", function () {
      for (const p of probes.filter((x) => x.binding === null)) {
        expect(p.depth, `depth at ${p.stakes} stakes`).to.be.lessThan(SEQUENTIAL_DEPTH_LIMIT);
      }
    });

    it("global HCU matches the closed form where the walk executes", function () {
      for (const p of probes.filter((x) => x.binding === null)) {
        const model = expectedWalkGlobal(p.height);
        expect(p.global!, `global at 2^${p.height}`).to.be.at.least(model);
        // Cold nodes add one 32 HCU trivial encrypt each.
        expect(p.global!, `global at 2^${p.height}`).to.be.at.most(
          model + 2 * 2 ** p.height * HCU.TRIVIAL,
        );
      }
    });
  });
});
