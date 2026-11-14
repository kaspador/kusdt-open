// Direct connection to a public Kaspa node, for the calls that need the node
// itself: coins (UTXOs), fee rate, DAA score, and submitting payments.
//
// The nodes are the Public Node Network that Kaspa's own SDK, Kaspa NG and
// KasWare use. A resolver (kaspa.stream, kaspa.red, kaspa.green, kaspa.blue;
// the list is rusty-kaspa's Resolvers.toml) hands out a node, and the wallet
// talks to it over wRPC with JSON encoding on one WebSocket. A call takes
// about 150 ms once connected.
//
// Like the REST API, a node is untrusted: amounts are parsed exactly, every
// coin's script must match its address, and the node must report itself
// synced, on the right network, with a UTXO index. A node that lies can make
// a payment fail, never redirect it: outputs are built from what the user
// typed, and signatures commit to each spent coin's amount and script.

declare const chrome: any; // present only inside the browser extension

import { parseExactJson } from './exactJson';
import { nodeHasTransaction } from './rpc';
import { hexToBytes } from './bytes';
import { scriptForAddress } from './address';
import type { KaspaNetworkParams } from './network';
import type { KaspaUtxo } from './tx';

const RESOLVERS = [
  'eric.kaspa.stream', 'maxim.kaspa.stream', 'sean.kaspa.stream', 'troy.kaspa.stream',
  'john.kaspa.red', 'mike.kaspa.red', 'paul.kaspa.red', 'alex.kaspa.red',
  'jake.kaspa.green', 'mark.kaspa.green', 'adam.kaspa.green', 'liam.kaspa.green',
  'noah.kaspa.blue', 'ryan.kaspa.blue', 'jack.kaspa.blue', 'luke.kaspa.blue',
];
/** For tests: forget which resolvers failed. */
export function resetResolverBackoff(): void { resolverDown.clear(); }

const NODE_HOST = /^[a-z0-9-]+\.kaspa\.(stream|red|green|blue)$/;
const CALL_TIMEOUT_MS = 6_000;

const shuffled = <T>(a: T[]) => a.map(v => [Math.random(), v] as const).sort((x, y) => x[0] - y[0]).map(x => x[1]);

/** How long a resolver that failed to answer is left out (ms). */
export const RESOLVER_BACKOFF_MS = 10 * 60_000;
/** A resolver's answer is a node's URL in a little JSON: one longer than this is no answer. */
const RESOLVER_ANSWER_MAX = 16_384;

/**
 * A resolver's answer, read no further than RESOLVER_ANSWER_MAX bytes (Daybreak [4]). It was read whole (and inflated,
 * if the server compressed it) before anything looked at it, so one resolver could fill the page's or the wallet's
 * memory with an answer that never ends. Past the bound the read is stopped and the answer refused.
 */
async function resolverAnswer(r: Response): Promise<unknown> {
  if (!r.body) throw new Error('no resolver answer');
  if (Number(r.headers.get('content-length') ?? 0) > RESOLVER_ANSWER_MAX) {
    await r.body.cancel().catch(() => {});
    throw new Error('resolver answer too long');
  }
  const reader = r.body.getReader();
  const decoder = new TextDecoder();
  let size = 0, text = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > RESOLVER_ANSWER_MAX) {
      await reader.cancel().catch(() => {});
      throw new Error('resolver answer too long');
    }
    text += decoder.decode(value, { stream: true });
  }
  return JSON.parse(text + decoder.decode());
}

/** Resolvers that failed recently, and until when they are left out (per page or service). */
const resolverDown = new Map<string, number>();

/**
 * Ask resolvers (three at a time, first answer wins) for a node's JSON wRPC URL.
 * A resolver that fails (down, an error page, a bad answer) is left out for
 * RESOLVER_BACKOFF_MS, so a page that polls doesn't ask a dead one every time.
 * If every resolver failed recently, they are all asked again.
 */
