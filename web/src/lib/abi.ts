/**
 * The slices of the contract ABIs the frontend actually calls.
 *
 * Hand-written rather than imported from the Hardhat artifacts, because the
 * artifacts live outside the Next app's module graph and importing across that
 * boundary drags the whole build system into the web bundle. These are the six
 * reads Verify needs and nothing else.
 */

export const DRAW_ABI = [
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
    outputs: [{ name: "", type: "bytes32" }],
  },
  {
    type: "function",
    name: "drawCount",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint256" }],
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
] as const;

export const POOL_ABI = [
  {
    type: "function",
    name: "activeHeight",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint8" }],
  },
  {
    type: "function",
    name: "leafCount",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "capacity",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint256" }],
  },
] as const;
