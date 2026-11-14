// The wallet's built-in defaults, one per Kaspa network: where it talks to
// (node, coordinator API, EVM RPCs) and which deployment it pins (SPEC §1:
// wallets pin the kUSDT covenant ID and the vault addresses). Every value but
// the chain names is editable (Network → Advanced); edits are stored per
// network and win over these.
//
// Values marked TO_BE_FILLED are not deployed yet (mainnet). A deployment with
// an empty covenant ID shows kUSDT as "not live" there and builds nothing.
//
// What people see (Testnet, Local, Mainnet, and how each network is described)
// is in config/networks.ts; the keys here ('testnet-10', 'simnet') are internal.

import type { Blocklist } from '@kusdt/protocol';

export type KaspaNetworkName = 'mainnet' | 'testnet-10' | 'simnet';
export const KASPA_NETWORK_NAMES: readonly KaspaNetworkName[] = ['testnet-10', 'mainnet', 'simnet'];
export const DEFAULT_NETWORK: KaspaNetworkName = 'testnet-10';

/** SPEC §2 chain codes. */
export type ChainKey = 'ethereum' | 'bsc';
export const CHAIN_CODE: Record<ChainKey, 1 | 2> = { ethereum: 1, bsc: 2 };
export const CHAIN_KEYS: readonly ChainKey[] = ['ethereum', 'bsc'];

export interface EvmChainConfig {
  /**
   * The chain's display name ("Sepolia", "BNB Chain (local)", …). It is the
   * preset's own: not editable, and never taken from a stored edit or from a
   * coordinator, so the wallet always names the chain it pinned
   * (settings.ts mergeConfig).
   */
  name: string;
  chainId: number;
  /** What pays gas there. */
  gasSymbol: string;
  /** KusdtVault on that chain. */
  vault: string;
  /** The USDT the vault locks. */
  token: string;
  decimals: number;
  /**
   * The view the token answers whether it blocks an address with (SPEC §9), as the deployment names it; null for a
   * token that keeps none (BSC-USD). Asked before every burn (kusdt/redeem.ts). The preset's own, like the name: not
   * editable, and never taken from a stored edit (settings.ts mergeConfig).
   */
  blocklist: Blocklist | null;
  /** JSON-RPC endpoints, tried in order. */
  rpcUrls: string[];
  /** Block explorer, with {tx} filled in. Empty for none. */
  explorerTx: string;
}

export interface NetworkConfig {
  /** Kaspa node, wRPC JSON (ws:// or wss://). Empty: the public Kaspa node network (resolver). */
  nodeUrl: string;
  /** Coordinator API base, ending in /api/v1 (SPEC §13). */
  apiUrl: string;
  /** kUSDT's covenant ID (64 hex). Empty: not deployed. */
  covenantId: string;
  /** The KAS ⇄ kUSDT pool's covenant ID. */
  poolId: string;
  /** KAS (sompi) every new token state carries for its storage mass. */
  tokenValue: string;
  /** KAS (sompi) a new liquidity position carries. */
  positionValue: string;
  /** KAS (sompi) a redemption's burn output carries. Nothing ever spends a burn, so this KAS is gone for good: kept small (SPEC §9). */
  burnValue: string;
  chains: Record<ChainKey, EvmChainConfig>;
}

export const TO_BE_FILLED = '';

/**
 * 1.5 KAS per token state. Covenant UTXOs count double for storage mass, so a
 * state needs about this much for a transaction with up to 3 token outputs
 * to stay under the standard mass (PROGRESS.md "Decisions"; SPEC §5).
 */
export const DEFAULT_TOKEN_VALUE = '150000000';
/** 2 KAS per liquidity position (bridge/devnet/src/simnet-e2e.ts POSITION_VALUE). */
export const DEFAULT_POSITION_VALUE = '200000000';
/** 0.3 KAS per burn: the deployments' kaspa.burnValue (bridge/packages/protocol DEFAULT_BURN_VALUE). */
export const DEFAULT_BURN_VALUE = '30000000';

