// EVM JSON-RPC over the endpoints set for a chain (from Pearl Wallet's
// eth/rpc.ts, without its Flashbots route). Each endpoint must answer for the
// configured chain id before it is used, and again right before a send.

import { MAX_RPC_ANSWER_BYTES, readCappedJson } from '../lib/capped-read';
import { quoted } from '../lib/format';

export class RpcError extends Error {
  constructor(message: string, readonly code?: number, readonly data?: string) { super(message); }
}
export class WrongChain extends Error {}

/** Why an endpoint failed, for a message: an RPC's own words said as its own, quoted and cut (run 21 round 2, R21-W2-5). */
const failure = (e: unknown): string => (e instanceof RpcError ? `an RPC said ${quoted(e.message)}` : (e as Error)?.message ?? 'no endpoint');

export function isServerFault(e: unknown): boolean {
  if (!(e instanceof RpcError)) return true;
  if (e.code != null && [-32603, -32601, -32005, -32001, -32002, -32004, 429].includes(e.code)) return true;
  return /internal error|rate limit|limit exceeded|too many|timeout|temporar|unavailable|capacity|busy|header not found|upstream|not supported|method not found/i.test(e.message);
}

const big = (v: unknown): bigint | null => (typeof v === 'string' && /^0x[0-9a-f]+$/i.test(v) ? BigInt(v) : null);
export const hex = (n: bigint | number): string => '0x' + BigInt(n).toString(16);
/** Highest fee rate the wallet signs: 500 gwei. */
export const MAX_FEE_PER_GAS = 500_000_000_000n;
/** A tip up to this is signed even where the base fee is lower: 3 gwei. BNB Chain's base fee is 0, a test network's a few wei. */
export const TIP_FLOOR = 3_000_000_000n;
/**
 * The highest tip the wallet signs at a base fee: the base fee itself, or TIP_FLOOR where that is lower. A tip is
 * what the block producer keeps; honest ones are a fraction of the base fee, or a gwei or so on chains without one.
 */
export const tipCap = (baseFee: bigint): bigint => (baseFee > TIP_FLOOR ? baseFee : TIP_FLOOR);
/** BNB Chain, its test network and the local copy of it. */
const BNB_CHAINS = new Set([56, 97, 31338]);
/**
 * The least tip signed, whatever the endpoints say (round 15, R15-CL-1): one naming a tip of 0 would otherwise leave the
 * transaction unmined, and on BNB Chain (no base fee) with a fee cap of 0. Its validators take nothing under 0.05 gwei
 * since October 2025; elsewhere 0.01 gwei, a few cents at most for a deposit.
 */
export const minTip = (chainId: number): bigint => (BNB_CHAINS.has(chainId) ? 50_000_000n : 10_000_000n);

/** Endpoints that named base fees far apart: the highest and the lowest, by host. */
export interface FeeSpread { high: { host: string; baseFee: bigint }; low: { host: string; baseFee: bigint } }
const hostOf = (url: string): string => { try { return new URL(url).host; } catch { return url; } };
const gweiText = (wei: bigint): string => {
  const milli = (wei + 500_000n) / 1_000_000n; // in thousandths of a gwei, rounded
  return (milli % 1000n === 0n ? `${milli / 1000n}` : `${milli / 1000n}.${(milli % 1000n).toString().padStart(3, '0').replace(/0+$/, '')}`) + ' gwei';
};
const spreadText = (s: FeeSpread): string => `${s.high.host} names a base fee of ${gweiText(s.high.baseFee)}, ${s.low.host} ${gweiText(s.low.baseFee)}`;
/** What the screen says when the endpoints disagree about the base fee, or null when they don't. */
export function feeSpreadNote(name: string, s: FeeSpread | null | undefined): string | null {
  if (!s) return null;
  return `Your ${name} RPCs disagree about the network fee: ${spreadText(s)}. The higher is signed, so the transaction is not left unmined; only the real base fee and the tip are paid. If one of them is wrong, remove it under Network, Advanced.`;
}

export class EthRpc {
  private checked = new Set<string>();
  private id = 0;
  private turn = 0;

  constructor(private endpoints: string[], readonly chainId: number, readonly name: string, readonly gasSymbol: string,
    private fetcher: typeof fetch = (...a) => fetch(...a)) {
    if (endpoints.length === 0) throw new Error(`No RPC endpoint is set for ${name} (Settings).`);
  }

