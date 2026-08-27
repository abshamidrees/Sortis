import hre from "hardhat";
import { readFileSync, writeFileSync } from "fs";
import { join } from "path";

import { FhevmType } from "@fhevm/hardhat-plugin";

const { ethers, fhevm } = hre;

/**
 * One live commit, wait and release cycle, then one live draw, against real
 * Sepolia with the real coprocessor, KMS and relayer.
 *
 *     npx hardhat run scripts/live.ts --network sepolia
 *
 * Both halves run in ONE process on purpose. `initializeCLIApi` downloads the
 * 4.6MB PKE CRS from S3 in eu-west-1, which takes about twenty minutes on a
 * slow link and is not cached between processes. Doing the cycle and the draw
 * separately would pay that twice.
 *
 * Budget roughly ninety minutes end to end: twenty for the key material, an
 * hour for the stake to cross an hour boundary so it carries weight, and about
 * forty seconds per encrypted input.
 */

const MINT = 2_000_000n;
const COMMIT = 1_000_000n;
const RELEASE = 400_000n;
const OVER_RELEASE = 50_000_000n;
const PRIZE = 50_000n;

/** The register counts weight in whole hours, so the hold has to cross one. */
const HOLD_SECONDS = Number(process.env.LIVE_HOLD_SECONDS ?? 3_660);

const steps: { at: string; step: string; detail: string }[] = [];

function log(step: string, detail = "") {
  const at = new Date().toISOString().slice(11, 19);
  steps.push({ at, step, detail });
  console.log(`[${at}] ${step}${detail ? "  " + detail : ""}`);
}

