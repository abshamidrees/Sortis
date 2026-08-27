import hre from "hardhat";
import { readFileSync } from "fs";
import { join } from "path";

import { FhevmType } from "@fhevm/hardhat-plugin";

const { ethers, fhevm } = hre;

/**
 * A full commit, wait, release cycle against a live network.
 *
 * The same sequence runs in test/Pool.t.ts against the mock coprocessor. This
 * script is the version that proves it on Sepolia, where the coprocessor, the
 * KMS and the relayer are real and the HCU limits are enforced by the chain
 * rather than by a local mock.
 *
 *     npx hardhat run scripts/cycle.ts --network sepolia
 *
 * Requires scripts/deploy.ts to have run first.
 */

/** How long to hold before releasing. One TIME_UNIT is one hour. */
const WAIT_SECONDS = Number(process.env.CYCLE_WAIT_SECONDS ?? 60 * 60 + 60);

const MINT = 2_000_000n; // 2 cUSDT at 6 decimals
const COMMIT = 1_000_000n;
const RELEASE = 400_000n;
const OVER_RELEASE = 50_000_000n;

function log(step: string, detail = "") {
  const stamp = new Date().toISOString().slice(11, 19);
  console.log(`[${stamp}] ${step}${detail ? "  " + detail : ""}`);
}

async function main() {
  const network = hre.network.name;
  const path = join(__dirname, "..", "deployments", `${network}.json`);

  let record: { cUSDT: string; pool: string; depth: number };
  try {
    record = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    throw new Error(`no deployments/${network}.json -- run scripts/deploy.ts --network ${network} first`);
  }

  const [signer] = await ethers.getSigners();
  const usdt = await ethers.getContractAt("MockConfidentialUSDT", record.cUSDT, signer);
  const pool = await ethers.getContractAt("SortisPool", record.pool, signer);

  console.log(`network ${network}   pool ${record.pool}   depth ${record.depth}`);
  console.log(`account ${signer.address}\n`);

  const readStake = () =>
    fhevm.userDecryptEuint(FhevmType.euint64, await pool.stakeOf(signer.address), record.pool, signer);
  const readWallet = () =>
    fhevm.userDecryptEuint(
      FhevmType.euint64,
      await usdt.confidentialBalanceOf(signer.address),
      record.cUSDT,
      signer,
    );

  const encrypt = async (amount: bigint) =>
    fhevm.createEncryptedInput(record.pool, signer.address).add64(amount).encrypt();

  // --- fund -------------------------------------------------------------
  log("mint", `${MINT} base units of cUSDT`);
  await (await usdt.mint(signer.address, MINT)).wait();

  log("setOperator", "authorising the pool to pull");
  await (await usdt.setOperator(record.pool, 2n ** 47n)).wait();

  log("wallet", `${await readWallet()}`);

  // --- commit -----------------------------------------------------------
  log("commit", `${COMMIT}`);
  {
    const enc = await encrypt(COMMIT);
    const receipt = await (await pool.commit(enc.handles[0], enc.inputProof)).wait();
    log("  mined", `block ${receipt!.blockNumber}  gas ${receipt!.gasUsed}`);
  }
  log("stake", `${await readStake()}`);
  log("wallet", `${await readWallet()}`);

  // --- wait -------------------------------------------------------------
  // The TWAB accrues in whole hours, so the hold has to cross an hour boundary
  // for the stake to earn any weight at all. That is the anti-snipe property
  // doing its job, not a bug.
  log("wait", `${WAIT_SECONDS}s for the TWAB to accrue`);
  await new Promise((resolve) => setTimeout(resolve, WAIT_SECONDS * 1000));
  log("pending", `${await pool.pendingUnits(signer.address)} whole hours accrued`);

  // --- release ----------------------------------------------------------
  log("release", `${RELEASE}`);
  {
    const enc = await encrypt(RELEASE);
    const receipt = await (await pool.release(enc.handles[0], enc.inputProof)).wait();
    log("  mined", `block ${receipt!.blockNumber}  gas ${receipt!.gasUsed}`);
  }
  const stakeAfter = await readStake();
  log("stake", `${stakeAfter}`);
  log("wallet", `${await readWallet()}`);

  // --- over-release, which must be an encrypted no-op --------------------
  log("release", `${OVER_RELEASE} (more than the stake holds)`);
  {
    const enc = await encrypt(OVER_RELEASE);
    const receipt = await (await pool.release(enc.handles[0], enc.inputProof)).wait();
    log("  mined", `block ${receipt!.blockNumber}  gas ${receipt!.gasUsed}  status ${receipt!.status}`);
  }
  const stakeFinal = await readStake();
  log("stake", `${stakeFinal}`);

  console.log("");
  if (stakeFinal === stakeAfter) {
    console.log("over-release was a no-op: the transaction succeeded and the stake did not move.");
  } else {
    throw new Error(`over-release changed the stake: ${stakeAfter} -> ${stakeFinal}`);
  }
  console.log("cycle complete.");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
