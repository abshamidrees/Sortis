import hre from "hardhat";

import { installResilientDns } from "./net";
installResilientDns();

import { readFileSync } from "fs";
import { join } from "path";
import { FhevmType } from "@fhevm/hardhat-plugin";

const { ethers, fhevm } = hre;

/**
 * Did this account's claim pay anything?
 *
 *     npx hardhat run scripts/whowon.ts --network sepolia
 *
 * READ ONLY. Sends nothing and changes nothing.
 *
 * claimPrize computes `payout = select(won, prize, 0)` and calls
 * `FHE.allow(payout, msg.sender)`, so the claimant, and only the claimant, can
 * decrypt what they were paid. That grant is the whole confidentiality story
 * for the prize, and it is also the only way to find out from outside the
 * contract whether a given claim was the winning one.
 *
 * This matters for a claim the project makes publicly: that a losing claim and
 * a winning claim are indistinguishable to an observer. Gas and HCU are
 * observable and can be compared by anyone. The payout is not, which is the
 * point, so establishing which claim won requires the claimant's own key.
 */

async function main() {
  const network = hre.network.name;
  const rec = JSON.parse(readFileSync(join(__dirname, "..", "deployments", `${network}.json`), "utf8"));

  await fhevm.initializeCLIApi();

  const [signer] = await ethers.getSigners();
  const me = await signer.getAddress();
  const draw = await ethers.getContractAt("SortisDraw", rec.draw, signer);
  const pool = await ethers.getContractAt("SortisPool", rec.pool, signer);
  const token = await ethers.getContractAt("MockConfidentialUSDT", rec.cUSDT, signer);

  console.log(`account      ${me}`);
  console.log(`has leaf     ${await pool.hasLeaf(me)}`);
  if (await pool.hasLeaf(me)) console.log(`leaf index   ${await pool.leafOf(me)}`);

  const count = await draw.drawCount();
  for (let id = 1n; id <= count; id++) {
    const info = await draw.drawInfo(id);
    const claimed = await draw.hasClaimed(id, me);
    console.log(
      `\ndraw ${id}  settled ${info[5]}  prize ${info[2]}  walkHeight ${info[4]}  claimedByMe ${claimed}`,
    );
  }

  // The live balance, which is where any prize ended up.
  const handle = await token.confidentialBalanceOf(me);
  console.log(`\ncUSDT balance handle  ${handle}`);
  if (handle === ethers.ZeroHash) {
    console.log("no balance handle, this account has never held cUSDT");
    return;
  }

  const clear = await fhevm.userDecryptEuint(FhevmType.euint64, handle, rec.cUSDT, signer);
  console.log(`cUSDT balance         ${clear} (${Number(clear) / 1e6} cUSDT)`);
}

main().catch((error) => {
  console.error("FAILED:", error?.message ?? error);
  process.exitCode = 1;
});
