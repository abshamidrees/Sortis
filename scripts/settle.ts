import hre from "hardhat";

import { installResilientDns } from "./net";
installResilientDns();

import { readFileSync, writeFileSync } from "fs";
import { join } from "path";

const { ethers, fhevm } = hre;

/**
 * Settle a draw that is already open.
 *
 *     npx hardhat run scripts/settle.ts --network sepolia
 *
 * scripts/draw.ts opens a draw and settles it in one process. That is the wrong
 * shape when a draw was opened from the app and left open, which is what the
 * permissionless TRIGGER A DRAW control makes easy to do. This settles the
 * newest draw that has not been settled and touches nothing else.
 *
 * The two transactions are deliberately separate in the protocol, so a script
 * that can only ever do both is a script that cannot finish what the UI starts.
 */

const MOCK_DEPTH = 4_476_000;
const DEPTH_LIMIT = 5_000_000;

const MAX_FEE = 1_400_000_000n;
const MAX_PRIORITY = 100_000_000n;

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
      if (i === attempts) throw error;
      log(`  retry ${i}`, `${label}: ${(error as Error)?.message?.slice(0, 70)}`);
      await new Promise((r) => setTimeout(r, 5_000 * i));
    }
  }
  throw last;
}

async function main() {
  const network = hre.network.name;
  const rec = JSON.parse(readFileSync(join(__dirname, "..", "deployments", `${network}.json`), "utf8"));

  log("init", "relayer key material");
  await resilient("init", () => fhevm.initializeCLIApi(), 6);

  const [signer] = await ethers.getSigners();
  const provider = ethers.provider;
  const draw = await ethers.getContractAt("SortisDraw", rec.draw, signer);
  const overrides = { maxFeePerGas: MAX_FEE, maxPriorityFeePerGas: MAX_PRIORITY };

  const count = await draw.drawCount();
  let target = 0n;
  for (let i = count; i > 0n; i--) {
    const info = await draw.drawInfo(i);
    if (!info[5]) {
      target = i;
      break;
    }
  }
  if (target === 0n) throw new Error("every draw is already settled");

  const info = await draw.drawInfo(target);
  log("target", `draw ${target}, opened at block ${info[1]}, prize ${info[2]}, refHour ${info[6]}`);

  /*
    A zero prize does not block settlement, and it is worth naming rather than
    discovering later. The prize is captured at openDraw from whatever the
    yield adapter had accrued, so a draw opened from the app with nothing
    accrued settles honestly and pays an encrypted zero to everyone, winner
    included.
  */
  if (info[2] === 0n) {
    log("  note", "prize is zero. The walk still runs and the winner still resolves.");
  }

  log("publicDecrypt", "the published total weight, verified against the KMS");
  const decrypted = await resilient("publicDecrypt", () => fhevm.publicDecrypt([info[0]]));
  const total = ethers.AbiCoder.defaultAbiCoder().decode(
    ["uint256"],
    decrypted.abiEncodedClearValues,
  )[0] as bigint;
  log("  total weight", total.toLocaleString("en-US"));
  if (total === 0n) throw new Error("total weight is zero, the register carries nothing");

  while ((await provider.getBlockNumber()) <= Number(info[1])) {
    await new Promise((r) => setTimeout(r, 4_000));
  }

  log("drawLot", "descending");
  const receipt = await resilient("drawLot", async () =>
    (
      await draw.drawLot(target, decrypted.abiEncodedClearValues, decrypted.decryptionProof, overrides)
    ).wait(),
  );

  const settled = await draw.drawInfo(target);
  log("  drawn", `walk height ${settled[4]}  gas ${receipt!.gasUsed}`);

  let depth: number | null = null;
  let global: number | null = null;
  try {
    const hcu = fhevm.computeTransactionHCU(receipt!);
    depth = hcu.maxHCUDepth;
    global = hcu.globalHCU;
  } catch {
    log("  HCU", "not readable from this receipt");
  }

  console.log("");
  console.log(`  DRAW ${target} SETTLED ON SEPOLIA`);
  console.log(`  walk height       ${settled[4]}`);
  console.log(`  total weight      ${total.toLocaleString("en-US")}`);
  console.log(`  prize             ${settled[2]}`);
  console.log(`  drawLot gas       ${receipt!.gasUsed}`);

  let diverged = false;
  if (depth !== null) {
    const pct = ((depth / DEPTH_LIMIT) * 100).toFixed(2);
    const delta = ((depth - MOCK_DEPTH) / MOCK_DEPTH) * 100;
    console.log(`  sequential depth  ${depth.toLocaleString("en-US")}  ${pct}% of 5,000,000`);
    console.log(`  global HCU        ${global!.toLocaleString("en-US")}  of 20,000,000`);
    console.log(`  mock said         ${MOCK_DEPTH.toLocaleString("en-US")}`);
    console.log(`  difference        ${delta.toFixed(2)}%`);
    diverged = Math.abs(delta) >= 1;
    console.log(diverged ? "\n  *** DIVERGENCE. Stop." : "\n  the mock and the chain agree.");
  }

  writeFileSync(
    join(__dirname, "..", "deployments", `${network}-draw${target}.json`),
    JSON.stringify(
      {
        drawId: Number(target),
        walkHeight: Number(settled[4]),
        totalWeight: total.toString(),
        prize: settled[2].toString(),
        drawLotGas: receipt!.gasUsed.toString(),
        sequentialDepth: depth,
        globalHCU: global,
        mockDepth: MOCK_DEPTH,
        diverged,
        settledAt: new Date().toISOString(),
      },
      null,
      2,
    ) + "\n",
  );
  console.log("\nsettled.");
}

main().catch((error) => {
  console.error("SETTLE FAILED:", error?.message ?? error);
  process.exitCode = 1;
});