export const DEFAULTS: Record<KaspaNetworkName, NetworkConfig> = {
  // The live public testnet: Kaspa testnet-10 with Sepolia and BSC testnet
  // (deployments/testnet.json), served at https://testnet.trestly.io; live since
  // 4 November 2026 (deploy/compose.testnet.yml). The node is any node of the
  // public Kaspa node network (the resolver reaches testnet-10).
  'testnet-10': {
    nodeUrl: '',
    apiUrl: 'https://testnet.trestly.io/api/v1',
    covenantId: 'a1d9fd1347128011ad0036b077949d63274d5d3b8ac8351776c30c945ef2c2fb',
    poolId: '99445008e36139d0a57040f562414e298a3022fb739c0e9374b1dbb9f4c42171',
    tokenValue: DEFAULT_TOKEN_VALUE,
    positionValue: DEFAULT_POSITION_VALUE,
    burnValue: DEFAULT_BURN_VALUE,
    chains: {
      ethereum: {
        name: 'Sepolia', chainId: 11155111, gasSymbol: 'ETH',
        vault: '0xeec4724B6D49f694656C1AE82D1A6eF8060f64BA', token: '0x73ee84cf953CDa0501Be2Ac26E4b92606eF85Fd6', decimals: 6, blocklist: 'isBlackListed',
        // (sepolia.drpc.org no longer serves Sepolia on its free plan: it answers "chain is not available".)
        rpcUrls: ['https://ethereum-sepolia-rpc.publicnode.com', 'https://sepolia.gateway.tenderly.co'],
        explorerTx: 'https://sepolia.etherscan.io/tx/{tx}',
      },
      bsc: {
        name: 'BSC testnet', chainId: 97, gasSymbol: 'tBNB',
        vault: '0xeB9D91915E3CC696e2fDFDEd614551a5C6bf58f4', token: '0x422B8b64971C1664DeCB5015c034d8094cb93EF4', decimals: 18, blocklist: null,
        rpcUrls: ['https://bsc-testnet-rpc.publicnode.com', 'https://data-seed-prebsc-1-s1.bnbchain.org:8545'],
        explorerTx: 'https://testnet.bscscan.com/tx/{tx}',
      },
    },
  },
  // Nothing is deployed on mainnet yet: the Network screen shows it as "Not
  // live yet" and it can't be picked while its covenant ID is empty.
  mainnet: {
    nodeUrl: '',
    apiUrl: TO_BE_FILLED,
    covenantId: TO_BE_FILLED,
    poolId: TO_BE_FILLED,
    tokenValue: DEFAULT_TOKEN_VALUE,
    positionValue: DEFAULT_POSITION_VALUE,
    burnValue: DEFAULT_BURN_VALUE,
    chains: {
      ethereum: {
        name: 'Ethereum', chainId: 1, gasSymbol: 'ETH',
        vault: TO_BE_FILLED, token: '0xdAC17F958D2ee523a2206206994597C13D831ec7', decimals: 6, blocklist: 'isBlackListed',
        rpcUrls: ['https://ethereum-rpc.publicnode.com', 'https://eth.drpc.org'],
        explorerTx: 'https://etherscan.io/tx/{tx}',
      },
      bsc: {
        name: 'BNB Chain', chainId: 56, gasSymbol: 'BNB',
        vault: TO_BE_FILLED, token: '0x55d398326f99059fF775485246999027B3197955', decimals: 18, blocklist: null,
        rpcUrls: ['https://bsc-rpc.publicnode.com', 'https://bsc-dataseed.bnbchain.org'],
        explorerTx: 'https://bscscan.com/tx/{tx}',
      },
    },
  },
  // The local development stack (bridge/devnet: npm run local:stack): kaspad
  // simnet in Docker, two Hardhat chains with vaults, the signers and the
  // coordinator. The covenant and pool IDs change with every new stack; on
  // this network only, the wallet offers to take the stack's new deployment
  // in one tap (config/local.ts).
  simnet: {
    nodeUrl: 'ws://127.0.0.1:18610',
    apiUrl: 'http://127.0.0.1:9100/api/v1',
    covenantId: TO_BE_FILLED,
    poolId: TO_BE_FILLED,
    tokenValue: DEFAULT_TOKEN_VALUE,
    positionValue: DEFAULT_POSITION_VALUE,
    burnValue: DEFAULT_BURN_VALUE,
    chains: {
      ethereum: {
        name: 'Ethereum (local)', chainId: 31337, gasSymbol: 'ETH',
        vault: '0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512', token: '0x5FbDB2315678afecb367f032d93F642f64180aa3', decimals: 6, blocklist: 'isBlackListed',
        rpcUrls: ['http://127.0.0.1:8545'], explorerTx: '',
      },
      bsc: {
        name: 'BNB Chain (local)', chainId: 31338, gasSymbol: 'BNB',
        vault: '0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512', token: '0x5FbDB2315678afecb367f032d93F642f64180aa3', decimals: 18, blocklist: null,
        rpcUrls: ['http://127.0.0.1:8546'], explorerTx: '',
      },
    },
  },
};