export async function resolveNode(net: KaspaNetworkParams, avoid: ReadonlySet<string> = new Set(), now = Date.now()): Promise<string> {
  const ask = async (host: string): Promise<string> => {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 4_000);
    try {
      const r = await fetch(`https://${host}/v2/kaspa/${net.name}/tls/wrpc/borsh`, { cache: 'no-store', signal: ctrl.signal })
        .catch((e) => { resolverDown.set(host, now + RESOLVER_BACKOFF_MS); throw e; });
      if (!r.ok) { resolverDown.set(host, now + RESOLVER_BACKOFF_MS); throw new Error(`resolver ${host} answered ${r.status}`); }
      const d = await resolverAnswer(r).catch((e) => { resolverDown.set(host, now + RESOLVER_BACKOFF_MS); throw e; }) as { url?: unknown };
      const u = typeof d?.url === 'string' ? new URL(d.url) : null;
      // The network hands out Borsh endpoints; the same node serves JSON next to it.
      if (!u || u.protocol !== 'wss:' || !NODE_HOST.test(u.hostname) || !u.pathname.endsWith('/wrpc/borsh')) throw new Error('bad node');
      const url = `wss://${u.hostname}${u.pathname.replace(/\/wrpc\/borsh$/, '/wrpc/json')}`;
      if (avoid.has(url)) throw new Error('avoided node');
      return url;
    } finally { clearTimeout(t); }
  };
  const up = RESOLVERS.filter((h) => (resolverDown.get(h) ?? 0) <= now);
  const order = shuffled(up.length ? up : RESOLVERS);
  for (let i = 0; i < order.length; i += 3) {
    try { return await Promise.any(order.slice(i, i + 3).map(ask)); } catch { /* next three */ }
  }
  throw new Error('No public Kaspa node is reachable.');
}

// Integers too large for a JS number (amounts above 2^53 sompi) come through exact.
export function parseExact(text: string): unknown {
  return parseExactJson(text);
}

type Pending = { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> };

export class KaspaNode {
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private closed = false;

  private constructor(private ws: WebSocket, readonly url: string) {
    ws.onmessage = (m) => this.onMessage(String(m.data));
    ws.onclose = () => this.fail(new Error('Connection to the Kaspa node closed.'));
    ws.onerror = () => this.fail(new Error('Connection to the Kaspa node failed.'));
  }

  static open(url: string, timeoutMs = 5_000): Promise<KaspaNode> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url);
      const t = setTimeout(() => { try { ws.close(); } catch { /* ignore */ } reject(new Error('Kaspa node did not answer.')); }, timeoutMs);
      ws.onopen = () => { clearTimeout(t); resolve(new KaspaNode(ws, url)); };
      ws.onerror = () => { clearTimeout(t); reject(new Error('Could not connect to the Kaspa node.')); };
    });
  }

  get alive(): boolean { return !this.closed && this.ws.readyState === WebSocket.OPEN; }

  private onMessage(text: string) {
    let msg: { id?: number; params?: unknown; error?: { message?: string } };
    try { msg = parseExact(text) as typeof msg; } catch { return; }
    const p = typeof msg.id === 'number' ? this.pending.get(msg.id) : undefined;
    if (!p) return;   // notifications and unknown ids are ignored
    this.pending.delete(msg.id!);
    clearTimeout(p.timer);
    if (msg.error) p.reject(new RpcError(typeof msg.error.message === 'string' ? msg.error.message : 'Kaspa node error.'));
    else p.resolve(msg.params);
  }

  private fail(e: Error) {
    if (this.closed) return;
    this.closed = true;
    for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(e); }
    this.pending.clear();
  }

  close() { this.fail(new Error('closed')); try { this.ws.close(); } catch { /* ignore */ } }

  /** One call; `paramsJson` is sent as is (already-serialized JSON), so exact integers survive. */
  call<T>(method: string, paramsJson = '{}', timeoutMs = CALL_TIMEOUT_MS): Promise<T> {
    if (!this.alive) return Promise.reject(new Error('Not connected to a Kaspa node.'));
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error('Kaspa node took too long to answer.'));
        this.close();   // a stuck connection is not reused
      }, timeoutMs);
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer });
      this.ws.send(`{"id":${id},"method":"${method}","params":${paramsJson}}`);
    });
  }
}

