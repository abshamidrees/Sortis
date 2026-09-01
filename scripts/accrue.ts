import hre from "hardhat";
import { installResilientDns } from "./net";
installResilientDns();
import { readFileSync } from "fs";
import { join } from "path";
const { ethers } = hre;
/** Leave a prize standing for the next draw a judge opens. */
async function main() {
  const rec = JSON.parse(readFileSync(join(__dirname, "..", "deployments", "sepolia.json"), "utf8"));
  const [signer] = await ethers.getSigners();
  const y = await ethers.getContractAt("MockYieldAdapter", rec.yieldAdapter, signer);
  const amount = 10_000_000n;
  console.log("pending before:", (await y.pending()).toString());
  await (await y.accrue(amount, { maxFeePerGas: 1_400_000_000n, maxPriorityFeePerGas: 100_000_000n })).wait();
  console.log("pending after :", (await y.pending()).toString(), `(${Number(await y.pending())/1e6} cUSDT waiting for the next openDraw)`);
}
main().catch((e) => { console.error(e?.message ?? e); process.exitCode = 1; });