  private async raw<T>(url: string, method: string, params: unknown[]): Promise<T> {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 12_000);
    try {
      const res = await this.fetcher(url, {
        method: 'POST', signal: ctl.signal, headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: ++this.id, method, params }),
      });
      // Read with a limit (round 14, R14-CL-2): one that answers more is a server fault, and the next endpoint is asked.
      const j = await readCappedJson(res, MAX_RPC_ANSWER_BYTES) as { result?: T; error?: { message?: string; code?: number; data?: string } } | null;
      if (j?.error) throw new RpcError(j.error.message ?? 'RPC error', j.error.code, j.error.data);
      if (!res.ok || !j || !('result' in j)) throw new Error(`HTTP ${res.status}`);
      return j.result as T;
    } finally { clearTimeout(t); }
  }

  async checkChainAt(url: string): Promise<void> {
    const id = Number(await this.raw<string>(url, 'eth_chainId', []));
    if (id !== this.chainId) throw new WrongChain(`${url} answers for chain ${id}, not ${this.name} (${this.chainId})`);
  }

  private rotation(): string[] {
    const start = this.turn++ % this.endpoints.length;
    return [...this.endpoints.slice(start), ...this.endpoints.slice(0, start)];
  }

  async call<T>(method: string, params: unknown[]): Promise<T> {
    let last: unknown;
    for (const url of this.rotation()) {
      try {
        if (!this.checked.has(url)) { await this.checkChainAt(url); this.checked.add(url); }
        return await this.raw<T>(url, method, params);
      } catch (e) {
        if (e instanceof WrongChain) { last = e; continue; }
        // A refusal (only an RpcError is one): the RPC's own words, said as its own.
        if (!isServerFault(e)) throw new Error(`${this.name} refused it: ${failure(e)}`);
        last = e;
      }
    }
    throw new Error(`Could not reach ${this.name} (${failure(last)}).`);
  }

  /** Before signing: an endpoint asked now must answer for this chain; one that answers for another stops the send. */
  async assertChain(): Promise<void> {
    let last: unknown;
    for (const url of this.rotation()) {
      try { await this.checkChainAt(url); return; }
      catch (e) { if (e instanceof WrongChain) throw new Error(`${e.message}. Nothing was signed.`); last = e; }
    }
    throw new Error(`Could not reach ${this.name} (${failure(last)}).`);
  }

  ethCall(to: string, data: string, from?: string): Promise<string> {
    return this.call<string>('eth_call', [{ to, data, ...(from ? { from } : {}) }, 'latest']);
  }
  async balance(address: string): Promise<bigint> { return BigInt(await this.call<string>('eth_getBalance', [address, 'latest'])); }
  async nonce(address: string): Promise<number> { return Number(await this.call<string>('eth_getTransactionCount', [address, 'pending'])); }
  async estimateGas(tx: { from: string; to: string; data: string; value?: bigint }): Promise<bigint> {
    return BigInt(await this.call<string>('eth_estimateGas', [{ from: tx.from, to: tx.to, data: tx.data, value: hex(tx.value ?? 0n) }]));
  }

  /**
   * What one endpoint says about fees: the next base fee, and a tip (the median of recent blocks, or its own
   * suggestion if higher). Null for what it does not say; it throws when it can't be asked or answers for another chain.
   */
  private async feesAt(url: string): Promise<{ baseFee: bigint | null; tip: bigint | null }> {
    if (!this.checked.has(url)) { await this.checkChainAt(url); this.checked.add(url); }
    const [history, suggested] = await Promise.all([
      this.raw<{ baseFeePerGas?: unknown[]; reward?: unknown[][] } | null>(url, 'eth_feeHistory', [hex(10), 'latest', [50]]).catch(() => null),
      this.raw<string>(url, 'eth_maxPriorityFeePerGas', []).then(big).catch(() => null),
    ]);
    // The next block's base fee, but never under the latest block's own (the entry before it): an answer whose next
    // base fee falls far under the block it follows is not believed below that block (round 15, R15-CL-1).
    const fees = history?.baseFeePerGas ?? [];
    const next = big(fees[fees.length - 1]), latest = fees.length > 1 ? big(fees[fees.length - 2]) : null;
    let baseFee = next !== null && latest !== null && latest > next ? latest : next;
    if (baseFee === null) {
      const block = await this.raw<{ baseFeePerGas?: unknown } | null>(url, 'eth_getBlockByNumber', ['latest', false]).catch(() => null);
      baseFee = big(block?.baseFeePerGas);
    }
    const paid = (history?.reward ?? []).map(r => big(Array.isArray(r) ? r[0] : null)).filter((t): t is bigint => t !== null).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    let tip = paid.length ? paid[Math.floor(paid.length / 2)] : null;
    if (suggested !== null && (tip === null || suggested > tip)) tip = suggested;
    return { baseFee, tip };
  }

  /**
   * EIP-1559 fees: twice the next base fee plus a tip. Every endpoint is asked. The lowest tip is taken, so one endpoint
   * alone can't raise what is paid (round 10), held to tipCap and to minTip whatever they say. The highest base fee is
   * taken (round 15, R15-CL-1): one naming a low one would leave every transaction under the real base fee, unmined,
   * while a higher cap costs nothing, as only the real base fee and the tip are paid. Endpoints far apart are named in
   * `spread`, for the screen and for a refusal.
   */
  async fees(): Promise<{ maxFeePerGas: bigint; maxPriorityFeePerGas: bigint; baseFee: bigint; spread: FeeSpread | null }> {
    let last: unknown;
    const said = (await Promise.all(this.endpoints.map(url => this.feesAt(url).then(a => ({ url, ...a })).catch((e) => { last = e; return null; }))))
      .filter((a): a is { url: string; baseFee: bigint | null; tip: bigint | null } => a !== null);
    if (!said.length) throw new Error(`Could not reach ${this.name} (${failure(last)}).`);
    const lowest = (all: (bigint | null)[]): bigint | null => all.reduce<bigint | null>((m, v) => (v === null ? m : m === null || v < m ? v : m), null);
    const named = said.filter((a): a is { url: string; baseFee: bigint; tip: bigint | null } => a.baseFee !== null)
      .sort((a, b) => (a.baseFee < b.baseFee ? -1 : a.baseFee > b.baseFee ? 1 : 0));
    if (!named.length) throw new Error(`${this.name} gives no base fee; the wallet signs only EIP-1559 transactions.`);
    const low = named[0], high = named[named.length - 1];
    const baseFee = high.baseFee;
    // Far apart: more than twice (about six blocks of the steepest rise) and more than a gwei (noise on quiet chains).
    const spread: FeeSpread | null = high.baseFee > low.baseFee * 2n + 1_000_000_000n
      ? { high: { host: hostOf(high.url), baseFee: high.baseFee }, low: { host: hostOf(low.url), baseFee: low.baseFee } } : null;
    let tip = lowest(said.map(a => a.tip)) ?? 0n;
    const floor = minTip(this.chainId);
    if (tip < floor) tip = floor;
    // Held to the lowest base fee named, not the one signed: the tip is paid, and an endpoint naming a high base fee
    // must not lift the tip of the one endpoint that names a tip at all.
    const cap = tipCap(low.baseFee);
    if (tip > cap) tip = cap;
    const maxFeePerGas = baseFee * 2n + tip;
    // Refused, not signed at a lower base fee: the higher one may be the true one, and a lower cap would never be mined.
    if (maxFeePerGas > MAX_FEE_PER_GAS) {
      throw new Error(spread
        ? `${this.name} fees are extremely high by one RPC: ${spreadText(spread)}. Nothing was signed. If that one is wrong, remove it under Network, Advanced.`
        : `${this.name} fees are extremely high right now. Try again later.`);
    }
    return { maxFeePerGas, maxPriorityFeePerGas: tip, baseFee, spread };
  }

  async sendRaw(raw: string): Promise<string> {
    let last: unknown;
    for (const url of this.rotation()) {
      try { await this.checkChainAt(url); return await this.raw<string>(url, 'eth_sendRawTransaction', [raw]); }
      catch (e) {
        if (e instanceof WrongChain) throw new Error(`${e.message}. Nothing was sent.`);
        if (!isServerFault(e)) throw e;
        last = e;
      }
    }
    throw new Error(`Could not reach ${this.name} (${failure(last)}).`);
  }

  async receipt(hash: string): Promise<{ ok: boolean; block: number; logs: { address: string; topics: string[]; data: string }[] } | null> {
    const r = await this.call<{ status?: string; blockNumber?: string; logs?: { address: string; topics: string[]; data: string }[] } | null>('eth_getTransactionReceipt', [hash]);
    if (!r || !r.blockNumber) return null;
    return { ok: r.status === '0x1', block: Number(r.blockNumber), logs: r.logs ?? [] };
  }

  async knows(hash: string): Promise<boolean> {
    return (await this.call<unknown>('eth_getTransactionByHash', [hash])) != null;
  }
}
