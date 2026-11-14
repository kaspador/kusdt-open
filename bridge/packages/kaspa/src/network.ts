// Kaspa networks: address prefixes, public REST APIs and explorers.

export type KaspaNetwork = 'mainnet' | 'testnet-10' | 'simnet' | 'devnet';

export interface KaspaNetworkParams {
  name:     KaspaNetwork;
  prefix:   'kaspa' | 'kaspatest' | 'kaspasim' | 'kaspadev';   // address prefix, e.g. kaspa:qq…
  api:      string;                  // public REST API ('' for local networks)
  explorerTx:      string;           // block explorer links; {id} / {address} are filled in
  explorerAddress: string;
}

export const KASPA_NETWORKS: Record<KaspaNetwork, KaspaNetworkParams> = {
  mainnet: {
    name: 'mainnet', prefix: 'kaspa', api: 'https://api.kaspa.org',
    explorerTx: 'https://explorer.kaspa.org/txs/{id}', explorerAddress: 'https://explorer.kaspa.org/addresses/{address}',
  },
  'testnet-10': {
    name: 'testnet-10', prefix: 'kaspatest', api: 'https://api-tn10.kaspa.org',
    explorerTx: 'https://tn10.kaspa.stream/transactions/{id}', explorerAddress: 'https://tn10.kaspa.stream/addresses/{address}',
  },
  simnet: { name: 'simnet', prefix: 'kaspasim', api: '', explorerTx: '', explorerAddress: '' },
  devnet: { name: 'devnet', prefix: 'kaspadev', api: '', explorerTx: '', explorerAddress: '' },
};

// BIP-44 coin type registered for Kaspa (SLIP-44). Same on every Kaspa network.
export const KASPA_COIN_TYPE = 111111;

export const SOMPI_PER_KAS = 100_000_000n;
/** sompi → "1,234.5" (up to `decimals` places, no trailing zeros). Exact for any amount. */
export function formatKas(sompi: bigint, decimals = 8): string {
  const neg = sompi < 0n;
  const v = neg ? -sompi : sompi;
  const whole = (v / SOMPI_PER_KAS).toLocaleString('en-US');
  let frac = (v % SOMPI_PER_KAS).toString().padStart(8, '0').slice(0, decimals).replace(/0+$/, '');
  if (decimals === 0) frac = '';
  return `${neg ? '-' : ''}${whole}${frac ? `.${frac}` : ''}`;
}

/** sompi → plain decimal string without grouping, for input fields ("1234.5"). */
export function kasInputString(sompi: bigint): string {
  return formatKas(sompi, 8).replace(/,/g, '');
}

/** Approximate KAS value as a float, for USD display only (never for amounts sent). */
export function sompiToKas(sompi: bigint): number {
  return Number(sompi) / 1e8;
}

/**
 * "1.5" → 150000000n. Exact decimal parsing (no floating point), at most 8
 * decimals. Returns null for anything that isn't a plain positive-or-zero number.
 */
export function parseKas(input: string): bigint | null {
  const s = input.trim().replace(',', '.');
  const m = /^(\d*)(?:\.(\d{0,8}))?$/.exec(s);
  if (!m || (m[1] === '' && (m[2] ?? '') === '')) return null;
  const whole = BigInt(m[1] || '0');
  const frac  = BigInt((m[2] ?? '').padEnd(8, '0') || '0');
  return whole * SOMPI_PER_KAS + frac;
}

export function explorerTxUrl(net: KaspaNetworkParams, txid: string): string {
  return net.explorerTx.replace('{id}', txid);
}

export function explorerAddressUrl(net: KaspaNetworkParams, address: string): string {
  return net.explorerAddress.replace('{address}', address);
}
