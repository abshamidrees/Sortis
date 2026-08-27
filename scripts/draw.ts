import hre from "hardhat";
import { readFileSync } from "fs";
import { join } from "path";

import { FhevmType } from "@fhevm/hardhat-plugin";

const { ethers, fhevm } = hre;

/**
 * A full prize round against a live network: open, wait a block, draw, claim.
 *
 *     npx hardhat run scripts/draw.ts --network sepolia
 *
 * Requires scripts/deploy.ts to have run, and at least one stake in the pool
 * with some accrued weight -- run scripts/cycle.ts first.
 */

const PRIZE = Number(process.env.DRAW_PRIZE ?? 50_000);

function log(step: string, detail = "") {
  const stamp = new Date().toISOString().slice(11, 19);
  console.log(`[${stamp}] ${step}${detail ? "  " + detail : ""}`);
}

async function main() {
  const network = hre.network.name;
  const path = join(__dirname, "..", "deployments", `${network}.json`);

  let record: { cUSDT: string; pool: string; draw: string; yieldAdapter: string };
  try {
    record = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    throw new Error(`no deployments/${network}.json -- run scripts/deploy.ts --network ${network} first`);
  }

  // The relayer/KMS client is lazily constructed and is NOT initialized for
  // `hardhat run` on a live network -- only the test runner does it for you.
  // Without this, the first fhevm.* call fails with
  // "The Hardhat Fhevm plugin is not initialized."
  await fhevm.initializeCLIApi();

  const [signer] = await ethers.getSigners();
  const pool = await ethers.getContractAt("SortisPool", record.pool, signer);
  const draw = await ethers.getContractAt("SortisDraw", record.draw, signer);
  const yieldAdapter = await ethers.getContractAt("MockYieldAdapter", record.yieldAdapter, signer);
  const cusdt = await ethers.getContractAt("MockConfidentialUSDT", record.cUSDT, signer);

  console.log(`network ${network}   draw ${record.draw}`);
  console.log(`account ${signer.address}`);
  console.log(`register depth ${await pool.DEPTH()}, active height ${await pool.activeHeight()}\n`);

  // --- fund the pot -----------------------------------------------------
  log("accrue", `${PRIZE} base units of yield`);
  await (await yieldAdapter.accrue(PRIZE)).wait();

  // --- transaction 1: commit the root before any randomness exists ------
  log("openDraw");
  const openReceipt = await (await draw.openDraw()).wait();
  const drawId = await draw.drawCount();
  const [rootHandle, openedAtBlock, prize] = await draw.drawInfo(drawId);
  log("  opened", `draw ${drawId} at block ${openedAtBlock}, prize ${prize}`);
  log("  root", rootHandle);
  log("  gas", `${openReceipt!.gasUsed}`);

  // --- the KMS proof, fetched off chain between the two transactions ----
  log("publicDecrypt", "fetching the KMS proof for the committed root");
  const decrypted = await fhevm.publicDecrypt([rootHandle]);
  const total = ethers.AbiCoder.defaultAbiCoder().decode(["uint256"], decrypted.abiEncodedClearValues)[0];
  log("  total weight", `${total}`);

  // --- transaction 2: draw the lot --------------------------------------
  // Must be a later block than the open. Wait for one.
  const startBlock = await ethers.provider.getBlockNumber();
  log("wait", "for a block after the open");
  while ((await ethers.provider.getBlockNumber()) <= Number(openedAtBlock)) {
    await new Promise((resolve) => setTimeout(resolve, 3_000));
  }
  log("  block", `${await ethers.provider.getBlockNumber()} (opened at ${openedAtBlock}, started ${startBlock})`);

  log("drawLot");
  const lotReceipt = await (
    await draw.drawLot(drawId, decrypted.abiEncodedClearValues, decrypted.decryptionProof)
  ).wait();
  const [, , , settledTotal, walkHeight] = await draw.drawInfo(drawId);
  log("  drawn", `walk height ${walkHeight}, total weight ${settledTotal}`);
  log("  resolved leaf handle", await draw.resolvedLeafHandle(drawId));
  log("  gas", `${lotReceipt!.gasUsed}`);

  // --- claim ------------------------------------------------------------
  const before = await fhevm.userDecryptEuint(
    FhevmType.euint64,
    await cusdt.confidentialBalanceOf(signer.address),
    record.cUSDT,
    signer,
  );

  log("claimPrize");
  const claimReceipt = await (await draw.claimPrize(drawId)).wait();
  log("  gas", `${claimReceipt!.gasUsed}`);

  const after = await fhevm.userDecryptEuint(
    FhevmType.euint64,
    await cusdt.confidentialBalanceOf(signer.address),
    record.cUSDT,
    signer,
  );

  console.log("");
  const won = after - before;
  if (won > 0n) {
    console.log(`this account WON: paid ${won} base units of cUSDT.`);
  } else {
    console.log("this account did not win. The claim succeeded and paid an encrypted zero,");
    console.log("which is indistinguishable on chain from the winning claim above.");
  }
  console.log("draw complete.");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
