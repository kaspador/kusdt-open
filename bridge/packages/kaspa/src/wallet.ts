// Scanning a Kaspa account: the coins on its addresses, which addresses it
// has used, and recent activity.
//
// The wallet receives on, and sends change back to, ONE address per account:
// m/44'/111111'/<account>'/0/0. Single-address wallets (KasWare's default)
// only watch that address, so keeping funds there means every Kaspa wallet
// restored from the same phrase shows the full balance. Funds that other
// wallets put on later receive or change addresses (Kaspa NG rotates them)
// are still found, and every coin found is spendable from here:
//
//  - Fast path (every refresh): the coins of indexes 0–39 on both chains, in
//    one call to a public node. A coin near the end of the window widens it.
//  - Slow path (in the background, see discoverUsedAddresses): addresses that
//    were ever used, from api.kaspa.org's history index. It only adds
//    addresses, so the balance never waits for it.

import type { HDKey } from '@scure/bip32';
import { kaspaKeyAt, kaspaPrivateKeyAt, type KaspaKey } from './derive';
import { fetchActive, fetchUtxos, fetchHistory, fetchVirtualDaaScore, submitTransaction, type KaspaApiTx } from './api';
import { nodeUtxos, nodeVirtualDaaScore, nodeSubmit, RpcError } from './node';
import { spendableUtxos } from './build';
import { toRpcTransactionJson, toSubmitJson, type KaspaTx, type KaspaUtxo } from './tx';
import type { KaspaNetworkParams } from './network';

export const GAP_LIMIT = 20;
const WINDOW = 2 * GAP_LIMIT;
const MAX_INDEX = 400;

export interface KaspaScan {
  account:         number;
  receive:         KaspaKey;          // m/44'/111111'/account'/0/0
  addresses:       KaspaKey[];        // receive address + every address found used or holding coins
  utxos:           KaspaUtxo[];
  balance:         bigint;            // every coin not already being spent by a payment from here
  spendable:       bigint;            // minus mined (coinbase) coins that are not mature yet
  virtualDaaScore: bigint | null;
  via:             'node' | 'api';    // where the coins came from
}

async function apiUtxos(net: KaspaNetworkParams, addresses: string[]): Promise<KaspaUtxo[]> {
  const chunks: string[][] = [];
  for (let i = 0; i < addresses.length; i += 100) chunks.push(addresses.slice(i, i + 100));
  return (await Promise.all(chunks.map(c => fetchUtxos(net, c)))).flat();
}

/** Coins of `addresses`: from a public node, or from api.kaspa.org when no node answers. */
export async function getUtxos(net: KaspaNetworkParams, addresses: string[]): Promise<{ utxos: KaspaUtxo[]; via: 'node' | 'api' }> {
  if (addresses.length === 0) return { utxos: [], via: 'node' };
  try { return { utxos: await nodeUtxos(net, addresses), via: 'node' }; }
  catch { return { utxos: await apiUtxos(net, addresses), via: 'api' }; }
}

async function daaScore(net: KaspaNetworkParams): Promise<bigint | null> {
  try { return await nodeVirtualDaaScore(net); } catch { return fetchVirtualDaaScore(net); }
}

const keyRange = (node: HDKey, account: number, net: KaspaNetworkParams, chain: 0 | 1, from: number, n: number) =>
  Array.from({ length: n }, (_, i) => kaspaKeyAt(node, account, chain, from + i, net));

/** Recompute balance and spendable from a coin list. */
export function totals(utxos: KaspaUtxo[], daa: bigint | null, pending: ReadonlySet<string>) {
  // Coins a payment from here is already spending don't count.
  const balance   = utxos.filter(u => !pending.has(`${u.txid}:${u.index}`)).reduce((s, u) => s + u.amount, 0n);
  const spendable = spendableUtxos(utxos, { virtualDaaScore: daa, pending }).reduce((s, u) => s + u.amount, 0n);
  return { balance, spendable };
}

