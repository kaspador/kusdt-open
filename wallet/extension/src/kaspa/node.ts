// The Kaspa node the wallet reads coins from and submits to: the wRPC JSON
// endpoint set in Settings, or, when none is set (mainnet and testnet-10),
// one handed out by the public Kaspa node network's resolvers.
//
// The node is untrusted for safety: amounts are parsed exactly, every coin's
// script must be the script of the address it was asked about, and the node
// must say it serves the wallet's network with a UTXO index. A lying node can
// make a transaction fail; it can't redirect one, because every output is
// built from what the user approved and signatures commit to each spent coin.
//
// One thing it can do: lie about its network. Which network it serves is its
// own word, the wallet's keys are the same on every network, and a Kaspa
// signature names none. A node that says "testnet-10" and shows the user's
// mainnet coins could have real KAS sent as test KAS. A plain KAS send on
// Testnet therefore asks a mainnet node first whether its coins exist there
// (kaspa/kas.ts assertNotMainnetCoins). kUSDT and pool transactions spend a
// covenant coin that exists on one network only.

import { KaspaRpc, RpcError, RpcTooLargeError, scriptForAddress, bytesToHex } from '@kusdt/kaspa';
import { VerdictMemory, nodeMinableReads, receivingIn, sendingIn, spendsOutpoint, type Minability, type NodeCall } from '@kusdt/kaspa/minable';
import { resolveNode } from '@kusdt/kaspa/node';
import { KASPA_NETWORKS } from '@kusdt/kaspa';
import { isHex, toNat } from '../lib/bigint';
import { quoted } from '../lib/format';
import type { KaspaNetworkName } from '../config/defaults';

export interface NodeUtxo {
  address: string;
  transactionId: string;
  index: number;
  amount: bigint;
  /** Version (2 bytes, big-endian hex) followed by the script, as the core takes it. */
  scriptPublicKey: string;
  blockDaaScore: bigint;
  isCoinbase: boolean;
  covenantId: string | null;
}

/** An output of a transaction still in the mempool, paying one of the addresses asked about. */
export interface MempoolOutput {
  address: string;
  transactionId: string;
  index: number;
  amount: bigint;
  scriptPublicKey: string;
  covenantId: string | null;
}

/**
 * The mempool transactions around some outputs that no block can take (round 11, COV-1). A node admits a spend of an
 * unconfirmed output without checking its relative lock, so a spend of the pool can sit in ordinary nodes' mempools
 * that no block will ever take; those nodes then refuse every other spend of the pool for up to a day.
 * (Read in rusty-kaspa v2.1.0, not run on a node.)
 */
export interface MempoolJudged {
  /** Outputs ("txid:index") spent in the mempool by such a transaction: its id and why no block takes it. They are not on their way to being spent. */
  heldBy: Map<string, { txid: string; why: string }>;
  /** Such transactions among those that make a wanted output, by id, with why: their outputs are not built on. */
  unminable: Map<string, string>;
}

/** What the wallet needs from a node (tests hand in a fake). */
export interface KaspaNodeApi {
  readonly network: KaspaNetworkName;
  utxos(addresses: string[]): Promise<NodeUtxo[]>;
  mempoolOutputs(addresses: string[]): Promise<MempoolOutput[]>;
  /**
   * Whether the node's mempool holds transaction `txid`: asked by its id, so an address anyone has filled with
   * waiting transactions does not stop the answer (round 15, R15-CL-4). Throws when the node could not be asked.
   */
  inMempool(txid: string): Promise<boolean>;
  /** Outpoints ("txid:index") spent by transactions in the mempool, among those of `addresses`. */
  mempoolSpent(addresses: string[]): Promise<Set<string>>;
  /**
   * Which of the mempool transactions around `wanted` outputs (at `addresses`) no block can take (see MempoolJudged).
   * `accepted`: the DAA score each output the caller already found in the UTXO set was accepted at, by "txid:index".
   * That, and the coins this node client found itself before, is all an age is checked against: no address is listed
   * for it, and a transaction that claims an age for any other output counts as one no block can take (R12-WW-3).
   * Throws when the node could not be asked: the caller then builds on nothing the mempool shows. A node without
   * this judges nothing (tests' fakes).
   */
  mempoolJudged?(addresses: string[], wanted: { txid: string; index: number }[], accepted?: Map<string, bigint>): Promise<MempoolJudged>;
  feerate(): Promise<number>;
  virtualDaa(): Promise<bigint>;
  /**
   * Submits a transaction given as the node's own JSON (submitted untouched). Answers its id.
   * NodeRejected: the node refused it. NoAnswer: the request went out and no answer came.
   */
  submit(transactionJson: string): Promise<string>;
  close(): void;
}

