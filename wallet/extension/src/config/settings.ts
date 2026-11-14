// The user's settings: which network, and their edits to that network's
// defaults (config/defaults.ts). Stored in chrome.storage.local, public values
// only: no key or phrase ever goes here.

import { local, session } from '@/lib/storage';
import { hmac } from '@noble/hashes/hmac.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, hexToBytes, utf8ToBytes } from '@noble/hashes/utils.js';
import { isHex32 } from '@/lib/bigint';
import {
  DEFAULTS, DEFAULT_NETWORK, KASPA_NETWORK_NAMES, CHAIN_KEYS,
  type ChainKey, type EvmChainConfig, type KaspaNetworkName, type NetworkConfig,
} from './defaults';

export const SETTINGS_KEY = 'kusdt.settings';

export interface StoredSettings {
  network: KaspaNetworkName;
  /** -1 never, 0 when the popup closes, N minutes. */
  autoLockMins: number;
  overrides: Partial<Record<KaspaNetworkName, NetworkOverride>>;
  /** Per network, the mark that its edit was saved by this wallet while unlocked (settingsMac). */
  overrideMacs?: Partial<Record<KaspaNetworkName, string>>;
}

/**
 * The key the wallet marks its saved network edits with (hex): it exists while the wallet is unlocked. Local storage
 * is written without the password, so an edit found there may be anyone's: a Kaspa node of somebody else's under
 * "Testnet", say, which serves mainnet and calls it testnet. The same keys sign on every network and a Kaspa
 * signature names none, so that wallet would spend real KAS under test labels. An edit without the mark is not used.
 */
export const SESSION_PHRASE_KEY = 'kusdt.session.phrase';
/** The key, while the wallet is unlocked: made from the phrase each time, and kept nowhere, so a locked wallet holds nothing that could mark an edit. */
const settingsKeyNow = async (): Promise<string | null> => { const m = await session.get<string>(SESSION_PHRASE_KEY); return typeof m === 'string' && m ? settingsMacKeyOf(m) : null; };
export const settingsMacKeyOf = (mnemonic: string): string => bytesToHex(hmac(sha256, utf8ToBytes(mnemonic), utf8ToBytes('kusdt/settings-mac/v1')));

const canonical = (v: unknown): string =>
  Array.isArray(v) ? `[${v.map(canonical).join(',')}]`
    : v && typeof v === 'object' ? `{${Object.keys(v).sort().map(k => `${JSON.stringify(k)}:${canonical((v as Record<string, unknown>)[k])}`).join(',')}}`
      : JSON.stringify(v) ?? 'null';
export const settingsMac = (key: string, net: string, o: NetworkOverride): string =>
  bytesToHex(hmac(sha256, hexToBytes(key), utf8ToBytes(`${net}\n${canonical(o)}`)));

/** A stored edit with only values of the kind the preset has: anything else (a number where a list belongs) is dropped, not used. */
function cleanOverride(net: KaspaNetworkName, o: unknown): NetworkOverride {
  const d = DEFAULTS[net];
  const out: Record<string, unknown> = {};
  const fits = (v: unknown, like: unknown) => (Array.isArray(like) ? Array.isArray(v) && v.every(x => typeof x === 'string') : typeof v === typeof like);
  if (!o || typeof o !== 'object' || Array.isArray(o)) return {};
  for (const [k, v] of Object.entries(o)) {
    if (k === 'chains' || !Object.prototype.hasOwnProperty.call(d, k)) continue;
    if (fits(v, (d as unknown as Record<string, unknown>)[k])) out[k] = v;
  }
  const chains = (o as { chains?: unknown }).chains;
  if (chains && typeof chains === 'object' && !Array.isArray(chains)) {
    for (const key of CHAIN_KEYS) {
      const ch = (chains as Record<string, unknown>)[key];
      if (!ch || typeof ch !== 'object' || Array.isArray(ch)) continue;
      const kept: Record<string, unknown> = {};
      for (const [f, v] of Object.entries(ch)) if (Object.prototype.hasOwnProperty.call(d.chains[key], f) && fits(v, (d.chains[key] as unknown as Record<string, unknown>)[f])) kept[f] = v;
      if (Object.keys(kept).length) ((out.chains ??= {}) as Record<string, unknown>)[key] = kept;
    }
  }
  return out as NetworkOverride;
}

export interface NetworkOverride extends Partial<Omit<NetworkConfig, 'chains'>> {
  chains?: Partial<Record<ChainKey, Partial<EvmChainConfig>>>;
}

export const DEFAULT_SETTINGS: StoredSettings = { network: DEFAULT_NETWORK, autoLockMins: 15, overrides: {} };