/**
 * The account's coins (fast path above). `known` are addresses an earlier scan
 * found; each is re-derived and checked before it is used.
 */
export async function scanKaspaAccount(
  node: HDKey, account: number, net: KaspaNetworkParams, pending: ReadonlySet<string> = new Set(),
  opts: { known?: KaspaKey[] } = {},
): Promise<KaspaScan> {
  const receive = kaspaKeyAt(node, account, 0, 0, net);
  const byAddr = new Map<string, KaspaKey>([[receive.address, receive]]);
  for (const k of opts.known ?? []) {
    if (k.account !== account || (k.chain !== 0 && k.chain !== 1) || !Number.isInteger(k.index)) continue;
    const again = kaspaKeyAt(node, account, k.chain, k.index, net);
    if (again.address === k.address) byAddr.set(again.address, again);
  }

  const next = { 0: WINDOW, 1: WINDOW };
  let lookup = [...keyRange(node, account, net, 0, 0, WINDOW), ...keyRange(node, account, net, 1, 0, WINDOW), ...byAddr.values()];
  const utxos: KaspaUtxo[] = [];
  let via: 'node' | 'api' = 'node';
  const looked = new Set<string>();
  while (lookup.length > 0) {
    const batch = lookup.filter(k => !looked.has(k.address));
    batch.forEach(k => looked.add(k.address));
    const r = await getUtxos(net, batch.map(k => k.address));
    if (r.via === 'api') via = 'api';
    utxos.push(...r.utxos);
    const keyOf = new Map(batch.map(k => [k.address, k]));
    const lastFunded = { 0: -1, 1: -1 };
    for (const u of r.utxos) {
      const k = keyOf.get(u.address);
      if (!k) continue;
      byAddr.set(k.address, k);
      if (k.index > lastFunded[k.chain]) lastFunded[k.chain] = k.index;
    }
    // A coin within GAP_LIMIT of the window's end: look further on that chain.
    lookup = [];
    for (const chain of [0, 1] as const) {
      if (lastFunded[chain] >= next[chain] - GAP_LIMIT && next[chain] < MAX_INDEX) {
        lookup.push(...keyRange(node, account, net, chain, next[chain], WINDOW));
        next[chain] += WINDOW;
      }
    }
  }

  const daa = utxos.some(u => u.isCoinbase) ? await daaScore(net) : null;
  return { account, receive, addresses: [...byAddr.values()], utxos, ...totals(utxos, daa, pending), virtualDaaScore: daa, via };
}

/**
 * Every address of the account that was ever used, from api.kaspa.org's
 * history index (gap limit 20 per chain). Slow and sometimes unavailable, so
 * it runs in the background and only ever adds addresses.
 */
export async function discoverUsedAddresses(node: HDKey, account: number, net: KaspaNetworkParams): Promise<KaspaKey[]> {
  const used: KaspaKey[] = [];
  const lastUsed = { 0: -1, 1: -1 };
  const next = { 0: WINDOW, 1: WINDOW };    // first index not looked at yet
  let batch = [...keyRange(node, account, net, 0, 0, WINDOW), ...keyRange(node, account, net, 1, 0, WINDOW)];
  while (batch.length > 0) {
    const active = await fetchActive(net, batch.map(k => k.address));
    for (const k of batch) {
      if (!active.has(k.address)) continue;
      used.push(k);
      if (k.index > lastUsed[k.chain]) lastUsed[k.chain] = k.index;
    }
    batch = [];
    for (const chain of [0, 1] as const) {
      if (next[chain] - 1 - lastUsed[chain] < GAP_LIMIT && next[chain] < MAX_INDEX) {
        batch.push(...keyRange(node, account, net, chain, next[chain], GAP_LIMIT));
        next[chain] += GAP_LIMIT;
      }
    }
  }
  return used;
}

