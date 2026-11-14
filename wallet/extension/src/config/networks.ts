// How the wallet names and describes its networks to people. The stored keys
// ('testnet-10', 'simnet', 'mainnet') never show outside the advanced form:
// everything a screen says about a network comes from here.

import { DEFAULTS, type ChainKey, type KaspaNetworkName, type NetworkConfig } from './defaults';

/** test: test coins on public test networks; local: a stack on this computer; main: real funds. */
export type NetworkTone = 'test' | 'local' | 'main';

export interface NetworkInfo {
  /** "Testnet", "Local", "Mainnet". */
  name: string;
  /** The Kaspa side, as people know it. */
  kaspa: string;
  tone: NetworkTone;
  /** One short line under the name. */
  note: string;
  /** The calm line under every screen's header, or null for none. */
  banner: string | null;
  /**
   * The network's Trestly web app, where its Terms of Service are (config/terms.ts). Not editable: it is where people
   * read what they accept. Local has no public site of its own (its web app runs only with the stack), so it links the
   * testnet's, the same terms.
   */
  site: string;
}

export const NETWORKS: Record<KaspaNetworkName, NetworkInfo> = {
  'testnet-10': { name: 'Testnet', kaspa: 'Kaspa TN10', tone: 'test', note: 'Test coins only', banner: 'Testnet: test coins only, no real value', site: 'https://testnet.trestly.io' },
  simnet: { name: 'Local', kaspa: 'Kaspa simnet', tone: 'local', note: 'On this computer', banner: 'Local: a stack on this computer, test coins only', site: 'https://testnet.trestly.io' },
  mainnet: { name: 'Mainnet', kaspa: 'Kaspa', tone: 'main', note: 'Real funds', banner: null, site: 'https://trestly.io' },
};

/** The order of the Network screen. */
export const NETWORK_ORDER: readonly KaspaNetworkName[] = ['testnet-10', 'simnet', 'mainnet'];

export const networkName = (net: KaspaNetworkName): string => NETWORKS[net].name;

/** "Kaspa TN10 · Sepolia · BSC testnet": the three chains a network joins. */
export const chainsLine = (net: KaspaNetworkName, c: Pick<NetworkConfig, 'chains'> = DEFAULTS[net]): string =>
  [NETWORKS[net].kaspa, c.chains.ethereum.name, c.chains.bsc.name].join(' · ');

/** "Sepolia and BSC testnet". */
export const evmChainsText = (c: Pick<NetworkConfig, 'chains'>): string => `${c.chains.ethereum.name} and ${c.chains.bsc.name}`;

/**
 * How long a bridge transfer takes, roughly, for the screen to say. A deposit
 * is minted once it is final on its chain (Ethereum's finality is about
 * 15 minutes), a redemption is paid once the burn is final on Kaspa and 3 of
 * 5 signers sign.
 */
export function timeToExpect(net: KaspaNetworkName, direction: 'in' | 'out', chain: ChainKey, chainName: string): { time: string; why: string | null } {
  if (net === 'simnet') return { time: 'Under a minute', why: null };
  if (direction === 'in' && chain === 'ethereum') return { time: 'About 15 min', why: `${chainName} deposits wait for finality` };
  if (direction === 'out') return { time: 'A few minutes', why: 'Once the burn is final on Kaspa and 3 of 5 signers sign' };
  return { time: 'A few minutes', why: null };
}
