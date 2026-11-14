import { HardhatUserConfig } from "hardhat/config";
import "@nomicfoundation/hardhat-toolbox";

// RPC URLs and the deployer key come from the environment only. Nothing here is a secret.
const key = process.env.DEPLOYER_KEY;
const accounts = key ? [key] : [];
const rpc = (name: string): string => process.env[name] ?? "";

const config: HardhatUserConfig = {
  solidity: {
    version: "0.8.24",
    // paris: no PUSH0, so the same bytecode runs on Ethereum and BNB Chain alike.
    settings: { optimizer: { enabled: true, runs: 200 }, evmVersion: "paris" },
  },
  networks: {
    // HARDHAT_CHAIN_ID lets scripts/deploy.ts be dry-run in-process as if on another chain.
    hardhat: { chainId: Number(process.env.HARDHAT_CHAIN_ID ?? 31337) },
    // SEPOLIA_GAS_PRICE (wei): the default tip is far above what Sepolia needs and can outrun a testnet deployer's balance.
    sepolia: { url: rpc("SEPOLIA_RPC_URL"), chainId: 11155111, accounts, ...(process.env.SEPOLIA_GAS_PRICE ? { gasPrice: Number(process.env.SEPOLIA_GAS_PRICE) } : {}) },
    bscTestnet: { url: rpc("BSC_TESTNET_RPC_URL"), chainId: 97, accounts },
    ethereum: { url: rpc("ETHEREUM_RPC_URL"), chainId: 1, accounts },
    bsc: { url: rpc("BSC_RPC_URL"), chainId: 56, accounts },
  },
  etherscan: {
    apiKey: process.env.ETHERSCAN_API_KEY ?? "",
  },
  gasReporter: {
    enabled: process.env.REPORT_GAS !== undefined,
    currency: "USD",
    noColors: true,
  },
  mocha: { timeout: 120_000 },
};

export default config;