/** An answer from the node itself (as opposed to a lost connection): never retried elsewhere. */
export class RpcError extends Error {}

// ── One shared connection per popup ─────────────────────────────────────────
let conn: { net: string; node: Promise<KaspaNode> } | null = null;
// Nodes that just failed us, skipped for a minute.
const badUntil = new Map<string, number>();
const markBad = (url: string) => { badUntil.set(url, Date.now() + 60_000); };
const badNodes = (): Set<string> => {
  const now = Date.now();
  for (const [u, t] of badUntil) if (t <= now) badUntil.delete(u);
  return new Set(badUntil.keys());
};

// The last node that worked, kept for the browser session so reopening the
// popup skips the resolver round trip. chrome.storage.session is memory only.
const LAST_NODE_KEY = 'pearl.kas.node';
async function rememberedNode(net: KaspaNetworkParams): Promise<string | null> {
  try {
    const v = (await chrome.storage.session.get(LAST_NODE_KEY))[LAST_NODE_KEY] as { net?: string; url?: string } | undefined;
    if (v?.net !== net.name || typeof v.url !== 'string') return null;
    const u = new URL(v.url);
    return u.protocol === 'wss:' && NODE_HOST.test(u.hostname) ? v.url : null;
  } catch { return null; }   // no chrome.storage (tests) or not allowed
}
function rememberNode(net: KaspaNetworkParams, url: string) {
  try { chrome.storage.session.set({ [LAST_NODE_KEY]: { net: net.name, url } }).catch(() => {}); } catch { /* no storage */ }
}

async function connectChecked(net: KaspaNetworkParams): Promise<KaspaNode> {
  let lastErr: Error = new Error('No public Kaspa node is reachable.');
  const last = await rememberedNode(net);
  for (let attempt = 0; attempt < 3; attempt++) {
    let url: string;
    if (attempt === 0 && last && !badNodes().has(last)) url = last;
    else {
      try { url = await resolveNode(net, badNodes()); } catch (e) { lastErr = e as Error; break; }
    }
    try {
      const node = await KaspaNode.open(url);
      const info = await node.call<{ isSynced?: boolean; hasUtxoIndex?: boolean; networkId?: string }>('getServerInfo', '{}', 4_000);
      if (info?.isSynced === true && info?.hasUtxoIndex === true && info?.networkId === net.name) {
        rememberNode(net, url);
        return node;
      }
      node.close();
      lastErr = new Error('The Kaspa node was not ready.');
    } catch (e) { lastErr = e as Error; }
    markBad(url);
  }
  throw lastErr;
}

/** The shared node connection, opened (or reopened) on demand. */
export async function getNode(net: KaspaNetworkParams): Promise<KaspaNode> {
  if (conn && conn.net === net.name) {
    try {
      const n = await conn.node;
      if (n.alive) return n;
    } catch { /* reconnect below */ }
  }
  const node = connectChecked(net);
  conn = { net: net.name, node };
  node.catch(() => { if (conn?.node === node) conn = null; });
  return node;
}

/** Run a call on the shared node; a dead or stuck node is replaced once. */
export async function nodeCall<T>(net: KaspaNetworkParams, method: string, paramsJson = '{}'): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    const node = await getNode(net);
    try { return await node.call<T>(method, paramsJson); }
    catch (e) {
      if (e instanceof RpcError || attempt >= 1) throw e;
      markBad(node.url);
      node.close();
    }
  }
}

export function closeNode(): void {
  const c = conn;
  conn = null;
  badUntil.clear();
  c?.node.then(n => n.close()).catch(() => {});
}

// ── The calls the wallet makes ───────────────────────────────────────────────

const toBig = (v: unknown): bigint => {
  if (typeof v === 'string' && /^\d+$/.test(v)) return BigInt(v);
  if (typeof v === 'number' && Number.isSafeInteger(v) && v >= 0) return BigInt(v);
  throw new Error('Unexpected number from the Kaspa node.');
};
const hexOk = (s: unknown, len?: number): s is string =>
  typeof s === 'string' && /^[0-9a-f]*$/.test(s) && s.length % 2 === 0 && (len == null || s.length === len);

