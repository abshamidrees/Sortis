import hre from "hardhat";
import { writeFileSync, mkdirSync, existsSync } from "fs";
import { join } from "path";

const { ethers } = hre;

/**
 * Deploys one shard: the confidential asset, the pool, the draw, the wrap
 * queue and the yield adapter, then records the addresses in
 * deployments/<network>.json so the cycle and draw scripts can find them.
 *
 * SHARD SIZE. A register of height 6 holds 64 stakes, which is the largest a
 * single-transaction winner-hiding draw can resolve. test/HCU.t.ts measures
 * that ceiling by sweeping until the walk reverts, and it is set by the
 * 5,000,000 sequential depth budget rather than by the global one, so it
 * cannot be raised by splitting the draw across transactions.
 *
 * The capacity is the enforcement. Deploying at height 6 means the 65th
 * depositor is rejected by `RegisterFull` rather than silently pushing the
 * draw past what it can settle. Scale is more shards, not a bigger tree.
 */
const DEPTH = 6;

/** Epoch length for the wrap queue. 4 hours on Sepolia so a demo can show one
 *  turn over; mainnet would run longer, which only helps the anonymity set. */
const EPOCH_SECONDS = 4 * 60 * 60;

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

  console.log("deploying MockUSDT (public side of the wrap queue)...");
  const usdtPublicFactory = await ethers.getContractFactory("MockUSDT");
  const usdtPublic = await usdtPublicFactory.deploy();
  await usdtPublic.waitForDeployment();
  const usdtPublicAddress = await usdtPublic.getAddress();
  console.log(`  USDT      ${usdtPublicAddress}`);

  console.log("deploying MockYieldAdapter...");
  const yieldFactory = await ethers.getContractFactory("MockYieldAdapter");
  const yieldAdapter = await yieldFactory.deploy(usdtAddress);
  await yieldAdapter.waitForDeployment();
  const yieldAddress = await yieldAdapter.getAddress();
  console.log(`  yield     ${yieldAddress}`);

  console.log("deploying SortisDraw...");
  const drawFactory = await ethers.getContractFactory("SortisDraw");
  const draw = await drawFactory.deploy(poolAddress, yieldAddress);
  await draw.waitForDeployment();
  const drawAddress = await draw.getAddress();
  console.log(`  draw      ${drawAddress}`);

  console.log(`deploying SortisWrapQueue (${EPOCH_SECONDS}s epochs)...`);
  const queueFactory = await ethers.getContractFactory("SortisWrapQueue");
  const queue = await queueFactory.deploy(usdtPublicAddress, usdtAddress, poolAddress, EPOCH_SECONDS);
  await queue.waitForDeployment();
  const queueAddress = await queue.getAddress();
  console.log(`  queue     ${queueAddress}`);

  console.log("\nwiring the pool to its privileged peers...");
  await (await pool.setDrawContract(drawAddress)).wait();
  await (await pool.setWrapQueue(queueAddress)).wait();
  console.log("  done");

  const record = {
    network,
    chainId: Number((await ethers.provider.getNetwork()).chainId),
    deployer: deployer.address,
    depth: DEPTH,
    cUSDT: usdtAddress,
    USDT: usdtPublicAddress,
    pool: poolAddress,
    draw: drawAddress,
    wrapQueue: queueAddress,
    yieldAdapter: yieldAddress,
    epochSeconds: EPOCH_SECONDS,
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