export const isNetworkName = (v: unknown): v is KaspaNetworkName => typeof v === 'string' && (KASPA_NETWORK_NAMES as readonly string[]).includes(v);

/**
 * The stored edits that are this wallet's own: each carries the mark made with the wallet's key when it was saved.
 * The local network needs none (it only ever reaches this machine, mergeConfig, and the local stack's tools write it).
 * A wallet not unlocked since the browser started has no key to check with, and runs on the built-in values.
 */
export function trustedOverrides(s: Partial<StoredSettings> | null | undefined, key: string | null | undefined): StoredSettings['overrides'] {
  const out: StoredSettings['overrides'] = {};
  const stored = s?.overrides && typeof s.overrides === 'object' ? s.overrides : {};
  for (const net of KASPA_NETWORK_NAMES) {
    if (!Object.prototype.hasOwnProperty.call(stored, net)) continue;
    const o = cleanOverride(net, stored[net]);
    if (net === 'simnet' || (!!key && typeof s?.overrideMacs?.[net] === 'string' && s.overrideMacs[net] === settingsMac(key, net, o))) out[net] = o;
  }
  return out;
}

export async function loadSettings(): Promise<StoredSettings> {
  const s = await local.get<Partial<StoredSettings>>(SETTINGS_KEY);
  return {
    network: isNetworkName(s?.network) ? s!.network : DEFAULT_SETTINGS.network,
    autoLockMins: typeof s?.autoLockMins === 'number' && [0, 5, 15, 60].includes(s.autoLockMins) ? s.autoLockMins : DEFAULT_SETTINGS.autoLockMins,
    overrides: trustedOverrides(s, await settingsKeyNow()),
  };
}

export async function saveSettings(patch: Partial<StoredSettings>): Promise<StoredSettings> {
  const stored = (await local.get<Partial<StoredSettings>>(SETTINGS_KEY)) ?? {};
  const now = await loadSettings();
  // What is stored stays as it is unless this save changes it: an edit this wallet can't check right now is not thrown away.
  const next: Partial<StoredSettings> = { ...stored, network: patch.network ?? now.network, autoLockMins: patch.autoLockMins ?? now.autoLockMins };
  if (patch.overrides) {
    const key = await settingsKeyNow();
    // Only the networks this save changes are written. The caller built its patch from the edits this wallet could
    // check just now; a locked wallet can check none but the local network's, and the others' stored edits must not
    // go because of that.
    const macs: NonNullable<StoredSettings['overrideMacs']> = { ...(stored.overrideMacs && typeof stored.overrideMacs === 'object' ? stored.overrideMacs : {}) };
    const overrides: StoredSettings['overrides'] = { ...(stored.overrides && typeof stored.overrides === 'object' ? stored.overrides : {}) };
    for (const net of KASPA_NETWORK_NAMES) {
      const o = patch.overrides[net] ? cleanOverride(net, patch.overrides[net]) : undefined;
      if (canonical(o ?? null) === canonical(now.overrides[net] ?? null)) continue;
      if (net !== 'simnet' && !key) throw new Error('Unlock the wallet to change a network\'s settings.');
      if (!o) { delete overrides[net]; delete macs[net]; continue; }
      overrides[net] = o;
      if (net !== 'simnet') macs[net] = settingsMac(key!, net, o);
    }
    next.overrides = overrides;
    next.overrideMacs = macs;
  }
  await local.set({ [SETTINGS_KEY]: next });
  return loadSettings();
}

/** The values an edit really sets: an empty text or list means "the preset's value", as does a missing one. */
function setValues<T extends object>(o: T | undefined): Partial<T> {
  return Object.fromEntries(Object.entries(o ?? {}).filter(([, v]) =>
    v !== undefined && v !== null && v !== '' && !(Array.isArray(v) && v.length === 0))) as Partial<T>;
}

/**
 * A network's defaults with the user's edits on top. An empty edit keeps the
 * preset's value, so a preset that gains a deployment reaches a wallet that
 * once saved the form while it was empty. A chain's name is always the
 * preset's: it isn't editable, and an old stored copy (a coordinator's
 * "ethereum-local") never shows. So is its token's blocklist view: a stored
 * edit that dropped it would skip the check of the recipient before a burn.
 */
