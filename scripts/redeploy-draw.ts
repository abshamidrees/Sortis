import hre from "hardhat";

import { installResilientDns } from "./net";
installResilientDns();

import { readFileSync, writeFileSync } from "fs";
import { join } from "path";

const { ethers } = hre;

/**
 * Replace only the draw contract, keeping the register intact.
 *
 *     npx hardhat run scripts/redeploy-draw.ts --network sepolia
 *
 * SortisDraw gained a permissionless rate limit, which is a code change and so
 * needs a new deployment. Redeploying the pool alongside it would throw away 24
 * seeded stakes that took hours to place over a link that drops connections,
 * and there is no reason to: the pool is untouched, and the two contracts are
 * joined by `setDrawContract` rather than by construction.
 *
 * What is lost is the draw history, which on this shard is draw 1: opened while
 * a single leaf carried weight, settled with walk height 0, and demonstrating
 * nothing about the descent. It is not worth keeping.
 */

/**
 * Ten minutes between draws on Sepolia.
 *
 * Short enough that a judge can trigger one rather than read about it, long
 * enough that the history is not a wall of empty rounds. Weight moves in whole
 * hours, so a shorter interval would not change any outcome, only the count.
 */
const MIN_DRAW_INTERVAL = 10 * 60;

const MAX_FEE = 1_400_000_000n;
const MAX_PRIORITY = 100_000_000n;

async function main() {
  const network = hre.network.name;
  const path = join(__dirname, "..", "deployments", `${network}.json`);
  const rec = JSON.parse(readFileSync(path, "utf8"));

  const [deployer] = await ethers.getSigners();
  const overrides = { maxFeePerGas: MAX_FEE, maxPriorityFeePerGas: MAX_PRIORITY };

  console.log(`network  ${network}`);
  console.log(`deployer ${deployer.address}`);
  console.log(`balance  ${ethers.formatEther(await ethers.provider.getBalance(deployer.address))} ETH`);
  console.log(`pool     ${rec.pool}  (kept)`);
  console.log(`old draw ${rec.draw}\n`);

  const pool = await ethers.getContractAt("SortisPool", rec.pool, deployer);
  const before = await pool.leafCount();

  const factory = await ethers.getContractFactory("SortisDraw", deployer);
  const draw = await factory.deploy(rec.pool, rec.yieldAdapter, MIN_DRAW_INTERVAL, overrides);
  await draw.waitForDeployment();
  const drawAddress = await draw.getAddress();
  console.log(`new draw ${drawAddress}`);

  // The pool only lets its configured draw contract walk the register, so the
  // new one is useless until this lands.
  await (await pool.setDrawContract(drawAddress, overrides)).wait();
  console.log(`pool.setDrawContract -> ${await pool.drawContract()}`);

  const after = await pool.leafCount();
  console.log(`leaves ${before} before, ${after} after. Register untouched.`);
  console.log(`minDrawInterval ${await draw.minDrawInterval()}s`);
  console.log(`secondsUntilNextDraw ${await draw.secondsUntilNextDraw()}  (0 means openable now)`);

  rec.draw = drawAddress;
  rec.minDrawInterval = MIN_DRAW_INTERVAL;
  rec.drawRedeployedAt = new Date().toISOString();
  writeFileSync(path, JSON.stringify(rec, null, 2) + "\n");
  console.log(`\nwrote deployments/${network}.json`);
  console.log(`\nSet NEXT_PUBLIC_DRAW_ADDRESS to ${drawAddress}`);
}

main().catch((error) => {
  console.error("REDEPLOY FAILED:", error?.message ?? error);
  process.exitCode = 1;
});
