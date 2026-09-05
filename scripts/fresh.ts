import hre from "hardhat";
import { installResilientDns } from "./net";
installResilientDns();
import { readFileSync } from "fs";
import { join } from "path";
const { ethers } = hre;

/**
 * Accrue a prize and open a draw whose register roots are current.
 *
 *     npx hardhat run scripts/fresh.ts --network sepolia
 *
 * Leaves it OPEN on purpose, so the Settle control has something real to do.
 * Nothing must commit or release between this and the settle, or drawLot
 * reverts with RegisterMovedSinceOpen and the draw is stranded like 6 and 7.
 */
async function main() {
  const rec = JSON.parse(readFileSync(join(__dirname, "..", "deployments", "sepolia.json"), "utf8"));
  const [signer] = await ethers.getSigners();
  const draw = await ethers.getContractAt("SortisDraw", rec.draw, signer);
  const pool = await ethers.getContractAt("SortisPool", rec.pool, signer);
  const y = await ethers.getContractAt("MockYieldAdapter", rec.yieldAdapter, signer);
  const o = { maxFeePerGas: 1_400_000_000n, maxPriorityFeePerGas: 100_000_000n };

  const pending = await y.pending();
  if (pending < 25_000_000n) {
    const top = 25_000_000n - pending;
    console.log(`accruing ${Number(top) / 1e6} cUSDT (pending was ${Number(pending) / 1e6})`);
    await (await y.accrue(top, o)).wait();
  }
  console.log("adapter pending:", Number(await y.pending()) / 1e6, "cUSDT");

  const wait = Number(await draw.secondsUntilNextDraw());
  if (wait > 0) {
    console.log(`waiting ${wait}s for the draw interval`);
    await new Promise((r) => setTimeout(r, (wait + 5) * 1000));
  }

  await (await draw.openDraw(o)).wait();
  const id = await draw.drawCount();
  const info = await draw.drawInfo(id);
  const [ih, sh] = await draw.committedHandles(id);
  const [ci, cs] = [await pool.rootIntercept(), await pool.rootSlope()];

  console.log("");
  console.log(`  DRAW ${id} IS OPEN AND READY TO SETTLE`);
  console.log(`  prize        ${Number(info[2]) / 1e6} cUSDT`);
  console.log(`  opened block ${info[1]}`);
  console.log(`  refHour      ${info[6]}`);
  console.log(`  roots match  ${ih === ci && sh === cs}`);
  console.log("");
  console.log("  Do not commit or release before settling this, or it strands.");
}
main().catch((e) => { console.error("FAILED:", (e as Error)?.message ?? e); process.exitCode = 1; });
