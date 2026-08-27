import { HCU, LINEAR_SCAN_WALL, MEASUREMENT_COMMIT } from "./measurements";

/**
 * The documentation, as data.
 *
 * Four pages rendered on one route rather than four routes, because the whole
 * of it is shorter than most single pages and splitting it would mean three
 * extra navigations to read six screens of text. Fumadocs was the plan; it
 * would have added a dependency and a build step to serve four documents.
 */

export type Block =
  | { type: "p"; text: string }
  | { type: "h"; text: string }
  | { type: "code"; text: string }
  | { type: "ul"; items: string[] };

export type Doc = {
  slug: string;
  title: string;
  blurb: string;
  body: Block[];
};

const ceiling = HCU.DRAW.filter((r) => r.fits).at(-1)!;
const firstFail = HCU.DRAW.find((r) => !r.fits)!;

export const DOCS: Doc[] = [
  {
    slug: "overview",
    title: "Overview",
    blurb: "What Sortis is and what a draw does",
    body: [
      {
        type: "p",
        text: "Sortis is confidential prize-linked savings. You commit funds, you cannot lose your principal, the pooled yield is awarded as a prize on a schedule, and the size of your position is not visible to anyone but you.",
      },
      {
        type: "p",
        text: "The draw stays publicly verifiable. Anyone can check that the lot was drawn against the register root committed one block earlier, that the denominator was signed by the KMS, and that the walk ran. What they cannot see is who it landed on.",
      },
      { type: "h", text: "The cycle" },
      {
        type: "ul",
        items: [
          "Commit. Your amount is encrypted in your browser, sent as a ciphertext handle with an input proof, and pulled by the pool with confidentialTransferFrom.",
          "Wait. Weight accrues from how much sat in the pool and for how long, so a deposit made moments before a draw carries nothing.",
          "Draw. openDraw commits the root and the block. In a later block drawLot produces the lot with FHE.randEuint64 and descends the register.",
          "Claim. Each depositor claims the same way; an encrypted comparison pays the drawn leaf and pays everyone else zero.",
          "Release. Principal is withdrawable at any time. An over-withdrawal is an encrypted no-op, never a revert.",
        ],
      },
      { type: "h", text: "The yield source" },
      {
        type: "p",
        text: "On Sepolia the prize comes from a mock adapter with an admin-callable accrue, which mints cUSDT into the draw contract. It is a mock and the README says so. On mainnet the same ISortisYieldAdapter interface sits in front of an ERC-4626 vault; harvest(to) is the only method the draw depends on. Chasing a live yield source on a testnet would cost days and prove nothing about the part of this that is hard.",
      },
    ],
  },
  {
    slug: "architecture",
    title: "Architecture",
    blurb: "The register, the walk, and why a shard holds 32",
    body: [
      {
        type: "p",
        text: `FHEVM caps the longest chain of dependent operations in one transaction at ${HCU.DEPTH_LIMIT.toLocaleString("en-US")} HCU. Encrypting balances and scanning them puts every depositor in that one chain, which is why a linear draw stops working at ${LINEAR_SCAN_WALL} depositors. Sortis keeps time-weighted stake in a segment tree and descends it, so the chain grows with the height of the tree rather than with the number of people in it.`,
      },
      { type: "h", text: "The update path is parallel, not deep" },
      {
        type: "p",
        text: `A commit folds the direction into the delta once and then adds that single ciphertext to every node on the path. Each node depends only on its own previous value, so the writes are independent and bill against the global budget rather than the depth budget. Sequential depth is ${HCU.COMMIT_DEPTH.toLocaleString("en-US")} HCU and is flat in shard size.`,
      },
      { type: "h", text: "The walk keeps the branch encrypted" },
      {
        type: "p",
        text: "At each level the walk compares the remaining lot against the left subtree's weight, selects whether to subtract, and folds the branch bit into an encrypted index. Solidity never branches on a ciphertext. Because the index stays encrypted, the contract cannot address the next node in plaintext either, so each level resolves its child obliviously over the candidates at that level.",
      },
      { type: "h", text: "A shard holds 32, and the number is measured" },
      {
        type: "code",
        text: HCU.DRAW.map(
          (r) =>
            `${String(r.stakes).padStart(4)} stakes   ${
              r.fits
                ? `${r.depth.toLocaleString("en-US").padStart(9)} HCU   ${((r.depth / HCU.DEPTH_LIMIT) * 100).toFixed(2)}%   fits`
                : `${"reverts".padStart(9)}         depth budget`
            }`,
        ).join("\n"),
      },
      {
        type: "p",
        text: `The ceiling is set by what a draw costs, not by what a walk costs. drawLot reduces the lot modulo the published total before descending, and FHE.rem is a 1,153,000 chain the whole walk then hangs off. A shard was briefly deployed at height 6 on the strength of the walk figure alone and could not have settled its own draw. It deploys at height 5: ${ceiling.stakes} stakes at ${((ceiling.depth / HCU.DEPTH_LIMIT) * 100).toFixed(2)}% of budget, and ${firstFail.stakes} reverts.`,
      },
      {
        type: "p",
        text: `Scale is more shards, not a bigger tree. Depth is the binding budget and it cannot be checkpointed across transactions the way global work can. Every figure above is measured by test/HCU.t.ts and test/Calibration.t.ts at commit ${MEASUREMENT_COMMIT}, and a real draw on Sepolia reported the same depth the mock did, to the unit.`,
      },
    ],
  },
  {
    slug: "privacy-model",
    title: "Privacy model",
    blurb: "What stays encrypted and what leaks",
    body: [
      { type: "h", text: "Encrypted" },
      {
        type: "ul",
        items: [
          "Your deposit amount. Encrypted in your browser before it is sent.",
          "Your balance and your weight. euint64 handles, decryptable by you alone through EIP-712 user decryption.",
          "Whether you won. The resolved leaf is an encrypted euint16 and no ACL grant is ever issued for it.",
          "What you were paid. A losing claim transfers an encrypted zero, and costs the same gas and the same HCU as a winning one.",
        ],
      },
      { type: "h", text: "Public, and deliberately so" },
      {
        type: "ul",
        items: [
          "The pot. The prize size is not a secret, and encrypting it would remove the public verifiability the design exists to provide.",
          "The register root, the block it was committed at, and the total weight the lot was reduced against.",
          "That an address interacted with the pool, when, and in which direction. commit pulls and release pushes, and those are different external calls.",
          "Which leaf index moved. _update writes a visible path of storage slots, so leaf ownership is on chain whatever the frontend does.",
        ],
      },
      { type: "h", text: "The wrap leak" },
      {
        type: "p",
        text: "Money arrives as public USDT. Wrapping it in the same transaction as the deposit would make the amount readable one call before it became private, so deposits queue and settle in epoch batches instead. Batching raises the cost of linkage; it does not eliminate it. A depositor alone in an epoch has no anonymity set, amounts are not mixed so sizes can be matched back, and each settlement emits an event naming the stake owner.",
      },
      { type: "h", text: "What verification cannot do" },
      {
        type: "p",
        text: "The descent cannot be replayed client-side. Every node in the register is a ciphertext nobody holds a grant on, and publishing per-node decryptions so a verifier could re-run the comparisons would hand everyone the register. The Verify screen checks the public chain of facts and names this limit rather than papering over it.",
      },
    ],
  },
  {
    slug: "limitations",
    title: "Limitations",
    blurb: "What is not done, and what would come next",
    body: [
      {
        type: "p",
        text: "Sortis has not been audited. It is deployed on Sepolia only, against a mock yield source, and nothing here should be treated as production infrastructure.",
      },
      { type: "h", text: "Known limits" },
      {
        type: "ul",
        items: [
          `A shard holds ${ceiling.stakes} stakes. The 33rd depositor is rejected by RegisterFull rather than silently pushing the draw past what it can settle.`,
          "Multi-shard routing is not built. The contracts support many shards; the deployment scripts and the frontend address one.",
          "Weight is evaluated at whole hours. A stake held for less than an hour carries no weight, which is what prevents a late deposit from sniping a draw and also means very short holds earn nothing.",
          "The epoch wrap queue is deployed but the frontend commits directly, which is the more legible path for a judge and the less private one. The queue is the private path and the docs say which is which.",
          "The prize is awarded to one leaf per draw. Multiple winners per draw would need either several walks or a different selection rule.",
        ],
      },
      { type: "h", text: "The change that would raise the ceiling" },
      {
        type: "p",
        text: "Materialising the weights once at openDraw, instead of evaluating intercept and slope at every level of the walk, moves that cost off the critical path. Each node's evaluation is independent of every other node's, so a snapshot pass bills against the 20,000,000 global budget rather than the 5,000,000 depth budget.",
      },
      {
        type: "p",
        text: "It would not make a shard much larger, because global cost roughly doubles per level and takes over around the same place. What it would do is turn a hard ceiling into a soft one, because global work is checkpointable across transactions and depth is not. That is the named path forward, and it is not in this build.",
      },
    ],
  },
];
