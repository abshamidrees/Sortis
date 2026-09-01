import hre from "hardhat";

import { installResilientDns } from "./net";
installResilientDns();

import { readFileSync } from "fs";
import { join } from "path";
import { FhevmType } from "@fhevm/hardhat-plugin";

const { ethers, fhevm } = hre;

/**
 * Claim a settled draw, and measure what the claim reveals.
 *
 *     DRAW_ID=5 npx hardhat run scripts/claim.ts --network sepolia
 *
 * The point is not the money. It is that a losing claim and a winning claim are
 * supposed to be indistinguishable to anyone watching the chain, and the only
 * honest way to state that is to measure both sides: the observable cost, which
 * anyone can see, and the balance, which only the claimant can decrypt.
 *
 * So this records gas, sequential HCU depth and global HCU for the claim, and
 * decrypts the caller's cUSDT balance either side of it. Whether the balance
 * moved is the answer to "did I win", and it is available to nobody else.
 */

const MAX_FEE = 1_400_000_000n;
const MAX_PRIORITY = 100_000_000n;

function log(step: string, detail = "") {
  console.log(`[${new Date().toISOString().slice(11, 19)}] ${step}${detail ? "  " + detail : ""}`);
}

async function main() {
  const network = hre.network.name;
  const rec = JSON.parse(readFileSync(join(__dirname, "..", "deployments", `${network}.json`), "utf8"));
  const drawId = BigInt(process.env.DRAW_ID ?? "5");

  await fhevm.initializeCLIApi();

  const [signer] = await ethers.getSigners();
  const me = await signer.getAddress();
  const draw = await ethers.getContractAt("SortisDraw", rec.draw, signer);
  const pool = await ethers.getContractAt("SortisPool", rec.pool, signer);
  const token = await ethers.getContractAt("MockConfidentialUSDT", rec.cUSDT, signer);
  const overrides = { maxFeePerGas: MAX_FEE, maxPriorityFeePerGas: MAX_PRIORITY };

  const info = await draw.drawInfo(drawId);
  console.log(`account    ${me}`);
  console.log(`leaf       ${(await pool.hasLeaf(me)) ? await pool.leafOf(me) : "none"}`);
  console.log(`draw ${drawId}     settled ${info[5]}  prize ${Number(info[2]) / 1e6} cUSDT  height ${info[4]}`);
  if (!info[5]) throw new Error(`draw ${drawId} is not settled`);
  if (await draw.hasClaimed(drawId, me)) throw new Error(`already claimed draw ${drawId}`);

  /*
    The decryption is best effort. The claim is not.

    userDecryptEuint goes through the relayer, which has its own availability,
    and it has answered a well formed request with a 400 on requestValidity.
    That is a reason to report the balance as unknown, never a reason to skip
    sending the claim: the observable half of this measurement is the half that
    matters for the indistinguishability argument, and it needs no relayer.
  */
  const readBalance = async (): Promise<bigint | null> => {
    for (let i = 0; i < 3; i++) {
      try {
        const handle = await token.confidentialBalanceOf(me);
        if (handle === ethers.ZeroHash) return 0n;
        return (await fhevm.userDecryptEuint(
          FhevmType.euint64,
          handle,
          rec.cUSDT,
          signer,
        )) as bigint;
      } catch (error) {
        log("  relayer", `${(error as Error)?.message?.slice(0, 60)}`);
        await new Promise((r) => setTimeout(r, 4_000 * (i + 1)));
      }
    }
    return null;
  };

  log("balance", "before the claim");
  const before = await readBalance();
  console.log(`  ${before === null ? "unreadable, relayer refused" : Number(before) / 1e6 + " cUSDT"}`);

  log("claimPrize", `draw ${drawId}`);
  const receipt = await (await draw.claimPrize(drawId, overrides)).wait();

  let depth: number | null = null;
  let global: number | null = null;
  try {
    const hcu = fhevm.computeTransactionHCU(receipt!);
    depth = hcu.maxHCUDepth;
    global = hcu.globalHCU;
  } catch {
    /* not readable */
  }

  log("balance", "after the claim");
  const after = await readBalance();
  console.log(`  ${after === null ? "unreadable, relayer refused" : Number(after) / 1e6 + " cUSDT"}`);

  const moved = before === null || after === null ? null : after - before;
  console.log("");
  console.log("  THE CLAIM, AS AN OBSERVER SEES IT");
  console.log(`  gas               ${receipt!.gasUsed}`);
  if (depth !== null) {
    console.log(`  sequential depth  ${depth.toLocaleString("en-US")}`);
    console.log(`  global HCU        ${global!.toLocaleString("en-US")}`);
  }
  console.log(`  transfer          one confidentialTransfer of one euint64`);
  console.log("");
  console.log("  THE CLAIM, AS ONLY THIS ACCOUNT SEES IT");
  console.log(
    `  balance moved     ${moved === null ? "unknown, the relayer would not decrypt" : Number(moved) / 1e6 + " cUSDT"}`,
  );
  console.log(
    `  verdict           ${
      moved === null
        ? "undetermined from here. The chain shows nothing either way, which is the point."
        : moved > 0n
          ? "WON. The walk resolved to this leaf."
          : "did not win. An encrypted zero was transferred."
    }`,
  );
  console.log("");
  console.log("  Everything in the first block is public and identical either way.");
  console.log("  Everything in the second needs this account's key.");
}

main().catch((error) => {
  console.error("CLAIM FAILED:", error?.message ?? error);
  process.exitCode = 1;
});