export function mergeConfig(net: KaspaNetworkName, o: NetworkOverride | undefined): NetworkConfig {
  const d = DEFAULTS[net];
  const chains = {} as Record<ChainKey, EvmChainConfig>;
  for (const k of CHAIN_KEYS) chains[k] = { ...d.chains[k], ...setValues(o?.chains?.[k]), name: d.chains[k].name, blocklist: d.chains[k].blocklist };
  const { chains: _ignored, ...rest } = o ?? {};
  void _ignored;
  const merged: NetworkConfig = { ...d, ...setValues(rest), chains };
  // Settings are saved without the password: what is stored can be an edit nobody remembers making (a minute at an
  // unlocked wallet, or a write to the extension's storage). So what decides where money goes is not taken from it.
  //
  // The chain a network signs for is the built-in one, on every network: the same keys sign everywhere, and a "Local"
  // or "Testnet" that was told chain ID 1 would show test labels over a real approval of real USDT.
  for (const k of CHAIN_KEYS) merged.chains[k].chainId = d.chains[k].chainId;
  // Mainnet: the contracts, and the coin values every transaction carries, are the built-in ones whatever is stored.
  // While the build names no mainnet deployment there is none: a typed one is not used.
  if (net === 'mainnet') {
    for (const f of DEPLOYMENT_FIELDS) merged[f] = d[f];
    for (const f of VALUE_FIELDS) merged[f] = d[f];
    for (const k of CHAIN_KEYS) for (const f of DEPLOYMENT_CHAIN_FIELDS) (merged.chains[k] as unknown as Record<string, unknown>)[f] = d.chains[k][f];
  }
  // The local network is the stack on this machine. Pointed anywhere else it would be another network under the
  // "Local" name, with the same keys: a node that calls itself simnet and serves mainnet, say.
  if (net === 'simnet') {
    if (!isLoopback(merged.nodeUrl)) merged.nodeUrl = d.nodeUrl;
    if (!isLoopback(merged.apiUrl)) merged.apiUrl = d.apiUrl;
    for (const k of CHAIN_KEYS) if (!merged.chains[k].rpcUrls.every(isLoopback)) merged.chains[k].rpcUrls = d.chains[k].rpcUrls;
  }
  return merged;
}

/** A URL on this machine (an empty one is no URL, and passes). */
const isLoopback = (url: string): boolean => {
  if (!url) return true;
  try { return ['127.0.0.1', 'localhost', '[::1]'].includes(new URL(url).hostname); } catch { return false; }
};
/** The KAS that kUSDT outputs, positions and burns carry: deployment values, and a stored 9 999 KAS "burn value" would be burned with every bridge back. */
const VALUE_FIELDS = ['tokenValue', 'positionValue', 'burnValue'] as const;

/** The values that say which contracts the money goes to. */
export const DEPLOYMENT_FIELDS = ['covenantId', 'poolId'] as const;
export const DEPLOYMENT_CHAIN_FIELDS = ['chainId', 'vault', 'token', 'decimals'] as const;

/** Whether the built-in deployment decides this value: on mainnet, once the preset has it. */
export const deploymentLocked = (net: KaspaNetworkName, chain: ChainKey | null, field: string): boolean =>
  chain
    ? field === 'chainId' || (net === 'mainnet' && (DEPLOYMENT_CHAIN_FIELDS as readonly string[]).includes(field))
    : net === 'mainnet' && ((DEPLOYMENT_FIELDS as readonly string[]).includes(field) || (VALUE_FIELDS as readonly string[]).includes(field));

/**
 * What of the deployment differs from the built-in one, in words ("the Ethereum vault"). Empty when nothing does.
 * Not asked of the local network: its deployment changes with every run of the stack.
 */
export function deploymentEdits(net: KaspaNetworkName, c: NetworkConfig): string[] {
  if (net === 'simnet') return [];
  const d = DEFAULTS[net];
  const differs = (a: unknown, b: unknown) => String(a ?? '').toLowerCase() !== String(b ?? '').toLowerCase();
  const out: string[] = [];
  // The servers too: they can't move money elsewhere, but they are who says what the wallet holds and what was paid.
  if (differs(c.apiUrl, d.apiUrl)) out.push('the bridge server');
  if (differs(c.nodeUrl, d.nodeUrl)) out.push('the Kaspa node');
  if (VALUE_FIELDS.some(f => differs(c[f], d[f]))) out.push('the KAS sent with kUSDT');
  if (differs(c.covenantId, d.covenantId)) out.push('the kUSDT token');
  if (differs(c.poolId, d.poolId)) out.push('the pool');
  for (const k of CHAIN_KEYS) {
    if (differs(c.chains[k].vault, d.chains[k].vault)) out.push(`the ${d.chains[k].name} vault`);
    if (differs(c.chains[k].token, d.chains[k].token) || differs(c.chains[k].chainId, d.chains[k].chainId) || differs(c.chains[k].decimals, d.chains[k].decimals)) out.push(`the ${d.chains[k].name} USDT`);
    if (differs(c.chains[k].rpcUrls.join(' '), d.chains[k].rpcUrls.join(' '))) out.push(`the ${d.chains[k].name} RPC`);
  }
  return out;
}

