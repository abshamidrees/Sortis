import "@nomicfoundation/hardhat-toolbox";
import "@fhevm/hardhat-plugin";

import * as dotenv from "dotenv";
import type { HardhatUserConfig } from "hardhat/config";

dotenv.config();

const MNEMONIC = process.env.MNEMONIC ?? "test test test test test test test test test test test junk";
const SEPOLIA_RPC_URL = process.env.SEPOLIA_RPC_URL ?? "https://ethereum-sepolia-rpc.publicnode.com";
const PRIVATE_KEY = process.env.PRIVATE_KEY;

const config: HardhatUserConfig = {
  solidity: {
    version: "0.8.27",
    settings: {
      // FHEVM handles are opaque bytes32; the optimizer must not be so aggressive
      // that it reorders the ACL calls that follow each symbolic operation.
      optimizer: { enabled: true, runs: 800 },
      evmVersion: "cancun",
    },
  },
  networks: {
    // chainId 31337 makes ZamaEthereumConfig resolve the local mock coprocessor.
    hardhat: {
      chainId: 31337,
      accounts: { mnemonic: MNEMONIC, count: 10 },
      // Deliberately far above any real block. The HCU suite needs the FHEVM
      // budgets to be the binding constraint on _walk, not the EVM gas limit --
      // a walk that dies of gas tells you nothing about whether the encrypted
      // work fits. Sepolia gas limits still apply on the sepolia network.
      blockGasLimit: 1_000_000_000,
      allowUnlimitedContractSize: true,
    },
    localhost: { url: "http://127.0.0.1:8545", chainId: 31337 },
    sepolia: {
      url: SEPOLIA_RPC_URL,
      chainId: 11155111,
      // PRIVATE_KEY wins if set, otherwise the mnemonic. The default mnemonic
      // is the public Hardhat test phrase, whose accounts are drained by
      // everyone -- it will never have enough Sepolia ETH to deploy.
      accounts: PRIVATE_KEY ? [PRIVATE_KEY] : { mnemonic: MNEMONIC, count: 10 },
    },
  },
  etherscan: {
    apiKey: { sepolia: process.env.ETHERSCAN_API_KEY ?? "" },
  },
  paths: {
    sources: "./contracts",
    tests: "./test",
    cache: "./cache",
    artifacts: "./artifacts",
  },
  mocha: {
    timeout: 600_000,
  },
};

export default config;
