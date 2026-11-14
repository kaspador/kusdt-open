// Client for the public Kaspa REST API (api.kaspa.org, run by the Kaspa
// community; source: github.com/kaspa-ng/kaspa-rest-server). It sends CORS
// headers for any origin, so the extension calls it directly: no extra
// permission, and no Kaspa traffic passes through pearlchain.live.
//
// Everything that comes back is treated as untrusted: amounts are parsed
// strictly, scripts are checked against the addresses we asked about, and
// a signed transaction never depends on anything here except which coins
// exist (a wrong answer can make a send fail, not send funds elsewhere).

import { hexToBytes } from './bytes';
import type { KaspaNetworkParams } from './network';
import type { KaspaUtxo } from './tx';
import { scriptForAddress } from './address';
import { nodeHasTransaction } from './rpc';

interface Res { ok: boolean; status: number; data: unknown }

async function once(url: string, init: RequestInit, signal: AbortSignal): Promise<Res> {
  const r = await fetch(url, { cache: 'no-store', ...init, signal });
  const text = await r.text();
  let data: unknown = null;
  try { data = text ? JSON.parse(text) : null; } catch { /* not JSON (e.g. a gateway error page) */ }
  return { ok: r.ok, status: r.status, data };
}

const MAX_ATTEMPTS = 4;
export const NOT_ANSWERING = 'api.kaspa.org is not answering right now.';

/**
 * Send a request, and send it again each time it has not answered after one
 * of the `hedgeAt` delays; the first answer wins and the rest are cancelled.
 * api.kaspa.org now and then leaves a request hanging for a minute while the
 * identical request answers in a third of a second, and every request this
 * wallet makes is safe to repeat (reads, and resubmitting the same signed
 * transaction, which has the same id).
 */
export function hedged(url: string, init: RequestInit, opts: { hedgeAt?: number[]; deadline?: number } = {}): Promise<Res> {
  const { hedgeAt = [2_500, 6_000, 12_000], deadline = 30_000 } = opts;
  return new Promise((resolve, reject) => {
    const ctrls: AbortController[] = [];
    const timers: ReturnType<typeof setTimeout>[] = [];
    let done = false, launched = 0, failed = 0;
    let lastErr: Error = new Error(NOT_ANSWERING);
    const finish = (f: () => void) => {
      if (done) return;
      done = true;
      timers.forEach(clearTimeout);
      ctrls.forEach(c => c.abort());
      f();
    };
    const launch = () => {
      if (done || launched >= MAX_ATTEMPTS) return;
      launched++;
      const c = new AbortController();
      ctrls.push(c);
      once(url, init, c.signal).then(res => {
        // Overloaded or failing gateway: worth another try. Anything else is an answer.
        if (res.status >= 500 || res.status === 429) throw new Error(`api.kaspa.org answered with an error (HTTP ${res.status}).`);
        finish(() => resolve(res));
      }).catch((e: Error) => {
        if (done) return;
        failed++;
        lastErr = e instanceof TypeError ? new Error('Could not connect to api.kaspa.org.') : e;
        if (failed === launched) {
          if (launched >= MAX_ATTEMPTS) finish(() => reject(lastErr));
          else timers.push(setTimeout(launch, 500));
        }
      });
    };
    launch();
    for (const ms of hedgeAt) timers.push(setTimeout(launch, ms));
    timers.push(setTimeout(() => finish(() => reject(failed > 0 ? lastErr : new Error(NOT_ANSWERING))), deadline));
  });
}

function errorText(res: Res): string {
  const d = res.data as { detail?: unknown; error?: unknown } | null;
  return typeof d?.error === 'string' ? d.error : typeof d?.detail === 'string' ? d.detail : `HTTP ${res.status}`;
}

async function call<T>(url: string, init: RequestInit = {}, opts?: { hedgeAt?: number[]; deadline?: number }): Promise<T> {
  const res = await hedged(url, init, opts);
  if (!res.ok) throw new Error(errorText(res));
  return res.data as T;
}

