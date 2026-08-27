import hre from "hardhat";
import { writeFileSync, mkdirSync, existsSync } from "fs";
import { join } from "path";

const { ethers } = hre;

/**
 * Deploys the mock confidential USDT and the pool, then records the addresses
 * in deployments/<network>.json so scripts/cycle.ts can find them.
 *
 * Production register height. 2^16 = 65,536 stakes.
 */
const DEPTH = 16;

async function main() {
  const network = hre.network.name;
  const [deployer] = await ethers.getSigners();
  const balance = await ethers.provider.getBalance(deployer.address);

  console.log(`network   ${network}`);
  console.log(`deployer  ${deployer.address}`);
  console.log(`balance   ${ethers.formatEther(balance)} ETH`);

  // Two FHEVM contracts plus coprocessor registration. 0.02 ETH is comfortable
  // on Sepolia; below that the deploy tends to die partway and leave a
  // half-written deployments file.
  const MINIMUM = ethers.parseEther("0.02");
  if (network !== "hardhat" && network !== "localhost" && balance < MINIMUM) {
    throw new Error(
      `${deployer.address} holds ${ethers.formatEther(balance)} ETH on ${network}, ` +
        `which is below the ${ethers.formatEther(MINIMUM)} ETH this deploy needs.\n` +
        `Set MNEMONIC or PRIVATE_KEY in .env to a funded account, or fund this one from a Sepolia faucet.`,
    );
  }

  console.log("\ndeploying MockConfidentialUSDT...");
  const usdtFactory = await ethers.getContractFactory("MockConfidentialUSDT");
  const usdt = await usdtFactory.deploy();
  await usdt.waitForDeployment();
  const usdtAddress = await usdt.getAddress();
  console.log(`  cUSDT     ${usdtAddress}`);

  console.log(`deploying SortisPool at depth ${DEPTH} (2^${DEPTH} stakes)...`);
  const poolFactory = await ethers.getContractFactory("SortisPool");
  const pool = await poolFactory.deploy(usdtAddress, DEPTH);
  await pool.waitForDeployment();
  const poolAddress = await pool.getAddress();
  console.log(`  pool      ${poolAddress}`);

  const record = {
    network,
    chainId: Number((await ethers.provider.getNetwork()).chainId),
    deployer: deployer.address,
    depth: DEPTH,
    cUSDT: usdtAddress,
    pool: poolAddress,
    deployedAt: new Date().toISOString(),
  };

  const dir = join(__dirname, "..", "deployments");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const path = join(dir, `${network}.json`);
  writeFileSync(path, JSON.stringify(record, null, 2) + "\n");

  console.log(`\nwrote deployments/${network}.json`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