/** What `c` changes from the network's preset: the edit to store (names never are). Null when nothing differs. */
export function overrideOf(net: KaspaNetworkName, c: NetworkConfig): NetworkOverride | null {
  const d = DEFAULTS[net];
  const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
  const out: NetworkOverride = {};
  for (const k of ['nodeUrl', 'apiUrl', 'covenantId', 'poolId', 'tokenValue', 'positionValue', 'burnValue'] as const) {
    if (!same(c[k], d[k])) out[k] = c[k];
  }
  for (const k of CHAIN_KEYS) {
    const ch: Partial<EvmChainConfig> = {};
    for (const f of ['chainId', 'gasSymbol', 'vault', 'token', 'decimals', 'rpcUrls', 'explorerTx'] as const) {
      if (!same(c.chains[k][f], d.chains[k][f])) (ch as Record<string, unknown>)[f] = c.chains[k][f];
    }
    if (Object.keys(ch).length) (out.chains ??= {})[k] = ch;
  }
  return Object.keys(out).length ? out : null;
}

/** Stores `c` as the network's edit (only what differs from its preset). */
export async function saveNetworkConfig(net: KaspaNetworkName, c: NetworkConfig): Promise<StoredSettings> {
  const overrides = { ...(await loadSettings()).overrides };
  const o = overrideOf(net, c);
  if (o) overrides[net] = o; else delete overrides[net];
  return saveSettings({ overrides });
}

/** Back to the network's preset. */
export async function resetNetworkConfig(net: KaspaNetworkName): Promise<StoredSettings> {
  const overrides = { ...(await loadSettings()).overrides };
  delete overrides[net];
  return saveSettings({ overrides });
}

export interface Active { network: KaspaNetworkName; config: NetworkConfig; autoLockMins: number }

export async function activeConfig(): Promise<Active> {
  const s = await loadSettings();
  return { network: s.network, config: mergeConfig(s.network, s.overrides[s.network]), autoLockMins: s.autoLockMins };
}

// ── Validation of what the user types in Settings ──────────────────────────

const urlWith = (v: string, protocols: string[]): boolean => {
  try { return protocols.includes(new URL(v).protocol); } catch { return false; }
};
export const isEvmAddress = (v: string) => /^0x[0-9a-fA-F]{40}$/.test(v);

/** Why a network config can't be saved, or null. Empty values mean "not set". */
export function configProblem(c: NetworkConfig): string | null {
  if (c.nodeUrl && !urlWith(c.nodeUrl, ['ws:', 'wss:'])) return 'The node URL must start with ws:// or wss:// (wRPC JSON).';
  if (c.apiUrl && !urlWith(c.apiUrl, ['http:', 'https:'])) return 'The coordinator API URL must start with http:// or https://.';
  if (c.covenantId && !isHex32(c.covenantId)) return 'The kUSDT covenant ID is 64 lowercase hex characters.';
  if (c.poolId && !isHex32(c.poolId)) return 'The pool ID is 64 lowercase hex characters.';
  for (const [name, v] of [['token value', c.tokenValue], ['position value', c.positionValue], ['burn value', c.burnValue]] as const) {
    if (!/^\d{1,12}$/.test(v) || BigInt(v) < 20_000_000n) return `The ${name} is a whole number of sompi, at least 0.2 KAS.`;
  }
  for (const k of CHAIN_KEYS) {
    const ch = c.chains[k];
    if (!Number.isSafeInteger(ch.chainId) || ch.chainId <= 0) return `${ch.name}: the chain ID must be a positive number.`;
    if (ch.vault && !isEvmAddress(ch.vault)) return `${ch.name}: the vault is not an EVM address.`;
    if (ch.token && !isEvmAddress(ch.token)) return `${ch.name}: the USDT token is not an EVM address.`;
    if (!Number.isInteger(ch.decimals) || ch.decimals < 6 || ch.decimals > 36) return `${ch.name}: USDT decimals must be between 6 and 36.`;
    if (ch.rpcUrls.some(u => !urlWith(u, ['http:', 'https:']))) return `${ch.name}: every RPC URL must start with http:// or https://.`;
  }
  return null;
}

/** Whether a network has a deployment at all: one that has none (mainnet today) can't be picked. */
export const networkLive = (net: KaspaNetworkName, overrides: StoredSettings['overrides'] = {}) => isHex32(mergeConfig(net, overrides[net]).covenantId);

/** Whether kUSDT is usable on this config (a deployment and an API to find states). */
export const kusdtReady = (c: NetworkConfig) => isHex32(c.covenantId) && !!c.apiUrl;
export const poolReady = (c: NetworkConfig) => kusdtReady(c) && isHex32(c.poolId);
export const chainReady = (ch: EvmChainConfig) => isEvmAddress(ch.vault) && isEvmAddress(ch.token) && ch.rpcUrls.length > 0;