const post = <T>(url: string, body: unknown) =>
  call<T>(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

const isHex = (s: unknown, len?: number): s is string =>
  typeof s === 'string' && /^[0-9a-f]*$/.test(s) && s.length % 2 === 0 && (len == null || s.length === len);

function toBig(v: unknown): bigint {
  if (typeof v === 'string' && /^\d+$/.test(v)) return BigInt(v);
  if (typeof v === 'number' && Number.isSafeInteger(v) && v >= 0) return BigInt(v);
  throw new Error('Unexpected amount from the Kaspa API.');
}

/** Which of `addresses` have ever had a transaction. */
export async function fetchActive(net: KaspaNetworkParams, addresses: string[]): Promise<Set<string>> {
  if (addresses.length === 0) return new Set();
  const rows = await post<{ address: string; active: boolean }[]>(`${net.api}/addresses/active`, { addresses });
  if (!Array.isArray(rows)) throw new Error('Unexpected answer from the Kaspa API.');
  const asked = new Set(addresses);
  return new Set(rows.filter(r => r && r.active === true && asked.has(r.address)).map(r => r.address));
}

/**
 * Unspent coins of `addresses`. Each coin's locking script must be the
 * standard script of the address it is listed under, or the answer is rejected.
 */
export async function fetchUtxos(net: KaspaNetworkParams, addresses: string[]): Promise<KaspaUtxo[]> {
  if (addresses.length === 0) return [];
  type Row = { address: string; outpoint: { transactionId: string; index: number }; utxoEntry: { amount: string; scriptPublicKey: { scriptPublicKey: string }; blockDaaScore: string; isCoinbase: boolean } };
  const rows = await post<Row[]>(`${net.api}/addresses/utxos`, { addresses });
  if (!Array.isArray(rows)) throw new Error('Unexpected answer from the Kaspa API.');
  const asked = new Set(addresses);
  const seen = new Set<string>();
  const out: KaspaUtxo[] = [];
  for (const r of rows) {
    const txid = r?.outpoint?.transactionId;
    const index = r?.outpoint?.index;
    const spkHex = r?.utxoEntry?.scriptPublicKey?.scriptPublicKey;
    if (!asked.has(r?.address) || !isHex(txid, 64) || !Number.isInteger(index) || index < 0 || index > 0xffffffff || !isHex(spkHex)) {
      throw new Error('Unexpected coin data from the Kaspa API.');
    }
    const expected = scriptForAddress(r.address, net.prefix);
    if (spkHex !== Array.from(expected.script, b => b.toString(16).padStart(2, '0')).join('')) {
      throw new Error('The Kaspa API returned a coin that does not match its address.');
    }
    const key = `${txid}:${index}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      txid, index,
      amount: toBig(r.utxoEntry.amount),
      script: { version: 0, script: hexToBytes(spkHex) },
      blockDaaScore: toBig(r.utxoEntry.blockDaaScore),
      isCoinbase: r.utxoEntry.isCoinbase === true,
      address: r.address,
    });
  }
  return out;
}

/** Suggested fee rate in sompi per gram (the "normal" bucket). */
export async function fetchFeerate(net: KaspaNetworkParams): Promise<number | null> {
  try {
    const d = await call<{ normalBuckets?: { feerate?: number }[]; priorityBucket?: { feerate?: number } }>(`${net.api}/info/fee-estimate`);
    const f = d?.normalBuckets?.[0]?.feerate ?? d?.priorityBucket?.feerate;
    return typeof f === 'number' && Number.isFinite(f) && f > 0 ? f : null;
  } catch { return null; }
}

/** The virtual DAA score, needed to tell when mined (coinbase) coins become spendable. */
export async function fetchVirtualDaaScore(net: KaspaNetworkParams): Promise<bigint | null> {
  try {
    // Often the slowest call on api.kaspa.org; only mined-coin maturity needs it, so do not wait long.
    const d = await call<{ virtualDaaScore?: string }>(`${net.api}/info/blockdag`, {}, { hedgeAt: [2_000, 4_000], deadline: 8_000 });
    return d?.virtualDaaScore ? toBig(d.virtualDaaScore) : null;
  } catch { return null; }
}

/** KAS price in USD (mainnet API; testnet coins have no price). */
export async function fetchKasPrice(net: KaspaNetworkParams): Promise<number | null> {
  if (net.name !== 'mainnet') return null;
  try {
    const d = await call<{ price?: number }>(`${net.api}/info/price`);
    return typeof d?.price === 'number' && Number.isFinite(d.price) && d.price > 0 ? d.price : null;
  } catch { return null; }
}

export interface KaspaApiTx {
  transaction_id: string;
  block_time:     number | null;
  is_accepted:    boolean;
  inputs:  { previous_outpoint_address?: string | null; previous_outpoint_amount?: number | null }[] | null;
  outputs: { amount: number; script_public_key_address?: string | null }[] | null;
}

/** Recent transactions touching `address`, newest first. */
export async function fetchHistory(net: KaspaNetworkParams, address: string, limit = 25): Promise<KaspaApiTx[]> {
  const fields = 'transaction_id,block_time,is_accepted,inputs,outputs';
  const rows = await call<KaspaApiTx[]>(
    `${net.api}/addresses/${encodeURIComponent(address)}/full-transactions-page?limit=${limit}&resolve_previous_outpoints=light&fields=${fields}`);
  return Array.isArray(rows) ? rows.filter(r => r && isHex(r.transaction_id, 64)) : [];
}

/**
 * Submit a signed transaction (see toSubmitJson). Resent if the API hangs; a
 * resend that finds the first copy already in the mempool counts as success.
 * An answer that names another transaction says nothing about this one: it
 * throws, as the node client does.
 */
export async function submitTransaction(net: KaspaNetworkParams, json: string, expectedTxid: string): Promise<{ txid?: string; error?: string }> {
  let res: Res;
  try {
    res = await hedged(`${net.api}/transactions`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: json },
      { hedgeAt: [6_000, 15_000], deadline: 45_000 });
  } catch (e) {
    return { error: `${(e as Error).message} The payment may still have gone through; check Activity before trying again.` };
  }
  const d = res.data as { transactionId?: string; error?: unknown; detail?: unknown } | null;
  if (res.ok && d?.transactionId && isHex(d.transactionId, 64)) {
    // Another transaction's id is no answer for this one, refused as every other failure is: an error and no id.
    if (d.transactionId !== expectedTxid.toLowerCase()) return { error: `api.kaspa.org answered with transaction ${d.transactionId}, not this payment's ${expectedTxid}: whether it took the payment is unknown, so check Activity before trying again.` };
    return { txid: d.transactionId };
  }
  const detail = typeof d?.error === 'string' ? d.error : typeof d?.detail === 'string' ? d.detail : JSON.stringify(d?.detail ?? '');
  if (nodeHasTransaction(detail, expectedTxid)) return { txid: expectedTxid };
  return { error: detail && detail !== '""' ? detail : `Rejected (HTTP ${res.status}).` };
}
