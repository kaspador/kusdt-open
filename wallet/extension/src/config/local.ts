// Local only: the development stack on this computer (bridge/devnet: npm run
// local:stack) gets a new deployment every time it restarts, so the wallet
// offers, in one tap, to use the stack's new one. It reads the dev faucet's
// GET /stack, or else the local coordinator's GET /status.
//
// On Testnet and Mainnet the deployment stays pinned and is never replaced
// from a server: every function here answers nothing for another network.

import { isHex32 } from '@/lib/bigint';
import { MAX_SMALL_ANSWER_BYTES, readCappedJson } from '@/lib/capped-read';
import { CHAIN_KEYS, type ChainKey, type KaspaNetworkName, type NetworkConfig } from './defaults';
import { isEvmAddress } from './settings';

/** The local stack's dev faucet (bridge/devnet), which describes the running stack. */
export const LOCAL_FAUCET = 'http://127.0.0.1:9099';

export interface LocalChain { chainId: number; vault: string; token: string; decimals: number }
export interface LocalDeployment {
  covenantId: string;
  poolId: string;
  tokenValue: string | null;
  burnValue: string | null;
  chains: Partial<Record<ChainKey, LocalChain>>;
}

const chainKeyOf = (v: unknown): ChainKey | null => (v === 1 || v === 'ethereum' ? 'ethereum' : v === 2 || v === 'bsc' ? 'bsc' : null);

/** A deployment from a /stack or /status answer, checked; null for anything unexpected. */
export function parseLocalDeployment(kaspa: any, chains: unknown): LocalDeployment | null {
  const covenantId = typeof kaspa?.covenantId === 'string' ? kaspa.covenantId : '';
  const poolId = typeof kaspa?.poolId === 'string' ? kaspa.poolId : '';
  if (!isHex32(covenantId) || !isHex32(poolId)) return null;
  const sompi = (v: unknown) => (typeof v === 'number' && Number.isSafeInteger(v) && v > 0) || (typeof v === 'string' && /^\d{1,12}$/.test(v)) ? String(v) : null;
  const out: LocalDeployment = { covenantId, poolId, tokenValue: sompi(kaspa?.tokenValue), burnValue: sompi(kaspa?.burnValue), chains: {} };
  for (const c of Array.isArray(chains) ? chains : []) {
    const k = chainKeyOf(c?.chain);
    if (!k) continue;
    const chainId = Number(c.chainId), decimals = Number(c.decimals);
    if (!Number.isSafeInteger(chainId) || chainId <= 0 || !Number.isInteger(decimals) || decimals < 6 || decimals > 36) return null;
    if (typeof c.vault !== 'string' || !isEvmAddress(c.vault) || typeof c.token !== 'string' || !isEvmAddress(c.token)) return null;
    out.chains[k] = { chainId, vault: c.vault, token: c.token, decimals };
  }
  return out;
}

async function getJson(url: string, fetcher: typeof fetch): Promise<any> {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 4_000);
  try {
    const r = await fetcher(url, { signal: ctl.signal, cache: 'no-store' });
    if (!r.ok) return null;
    return await readCappedJson(r, MAX_SMALL_ANSWER_BYTES);
  } catch { return null; } finally { clearTimeout(t); }
}

/**
 * The running local stack's deployment: from the faucet's /stack, else from
 * the coordinator's /status at `apiUrl`. Null when neither answers, and always
 * null off the Local network.
 */
export async function readLocalDeployment(network: KaspaNetworkName, apiUrl: string, fetcher: typeof fetch = (...a) => fetch(...a)): Promise<LocalDeployment | null> {
  if (network !== 'simnet') return null;
  const stack = await getJson(`${LOCAL_FAUCET}/stack`, fetcher);
  const fromStack = stack ? parseLocalDeployment(stack.deployment?.kaspa, stack.deployment?.chains) : null;
  if (fromStack) return fromStack;
  if (!apiUrl) return null;
  const status = await getJson(`${apiUrl.replace(/\/+$/, '')}/status`, fetcher);
  return status ? parseLocalDeployment(status.kaspa, status.chains) : null;
}

/** Whether the pinned deployment is not the stack's (an empty one counts as different). */
export function deploymentDiffers(c: NetworkConfig, d: LocalDeployment): boolean {
  if (c.covenantId !== d.covenantId || c.poolId !== d.poolId) return true;
  return CHAIN_KEYS.some(k => {
    const n = d.chains[k];
    const p = c.chains[k];
    return !!n && (n.chainId !== p.chainId || n.vault.toLowerCase() !== p.vault.toLowerCase() || n.token.toLowerCase() !== p.token.toLowerCase() || n.decimals !== p.decimals);
  });
}

/** `c` with the stack's deployment in it; endpoints, RPCs and names stay as they are. */
export function withLocalDeployment(c: NetworkConfig, d: LocalDeployment): NetworkConfig {
  const chains = { ...c.chains };
  for (const k of CHAIN_KEYS) { const n = d.chains[k]; if (n) chains[k] = { ...chains[k], ...n }; }
  return { ...c, covenantId: d.covenantId, poolId: d.poolId, ...(d.tokenValue ? { tokenValue: d.tokenValue } : {}), ...(d.burnValue ? { burnValue: d.burnValue } : {}), chains };
}