/**
 * The node refused a transaction. `said`: its own words, which the wallet reads (whether it has the transaction already,
 * a lock not met). The message says they are the node's, quoted and cut (run 21, after R21-W2-5): a node, often a
 * public one, could otherwise put any text in the wallet's windows as the wallet's own.
 */
export class NodeRejected extends Error {
  constructor(readonly said: string, message = `The Kaspa node refused the transaction: it said ${quoted(said)}.`) { super(message); }
}

/**
 * The node answered a call with an error: its words (`said`) for the wallet to read, in a message that says whose they
 * are, quoted and cut. Still an RpcError, so whoever tells a node's refusal from no answer reads it as before.
 */
export class NodeError extends RpcError {
  constructor(method: string, readonly said: string) {
    super(method, said);
    this.message = `The Kaspa node's answer to ${method} was an error: ${quoted(said)}.`;
  }
}

/** The node got the request and never answered (a timeout, or the connection closing first): it may have the transaction. */
export class NoAnswer extends Error {}

/**
 * A transaction that may be on the network: it was submitted and the node
 * never answered. Never a plain failure: its inputs stay out of selection, it
 * goes in Activity, and the page and the user hear its id, so that a second
 * one is only ever an informed choice. `merge`: it was one of the merges a
 * send needs first, so the send itself didn't go out.
 */
export class MaybeSent extends Error {
  constructor(readonly txid: string, readonly merge = false) {
    super(`The Kaspa node did not answer, so transaction ${txid} may have been sent. It is followed in the wallet's Activity: check there before trying again.`);
  }
}

const MIN_FEERATE = 100;
const MAX_FEERATE = 2_000;
/** How many coins' acceptance scores the node client remembers from its own reads. */
const FOUND_MAX = 512;

/** "0000" + script hex, from a node's scriptPublicKey (a string, or {version, scriptPublicKey}). */
export function spkHexOf(spk: unknown): string {
  if (typeof spk === 'string' && isHex(spk) && spk.length >= 4) return spk;
  const o = spk as { version?: unknown; scriptPublicKey?: unknown } | null;
  if (o && typeof o.version === 'number' && isHex(o.scriptPublicKey)) return o.version.toString(16).padStart(4, '0') + o.scriptPublicKey;
  throw new Error('Unexpected script from the Kaspa node.');
}

const expectedSpk = (address: string, prefix: string) => {
  const s = scriptForAddress(address, prefix);
  return s.version.toString(16).padStart(4, '0') + bytesToHex(s.script);
};

export class KaspaNodeClient implements KaspaNodeApi {
  private rpc: Promise<KaspaRpc> | null = null;
  /** The public node the open connection goes to (empty with a configured node). */
  private current = '';
  /** Public nodes that timed out this session: the resolver is asked for another. */
  private readonly slow = new Set<string>();
  /** The verdicts on mempool transactions, kept between looks (R12-WW-3): the wallet looks every few seconds. */
  private readonly verdicts = new VerdictMemory();
  /**
   * The DAA score each coin was accepted at, for the coins this client found itself at addresses the wallet asked
   * about ("txid:index"): what a claimed age is checked against when the caller of mempoolJudged did not find the
   * coin in the same look. The newest few hundred.
   */
  private readonly found = new Map<string, bigint>();
  constructor(readonly network: KaspaNetworkName, private url: string, private readonly timeoutMs = 20_000) {}

  private get prefix() { return KASPA_NETWORKS[this.network].prefix; }

  private async pick(): Promise<string> {
    if (this.url) return this.url;
    const net = KASPA_NETWORKS[this.network];
    try { return await resolveNode(net, this.slow); }
    catch (e) {
      // Every node the resolvers know timed out once: try them all again rather than none.
      if (!this.slow.size) throw e;
      this.slow.clear();
      return resolveNode(net);
    }
  }

  private connect(): Promise<KaspaRpc> {
    this.rpc ??= (async () => {
      const url = await this.pick();
      this.current = this.url ? '' : url;
      const rpc = await new KaspaRpc(url, this.timeoutMs).connect();
      const info = await rpc.call<{ networkId?: string; hasUtxoIndex?: boolean; isSynced?: boolean }>('getServerInfo', {}).catch((e: unknown) => {
        throw e instanceof RpcError && !(e instanceof RpcTooLargeError) && e.message !== 'getServerInfo: timed out' ? new NodeError('getServerInfo', e.message) : e;
      });
      const problem = info?.networkId !== this.network ? `The Kaspa node serves ${info?.networkId == null ? 'an unknown network' : quoted(String(info.networkId), 40)}, not ${this.network}.`
        : info.hasUtxoIndex !== true ? 'The Kaspa node has no UTXO index.'
        // A local simnet without recent blocks reports itself unsynced; it is still usable.
        : this.network !== 'simnet' && info.isSynced !== true ? 'The Kaspa node is not synced yet.'
        : null;
      if (problem) { rpc.close(); throw new Error(problem); }
      return rpc;
    })();
    this.rpc.catch(() => { this.rpc = null; });
    return this.rpc;
  }

