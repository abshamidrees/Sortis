import hre from "hardhat";
import { installResilientDns } from "./net";
installResilientDns();
const { ethers, fhevm } = hre;

/**
 * Deploy a throwaway contract, publish one euint64, try to decrypt it.
 *
 *     npx hardhat run scripts/probe.ts --network sepolia
 *
 * Nothing to do with draws, the register, or publishRootForDraw. If a freshly
 * published constant will not decrypt, the relayer's public decrypt is down and
 * no contract change can help. If it does decrypt, the grant in
 * publishRootForDraw is the variable and that is ours to fix.
 */
async function main() {
  await fhevm.initializeCLIApi();
  const [signer] = await ethers.getSigners();
  const overrides = { maxFeePerGas: 1_400_000_000n, maxPriorityFeePerGas: 100_000_000n };

  const factory = await ethers.getContractFactory("PublicDecryptProbe", signer);
  const probe = await factory.deploy(overrides);
  await probe.waitForDeployment();
  console.log("probe deployed at", await probe.getAddress());

  const tx = await probe.publish(424242n, overrides);
  await tx.wait();
  const handle = await probe.handle();
  console.log("published handle", handle, "for plaintext 424242");

  for (const at of [10, 30, 60, 120]) {
    await new Promise((r) => setTimeout(r, at === 10 ? 10_000 : 20_000));
    try {
      const t = Date.now();
      const d = await fhevm.publicDecrypt([handle]);
      const v = ethers.AbiCoder.defaultAbiCoder().decode(["uint256"], d.abiEncodedClearValues)[0];
      console.log(`  t+~${at}s  OK ${Date.now() - t}ms  decrypted ${v}`);
      console.log("\nVERDICT: public decrypt works. The relayer is fine.");
      return;
    } catch (e) {
      console.log(`  t+~${at}s  FAIL ${String((e as Error).message).split("\n")[0].slice(0, 60)}`);
    }
  }
  console.log("\nVERDICT: a freshly published constant will not decrypt either.");
  console.log("The relayer's public decrypt is down. Not the contract, not publishRootForDraw.");
}

main().catch((e) => { console.error("PROBE FAILED:", (e as Error)?.message ?? e); process.exitCode = 1; });