/**
 * Submit a signed payment: to a public node, or through api.kaspa.org when no
 * node can be reached. A node's rejection is final (it looked at the payment
 * and said no). If the node took the payment but its answer got lost, the
 * fallback finds it already in the mempool, which counts as sent. Neither
 * client takes an answer that names another transaction (nodeSubmit,
 * submitTransaction): a node's goes on to api.kaspa.org, and api.kaspa.org's
 * is answered as an error, with no id, as its other refusals are.
 */
export async function submitPayment(net: KaspaNetworkParams, tx: KaspaTx, expectedTxid: string): Promise<{ txid?: string; error?: string }> {
  try { return { txid: await nodeSubmit(net, toRpcTransactionJson(tx), expectedTxid) }; }
  catch (e) { if (e instanceof RpcError) return { error: e.message }; }
  return submitTransaction(net, toSubmitJson(tx), expectedTxid);
}

/** The private key for one of the scanned addresses (null if it isn't one). */
export function keyForAddress(node: HDKey, scan: KaspaScan, address: string): Uint8Array | null {
  const k = scan.addresses.find(a => a.address === address);
  return k ? kaspaPrivateKeyAt(node, k.chain, k.index) : null;
}

// ── Activity ─────────────────────────────────────────────────────────────────

export interface KaspaActivity {
  txid:         string;
  time:         number | null;       // ms since epoch
  confirmed:    boolean;
  direction:    'in' | 'out' | 'self';
  net:          bigint;              // change to the account's balance, sompi (negative when sending)
  counterparty: string | null;       // first other address involved
}

/** Turn API transactions into the account's view of them. */
export function summarizeHistory(rows: KaspaApiTx[], ours: ReadonlySet<string>): KaspaActivity[] {
  const seen = new Set<string>();
  const out: KaspaActivity[] = [];
  for (const r of rows) {
    if (seen.has(r.transaction_id)) continue;
    seen.add(r.transaction_id);
    let fromUs = 0n, toUs = 0n, toOthers = 0n;
    let otherIn: string | null = null, otherOut: string | null = null;
    for (const i of r.inputs ?? []) {
      const a = i.previous_outpoint_address ?? null;
      if (a && ours.has(a)) fromUs += BigInt(Math.max(0, Math.round(i.previous_outpoint_amount ?? 0)));
      else if (a && !otherIn) otherIn = a;
    }
    for (const o of r.outputs ?? []) {
      const a = o.script_public_key_address ?? null;
      const v = BigInt(Math.max(0, Math.round(o.amount ?? 0)));
      if (a && ours.has(a)) toUs += v;
      else { toOthers += v; if (a && !otherOut) otherOut = a; }
    }
    if (fromUs === 0n && toUs === 0n) continue;
    const direction: KaspaActivity['direction'] = fromUs === 0n ? 'in' : toOthers > 0n ? 'out' : 'self';
    out.push({
      txid: r.transaction_id,
      time: typeof r.block_time === 'number' ? r.block_time : null,
      confirmed: r.is_accepted === true,
      direction,
      net: toUs - fromUs,
      counterparty: direction === 'in' ? otherIn : direction === 'out' ? otherOut : null,
    });
  }
  return out.sort((a, b) => (b.time ?? Number.MAX_SAFE_INTEGER) - (a.time ?? Number.MAX_SAFE_INTEGER));
}

/** Recent activity across the account's used addresses (newest first). */
export async function fetchKaspaActivity(scan: KaspaScan, net: KaspaNetworkParams, limit = 25): Promise<KaspaActivity[]> {
  const ours = new Set(scan.addresses.map(k => k.address));
  // The receive address first; other used addresses after it, capped to keep requests few.
  const list = [scan.receive.address, ...scan.addresses.map(k => k.address).filter(a => a !== scan.receive.address)].slice(0, 8);
  const pages = await Promise.all(list.map(a => fetchHistory(net, a, limit).catch(() => [] as KaspaApiTx[])));
  return summarizeHistory(pages.flat(), ours).slice(0, limit);
}