  /**
   * A call on the open connection. A node's refusal keeps it. A lost connection, or
   * a timeout (a node that went silent, or one too slow to answer), drops it: a
   * timed-out public node is skipped for the session, and a read is asked once
   * more on a fresh connection. A transaction is never sent twice by itself.
   */
  private async call<T>(method: string, params: object | string = {}, retry = true): Promise<T> {
    const rpc = await this.connect();
    try { return await rpc.call<T>(method, params); }
    catch (e) {
      // A timeout is the client's own "<method>: timed out", word for word: a node's error answer that only ends so is
      // the node's, and said as its own like any other.
      const timedOut = e instanceof RpcError && e.message === `${method}: timed out`;
      if (!(e instanceof RpcError) || timedOut) {
        if (this.rpc) this.rpc = null;
        rpc.close();
        if (timedOut && this.current) this.slow.add(this.current);
        if (timedOut && retry && method !== 'submitTransaction') return this.call<T>(method, params, false);
        // The connection was up, so the request went out and nothing came back ("not connected": it never left).
        if (method === 'submitTransaction' && (e as Error).message !== 'not connected') throw new NoAnswer((e as Error).message);
        throw e;
      }
      // The node's answer was an error (or one too long to read, said as the client words it): its words are its own.
      throw e instanceof RpcTooLargeError ? e : new NodeError(method, e.message);
    }
  }

