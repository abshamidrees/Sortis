import hre from "hardhat";
import { installResilientDns } from "./net";
installResilientDns();
import { readFileSync } from "fs";
import { join } from "path";
const { ethers } = hre;
/** Open a draw and stop, so the browser's Settle control has a target. */
async function main() {
  const rec = JSON.parse(readFileSync(join(__dirname, "..", "deployments", "sepolia.json"), "utf8"));
  const [signer] = await ethers.getSigners();
  const draw = await ethers.getContractAt("SortisDraw", rec.draw, signer);
  const wait = Number(await draw.secondsUntilNextDraw());
  if (wait > 0) { console.log(`waiting ${wait}s for the interval`); await new Promise(r => setTimeout(r, (wait + 5) * 1000)); }
  await (await draw.openDraw({ maxFeePerGas: 1_400_000_000n, maxPriorityFeePerGas: 100_000_000n })).wait();
  const id = await draw.drawCount();
  const info = await draw.drawInfo(id);
  console.log(`opened draw ${id}  prize ${Number(info[2]) / 1e6} cUSDT  block ${info[1]}  settled ${info[5]}`);
}
main().catch((e) => { console.error(e?.message ?? e); process.exitCode = 1; });
