/**
 * The slices of the contract ABIs the frontend calls.
 *
 * Hand-written rather than imported from the Hardhat artifacts, because the
 * artifacts live outside the Next app's module graph and importing across that
 * boundary drags the whole build system into the web bundle.
 */

export const POOL_ABI = [
  {
    type: "function",
    name: "capacity",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "uint256" }],
  },
  {
    type: "function",
    name: "leafCount",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "uint256" }],
  },
  {
    type: "function",
    name: "leafHighWater",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "uint256" }],
  },
  {
    type: "function",
    name: "activeHeight",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "uint8" }],
  },
  {
    type: "function",
    name: "DEPTH",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "uint8" }],
  },
  {
    type: "function",
    name: "timeUnitsNow",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "uint64" }],
  },
  {
    type: "function",
    name: "hasLeaf",
    stateMutability: "view",
    inputs: [{ name: "owner", type: "address" }],
    outputs: [{ type: "bool" }],
  },
  {
    type: "function",
    name: "leafOf",
    stateMutability: "view",
    inputs: [{ name: "owner", type: "address" }],
    outputs: [{ type: "uint256" }],
  },
  {
    type: "function",
    name: "stakeOf",
    stateMutability: "view",
    inputs: [{ name: "owner", type: "address" }],
    outputs: [{ type: "bytes32" }],
  },
  {
    type: "function",
    name: "interceptOf",
    stateMutability: "view",
    inputs: [{ name: "owner", type: "address" }],
    outputs: [{ type: "bytes32" }],
  },
  {
    type: "function",
    name: "lastChangeOf",
    stateMutability: "view",
    inputs: [{ name: "owner", type: "address" }],
    outputs: [{ type: "uint48" }],
  },
  {
    type: "function",
    name: "commit",
    stateMutability: "nonpayable",
    inputs: [
      { name: "amount", type: "bytes32" },
      { name: "inputProof", type: "bytes" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "release",
    stateMutability: "nonpayable",
    inputs: [
      { name: "amount", type: "bytes32" },
      { name: "inputProof", type: "bytes" },
    ],
    outputs: [],
  },
  {
    type: "event",
    name: "LeafAssigned",
    inputs: [
      { name: "owner", type: "address", indexed: true },
      { name: "leaf", type: "uint256", indexed: true },
    ],
  },
  {
    type: "event",
    name: "Committed",
    inputs: [
      { name: "owner", type: "address", indexed: true },
      { name: "leaf", type: "uint256", indexed: true },
    ],
  },
  {
    type: "event",
    name: "Released",
    inputs: [
      { name: "owner", type: "address", indexed: true },
      { name: "leaf", type: "uint256", indexed: true },
    ],
  },
] as const;

export const DRAW_ABI = [
  {
    type: "function",
    name: "drawCount",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "uint256" }],
  },
  {
    type: "function",
    name: "drawInfo",
    stateMutability: "view",
    inputs: [{ name: "drawId", type: "uint256" }],
    outputs: [
      { name: "rootHandle", type: "bytes32" },
      { name: "openedAtBlock", type: "uint256" },
      { name: "prize", type: "uint64" },
      { name: "totalWeight", type: "uint64" },
      { name: "walkHeight", type: "uint8" },
      { name: "lotDrawn", type: "bool" },
      { name: "refHour", type: "uint64" },
    ],
  },
  {
    type: "function",
    name: "resolvedLeafHandle",
    stateMutability: "view",
    inputs: [{ name: "drawId", type: "uint256" }],
    outputs: [{ type: "bytes32" }],
  },
  {
    type: "function",
    name: "hasClaimed",
    stateMutability: "view",
    inputs: [
      { name: "drawId", type: "uint256" },
      { name: "claimant", type: "address" },
    ],
    outputs: [{ type: "bool" }],
  },
  {
    type: "function",
    name: "minDrawInterval",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "uint256" }],
  },
  {
    type: "function",
    name: "secondsUntilNextDraw",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "uint256" }],
  },
  {
    type: "function",
    name: "openDraw",
    stateMutability: "nonpayable",
    inputs: [],
    outputs: [{ type: "uint256" }],
  },
  {
    // The settling transaction. The cleartext and proof come from a PUBLIC
    // decrypt of the root the contract published when the draw opened, so the
    // browser can assemble this without a grant. The lot is produced on chain
    // inside this call.
    type: "function",
    name: "drawLot",
    stateMutability: "nonpayable",
    inputs: [
      { name: "drawId", type: "uint256" },
      { name: "abiEncodedClearValues", type: "bytes" },
      { name: "decryptionProof", type: "bytes" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "claimPrize",
    stateMutability: "nonpayable",
    inputs: [{ name: "drawId", type: "uint256" }],
    outputs: [],
  },
  {
    type: "event",
    name: "DrawOpened",
    inputs: [
      { name: "drawId", type: "uint256", indexed: true },
      { name: "rootHandle", type: "bytes32", indexed: false },
      { name: "blockNumber", type: "uint256", indexed: false },
      { name: "prize", type: "uint64", indexed: false },
    ],
  },
  {
    type: "event",
    name: "Drawn",
    inputs: [
      { name: "drawId", type: "uint256", indexed: true },
      { name: "lotHandle", type: "bytes32", indexed: false },
      { name: "resolvedLeafHandle", type: "bytes32", indexed: false },
      { name: "totalWeight", type: "uint64", indexed: false },
    ],
  },
  {
    type: "event",
    name: "PrizeClaimed",
    inputs: [
      { name: "drawId", type: "uint256", indexed: true },
      { name: "claimant", type: "address", indexed: true },
    ],
  },
] as const;

export const CUSDT_ABI = [
  {
    type: "function",
    name: "confidentialBalanceOf",
    stateMutability: "view",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ type: "bytes32" }],
  },
  {
    type: "function",
    name: "isOperator",
    stateMutability: "view",
    inputs: [
      { name: "holder", type: "address" },
      { name: "spender", type: "address" },
    ],
    outputs: [{ type: "bool" }],
  },
  {
    type: "function",
    name: "setOperator",
    stateMutability: "nonpayable",
    inputs: [
      { name: "operator", type: "address" },
      { name: "until", type: "uint48" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "mint",
    stateMutability: "nonpayable",
    inputs: [
      { name: "to", type: "address" },
      { name: "amount", type: "uint64" },
    ],
    outputs: [{ type: "bytes32" }],
  },
  {
    type: "function",
    name: "decimals",
    stateMutability: "pure",
    inputs: [],
    outputs: [{ type: "uint8" }],
  },
] as const;

export const YIELD_ABI = [
  {
    type: "function",
    name: "pending",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "uint64" }],
  },
] as const;