  async utxos(addresses: string[]): Promise<NodeUtxo[]> {
    if (addresses.length === 0) return [];
    const asked = new Set(addresses);
    const res = await this.call<{ entries?: any[] }>('getUtxosByAddresses', { addresses });
    if (!Array.isArray(res?.entries)) throw new Error('Unexpected answer from the Kaspa node.');
    const seen = new Set<string>();
    const out: NodeUtxo[] = [];
    for (const e of res.entries) {
      const txid = e?.outpoint?.transactionId, index = e?.outpoint?.index;
      if (!asked.has(e?.address) || !isHex(txid, 64) || !Number.isInteger(index) || index < 0) throw new Error('Unexpected coin data from the Kaspa node.');
      const spk = spkHexOf(e.utxoEntry?.scriptPublicKey);
      if (spk !== expectedSpk(e.address, this.prefix)) throw new Error('The Kaspa node returned a coin that does not match its address.');
      const covenantId = e.utxoEntry?.covenantId ?? null;
      if (covenantId !== null && !isHex(covenantId, 64)) throw new Error('Unexpected covenant ID from the Kaspa node.');
      const key = `${txid}:${index}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({
        address: e.address, transactionId: txid, index, amount: toNat(e.utxoEntry.amount, 'amount'),
        scriptPublicKey: spk, blockDaaScore: toNat(e.utxoEntry.blockDaaScore ?? 0, 'DAA score'),
        isCoinbase: e.utxoEntry.isCoinbase === true, covenantId,
      });
    }
    // The last of a long list are the ones kept: an address anyone has filled does not grow this.
    for (const u of out.slice(-FOUND_MAX)) { this.found.delete(`${u.transactionId}:${u.index}`); this.found.set(`${u.transactionId}:${u.index}`, u.blockDaaScore); }
    while (this.found.size > FOUND_MAX) this.found.delete(this.found.keys().next().value as string);
    return out;
  }

  private async mempool(addresses: string[]): Promise<any[]> {
    if (addresses.length === 0) return [];
    const res = await this.call<{ entries?: any[] }>('getMempoolEntriesByAddresses', { addresses, includeOrphanPool: false, filterTransactionPool: false });
    return Array.isArray(res?.entries) ? res.entries : [];
  }

  async mempoolOutputs(addresses: string[]): Promise<MempoolOutput[]> {
    const asked = new Set(addresses);
    const out: MempoolOutput[] = [];
    for (const entry of await this.mempool(addresses)) {
      if (!asked.has(entry?.address)) continue;
      const want = expectedSpk(entry.address, this.prefix);
      for (const r of entry.receiving ?? []) {
        const tx = r?.transaction;
        const txid = tx?.verboseData?.transactionId;
        if (!isHex(txid, 64) || !Array.isArray(tx?.outputs)) continue;
        tx.outputs.forEach((o: any, index: number) => {
          let spk: string;
          try { spk = spkHexOf(o?.scriptPublicKey); } catch { return; }
          if (spk !== want) return;
          const covenantId = o?.covenant?.covenantId ?? null;
          if (covenantId !== null && !isHex(covenantId, 64)) return;
          out.push({ address: entry.address, transactionId: txid, index, amount: toNat(o.value, 'amount'), scriptPublicKey: spk, covenantId });
        });
      }
    }
    return out;
  }

  async inMempool(txid: string): Promise<boolean> {
    try {
      const r = await this.call<{ mempoolEntry?: { transaction?: unknown } }>('getMempoolEntry', { transactionId: txid, includeOrphanPool: false, filterTransactionPool: false });
      return !!r?.mempoolEntry?.transaction;
    } catch (e) {
      // The node's refusal for a transaction it does not hold is "Transaction <id> not found" (rusty-kaspa v2.1.0
      // rpc/core/src/error.rs, as bridge/packages/kaspa/src/minable.ts reads it). Any other failure is no answer.
      if (e instanceof NodeError && /not found/i.test(e.said)) return false;
      throw e;
    }
  }

  async mempoolSpent(addresses: string[]): Promise<Set<string>> {
    const spent = new Set<string>();
    for (const entry of await this.mempool(addresses)) {
      for (const s of entry?.sending ?? []) {
        for (const i of s?.transaction?.inputs ?? []) {
          const p = i?.previousOutpoint;
          if (isHex(p?.transactionId, 64) && Number.isInteger(p?.index)) spent.add(`${p.transactionId}:${p.index}`);
        }
      }
    }
    return spent;
  }

  async mempoolJudged(addresses: string[], wanted: { txid: string; index: number }[], accepted?: Map<string, bigint>): Promise<MempoolJudged> {
    const heldBy = new Map<string, { txid: string; why: string }>(), unminable = new Map<string, string>();
    if (addresses.length === 0 || wanted.length === 0) return { heldBy, unminable };
    const answer = { entries: await this.mempool(addresses) };
    const call: NodeCall = (method, params) => this.call(method, params);
    // No address is listed to learn an output's age: only what the caller found in this look, or this client before it.
    const reads = nodeMinableReads(call, (o) => accepted?.get(`${o.transactionId}:${o.index}`) ?? this.found.get(`${o.transactionId}:${o.index}`));
    const known = new Map<string, Minability>();
    // Only the transactions that touch a wanted output are judged: anyone can pay these addresses, and each check asks the node.
    for (const s of sendingIn(answer)) {
      const spends = wanted.filter(w => spendsOutpoint(s.tx, { transactionId: w.txid, index: w.index }));
      if (!spends.length) continue;
      const v = await this.verdicts.judge(s.txid, s.tx, reads, { known });
      if (!v.minable) for (const w of spends) heldBy.set(`${w.txid}:${w.index}`, { txid: s.txid, why: v.why });
    }
    const made = new Set(wanted.map(w => w.txid));
    for (const r of receivingIn(answer)) {
      if (!made.has(r.txid)) continue;
      const v = await this.verdicts.judge(r.txid, r.tx, reads, { known });
      if (!v.minable) unminable.set(r.txid, v.why);
    }
    return { heldBy, unminable };
  }

  async feerate(): Promise<number> {
    try {
      const r = await this.call<{ estimate?: { normalBuckets?: { feerate?: number }[]; priorityBucket?: { feerate?: number } } }>('getFeeEstimate', {});
      const f = r?.estimate?.normalBuckets?.[0]?.feerate ?? r?.estimate?.priorityBucket?.feerate;
      return clampFeerate(f);
    } catch { return MIN_FEERATE; }
  }

  async virtualDaa(): Promise<bigint> {
    const r = await this.call<{ virtualDaaScore?: unknown }>('getBlockDagInfo', {});
    return toNat(r?.virtualDaaScore, 'DAA score');
  }

  async submit(transactionJson: string): Promise<string> {
    let r: { transactionId?: string };
    try { r = await this.call<{ transactionId?: string }>('submitTransaction', `{"transaction":${transactionJson},"allowOrphan":false}`); }
    catch (e) { if (e instanceof RpcError) throw new NodeRejected(e instanceof NodeError ? e.said : e.message); throw e; }
    if (!isHex(r?.transactionId, 64)) throw new Error('Unexpected answer from the Kaspa node.');
    return r.transactionId;
  }

  close(): void {
    const r = this.rpc;
    this.rpc = null;
    r?.then(x => x.close()).catch(() => {});
  }
}

export function clampFeerate(f: unknown): number {
  if (typeof f !== 'number' || !Number.isFinite(f)) return MIN_FEERATE;
  return Math.min(MAX_FEERATE, Math.max(MIN_FEERATE, Math.ceil(f)));
}

/** Whether a node's refusal says an input is gone (spent, or spent in the mempool). */
export const isSpentInputError = (message: string): boolean =>
  /double spend|already spent|missing outpoint|orphan|not found in the utxo|output .* spent|is spent/i.test(message);