async function main() {
  const network = hre.network.name;
  const path = join(__dirname, "..", "deployments", `${network}.json`);
  const rec = JSON.parse(readFileSync(path, "utf8"));

  log("init", "downloading key material, this takes about twenty minutes");
  const t0 = Date.now();
  await fhevm.initializeCLIApi();
  log("  ready", `${((Date.now() - t0) / 1000).toFixed(0)}s`);

  const [signer] = await ethers.getSigners();
  const pool = await ethers.getContractAt("SortisPool", rec.pool, signer);
  const draw = await ethers.getContractAt("SortisDraw", rec.draw, signer);
  const cusdt = await ethers.getContractAt("MockConfidentialUSDT", rec.cUSDT, signer);
  const yieldAdapter = await ethers.getContractAt("MockYieldAdapter", rec.yieldAdapter, signer);

  console.log(`\nnetwork ${network}   shard depth ${rec.depth} (${2 ** rec.depth} stakes)`);
  console.log(`pool ${rec.pool}`);
  console.log(`draw ${rec.draw}`);
  console.log(`account ${signer.address}\n`);

  const encrypt = async (amount: bigint) =>
    fhevm.createEncryptedInput(rec.pool, signer.address).add64(amount).encrypt();

  const readStake = async () =>
    fhevm.userDecryptEuint(FhevmType.euint64, await pool.stakeOf(signer.address), rec.pool, signer);
  const readWallet = async () =>
    fhevm.userDecryptEuint(
      FhevmType.euint64,
      await cusdt.confidentialBalanceOf(signer.address),
      rec.cUSDT,
      signer,
    );

  // ---- fund -------------------------------------------------------------
  log("mint", `${MINT} base units of cUSDT`);
  await (await cusdt.mint(signer.address, MINT)).wait();
  log("setOperator", "authorising the pool to pull");
  await (await cusdt.setOperator(rec.pool, 2n ** 47n)).wait();
  log("wallet", `${await readWallet()}`);

  // ---- commit -----------------------------------------------------------
  log("commit", `${COMMIT}`);
  {
    const enc = await encrypt(COMMIT);
    const r = await (await pool.commit(enc.handles[0], enc.inputProof)).wait();
    log("  mined", `block ${r!.blockNumber}  gas ${r!.gasUsed}`);
  }
  log("stake", `${await readStake()}`);
  log("hour", `${await pool.timeUnitsNow()} since genesis`);

  // ---- hold -------------------------------------------------------------
  log("hold", `${HOLD_SECONDS}s so the stake crosses an hour boundary`);
  await new Promise((r) => setTimeout(r, HOLD_SECONDS * 1000));
  log("hour", `${await pool.timeUnitsNow()} since genesis`);

  // ---- release ----------------------------------------------------------
  log("release", `${RELEASE}`);
  {
    const enc = await encrypt(RELEASE);
    const r = await (await pool.release(enc.handles[0], enc.inputProof)).wait();
    log("  mined", `block ${r!.blockNumber}  gas ${r!.gasUsed}`);
  }
  const stakeAfterRelease = await readStake();
  log("stake", `${stakeAfterRelease}`);
  log("wallet", `${await readWallet()}`);

  // ---- over-release, which must be an encrypted no-op --------------------
  log("release", `${OVER_RELEASE} (more than the stake holds)`);
  {
    const enc = await encrypt(OVER_RELEASE);
    const r = await (await pool.release(enc.handles[0], enc.inputProof)).wait();
    log("  mined", `block ${r!.blockNumber}  gas ${r!.gasUsed}  status ${r!.status}`);
  }
  const stakeFinal = await readStake();
  log("stake", `${stakeFinal}`);
  if (stakeFinal !== stakeAfterRelease) {
    throw new Error(`over-release moved the stake: ${stakeAfterRelease} -> ${stakeFinal}`);
  }
  log("  no-op", "the transaction succeeded and the stake did not move");

  // ---- the draw ---------------------------------------------------------
  log("accrue", `${PRIZE} of yield into the pot`);
  await (await yieldAdapter.accrue(PRIZE)).wait();

  log("openDraw", "committing the register before any randomness exists");
  const openReceipt = await (await draw.openDraw()).wait();
  const drawId = await draw.drawCount();
  const info = await draw.drawInfo(drawId);
  log("  opened", `draw ${drawId} at block ${info[1]}  prize ${info[2]}  hour ${info[6]}`);
  log("  total handle", `${info[0]}`);
  log("  gas", `${openReceipt!.gasUsed}`);

  log("publicDecrypt", "fetching the KMS proof for the committed total");
  const decrypted = await fhevm.publicDecrypt([info[0]]);
  const total = ethers.AbiCoder.defaultAbiCoder().decode(
    ["uint256"],
    decrypted.abiEncodedClearValues,
  )[0];
  log("  total weight", `${total}`);

  log("wait", "for a block after the open");
  while ((await ethers.provider.getBlockNumber()) <= Number(info[1])) {
    await new Promise((r) => setTimeout(r, 4_000));
  }

  log("drawLot", "native randomness, reduced modulo the verified total");
  const lotReceipt = await (
    await draw.drawLot(drawId, decrypted.abiEncodedClearValues, decrypted.decryptionProof)
  ).wait();
  const settled = await draw.drawInfo(drawId);
  log("  drawn", `walk height ${settled[4]}  total ${settled[3]}`);
  log("  resolved leaf", `${await draw.resolvedLeafHandle(drawId)}`);
  log("  gas", `${lotReceipt!.gasUsed}`);

  // ---- claim ------------------------------------------------------------
  const before = await readWallet();
  log("claimPrize", "");
  const claimReceipt = await (await draw.claimPrize(drawId)).wait();
  log("  gas", `${claimReceipt!.gasUsed}`);
  const after = await readWallet();
  const won = after - before;
  log("result", won > 0n ? `WON ${won}` : "did not win, paid an encrypted zero");

  const out = {
    network,
    pool: rec.pool,
    draw: rec.draw,
    drawId: Number(drawId),
    totalWeight: total.toString(),
    walkHeight: Number(settled[4]),
    openBlock: Number(info[1]),
    openGas: openReceipt!.gasUsed.toString(),
    drawGas: lotReceipt!.gasUsed.toString(),
    claimGas: claimReceipt!.gasUsed.toString(),
    resolvedLeafHandle: await draw.resolvedLeafHandle(drawId),
    won: won.toString(),
    steps,
    ranAt: new Date().toISOString(),
  };
  writeFileSync(join(__dirname, "..", "deployments", `${network}-live.json`), JSON.stringify(out, null, 2) + "\n");

  console.log("\nlive cycle and draw complete.");
}

main().catch((error) => {
  console.error("LIVE RUN FAILED:", error?.message ?? error);
  process.exitCode = 1;
});