/** Coins of `addresses`, checked like the REST client checks them. */
export async function nodeUtxos(net: KaspaNetworkParams, addresses: string[]): Promise<KaspaUtxo[]> {
  if (addresses.length === 0) return [];
  type Entry = { address: string; outpoint: { transactionId: string; index: number }; utxoEntry: { amount: unknown; scriptPublicKey: string; blockDaaScore: unknown; isCoinbase: boolean } };
  const asked = new Set(addresses);
  const res = await nodeCall<{ entries?: Entry[] }>(net, 'getUtxosByAddresses', JSON.stringify({ addresses }));
  if (!Array.isArray(res?.entries)) throw new Error('Unexpected answer from the Kaspa node.');
  const out: KaspaUtxo[] = [];
  const seen = new Set<string>();
  for (const e of res.entries) {
    const txid = e?.outpoint?.transactionId, index = e?.outpoint?.index, spk = e?.utxoEntry?.scriptPublicKey;
    if (!asked.has(e?.address) || !hexOk(txid, 64) || !Number.isInteger(index) || index < 0 || index > 0xffffffff || !hexOk(spk) || spk.length < 4) {
      throw new Error('Unexpected coin data from the Kaspa node.');
    }
    // "0000" + script: version 0, then the locking script, which must be this address's.
    const expected = scriptForAddress(e.address, net.prefix);
    const expectedHex = '0000' + Array.from(expected.script, b => b.toString(16).padStart(2, '0')).join('');
    if (spk !== expectedHex) throw new Error('The Kaspa node returned a coin that does not match its address.');
    const key = `${txid}:${index}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      txid, index, amount: toBig(e.utxoEntry.amount),
      script: { version: 0, script: hexToBytes(spk.slice(4)) },
      blockDaaScore: toBig(e.utxoEntry.blockDaaScore), isCoinbase: e.utxoEntry.isCoinbase === true, address: e.address,
    });
  }
  return out;
}

export async function nodeFeerate(net: KaspaNetworkParams): Promise<number | null> {
  const r = await nodeCall<{ estimate?: { normalBuckets?: { feerate?: number }[]; priorityBucket?: { feerate?: number } } }>(net, 'getFeeEstimate');
  const f = r?.estimate?.normalBuckets?.[0]?.feerate ?? r?.estimate?.priorityBucket?.feerate;
  return typeof f === 'number' && Number.isFinite(f) && f > 0 ? f : null;
}

export async function nodeVirtualDaaScore(net: KaspaNetworkParams): Promise<bigint | null> {
  const r = await nodeCall<{ virtualDaaScore?: unknown; isSynced?: boolean }>(net, 'getServerInfo');
  return r?.virtualDaaScore != null ? toBig(r.virtualDaaScore) : null;
}

/**
 * Submit a signed transaction (`txJson` from toRpcTransactionJson). Returns the
 * id, or throws RpcError when the node rejected it. A resend that finds the
 * payment already in the mempool counts as sent. An answer that names another
 * transaction says nothing about this one: it throws, as any unexpected answer.
 */
export async function nodeSubmit(net: KaspaNetworkParams, txJson: string, expectedTxid: string): Promise<string> {
  try {
    const r = await nodeCall<{ transactionId?: string }>(net, 'submitTransaction', `{"transaction":${txJson},"allowOrphan":false}`);
    if (!hexOk(r?.transactionId, 64)) throw new Error('Unexpected answer from the Kaspa node.');
    if (r.transactionId !== expectedTxid.toLowerCase()) throw new Error(`The Kaspa node answered with transaction ${r.transactionId}, not ${expectedTxid}.`);
    return r.transactionId;
  } catch (e) {
    if (e instanceof RpcError && nodeHasTransaction(e.message, expectedTxid)) return expectedTxid;
    throw e;
  }
}
