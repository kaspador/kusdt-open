// The coordinator's public API (SPEC §13). Read-mostly and untrusted: the
// wallet uses it to find things (its token states, the pool, the status of a
// deposit or a redemption) and checks everything that matters against the
// Kaspa node and the core before it is shown or spent (kusdt/verify.ts).
//
// Amounts are JSON integers, some above 2^53: answers are parsed exactly.

import { parseExactJson } from '@kusdt/kaspa';
import { CHAIN_CODE, type ChainKey } from '../config/defaults';
import { AnswerTooLong, MAX_API_ANSWER_BYTES, readCapped } from '../lib/capped-read';
import { quoted } from '../lib/format';

export interface ApiUtxo {
  transactionId: string;
  index: number;
  amount?: unknown;
  scriptPublicKey?: unknown;
  blockDaaScore?: unknown;
  covenantId?: unknown;
}
export interface ApiLocated<S = unknown> { utxo: ApiUtxo; state: S }

export interface ApiFees { feeBps?: unknown; minDepositFee?: unknown; minReleaseFee?: unknown }

export interface CoordinatorApi {
  status(): Promise<any>;
  /**
   * The owner's kUSDT states. `unread`: the coordinator's records of states at an address the node cannot answer
   * for (too many coins to read): neither shown as there nor as gone (round 13, R13-CL-1). An answer with them is not
   * a full list.
   */
  tokens(owner: string): Promise<{ states: ApiLocated[]; unread?: ApiLocated[] }>;
  /**
   * The newest pool and reserve (mempool included), the last confirmed ones, and prices (SPEC §13).
   * `reserve` is null before the pool's first deposit. The wallet checks the pool itself and computes
   * the circuit breaker with the core, so `breaker` and `paused` here are never relied on.
   */
  pool(): Promise<{ pool: ApiLocated; reserve: ApiLocated | null; pending?: string[]; confirmed?: { pool: ApiLocated; reserve: ApiLocated | null }; prices?: { kasInKusdt?: unknown; kusdtInKas?: unknown }; tvlKas?: unknown }>;
  /**
   * The body of the transaction `txid` that made the pool's reserve (R21-POOL-1), when /pool names it (`reserve.made`):
   * checked against its id before it is believed (kusdt/verify.ts). Throws when the coordinator does not hold it. A
   * client that cannot ask lacks it (tests' fakes).
   */
  poolMade?(txid: string): Promise<unknown>;
  /** Liquidity positions of an owner, each in the node's UTXO set (checked again by the wallet). */
  positions(owner: string): Promise<{ positions: ApiLocated[]; unread?: ApiLocated[] }>;
  deposit(chain: ChainKey, nonce: bigint): Promise<any>;
  postRedeem(body: { transaction: string; transactionId: string } | { txid: string; outputIndex: number; chain: number; address: string }): Promise<{ redeems?: { redeemId?: string; status?: string }[] }>;
  redeem(txid: string, outputIndex: number): Promise<any>;
  /** Whether the vault on `chain` would pay `address` (SPEC §9, §13): asked before every burn. */
  recipient(chain: ChainKey, address: string): Promise<any>;
}

export class ApiError extends Error {
  constructor(message: string, readonly status: number) { super(message); }
}

export class CoordinatorClient implements CoordinatorApi {
  constructor(private base: string, private fetcher: typeof fetch = (...a) => fetch(...a)) {
    if (!base) throw new Error('No coordinator API is set for this network (Settings).');
    this.base = base.replace(/\/+$/, '');
  }

  private async req(path: string, init?: RequestInit & { rawBody?: string }): Promise<any> {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 15_000);
    try {
      const res = await this.fetcher(this.base + path, {
        method: init?.method ?? 'GET', signal: ctl.signal, cache: 'no-store',
        headers: init?.rawBody ? { 'content-type': 'application/json' } : undefined,
        body: init?.rawBody,
      });
      // Never more of an answer than its largest honest one (round 14, R14-CL-2).
      const text = await readCapped(res, MAX_API_ANSWER_BYTES);
      let data: any = null;
      try { data = text ? parseExactJson(text) : null; } catch { /* not JSON */ }
      // Its own words are said as its own, quoted and cut (run 21 round 2, R21-W2-5): this text reaches the wallet's windows.
      if (!res.ok) throw new ApiError(`The coordinator answered HTTP ${res.status}${typeof data?.error === 'string' ? `: ${quoted(data.error)}` : '.'}`, res.status);
      return data;
    } catch (e) {
      if (e instanceof ApiError) throw e;
      if (e instanceof AnswerTooLong) throw new Error('The coordinator API answered more than the wallet reads: refused.');
      throw new Error('Could not reach the coordinator API.');
    } finally { clearTimeout(t); }
  }

  status() { return this.req('/status'); }
  async tokens(owner: string) {
    const d = await this.req(`/tokens?owner=${encodeURIComponent(owner)}`);
    return { states: Array.isArray(d?.states) ? d.states : [], unread: Array.isArray(d?.unread) ? d.unread : [] };
  }
  pool() { return this.req('/pool'); }
  async poolMade(txid: string) { return (await this.req(`/pool/made/${encodeURIComponent(txid)}`))?.made; }
  async positions(owner: string) {
    const d = await this.req(`/positions?owner=${encodeURIComponent(owner)}`);
    return { positions: Array.isArray(d?.positions) ? d.positions : [], unread: Array.isArray(d?.unread) ? d.unread : [] };
  }
  deposit(chain: ChainKey, nonce: bigint) { return this.req(`/deposits/${chain}/${nonce}`); }
  redeem(txid: string, outputIndex: number) { return this.req(`/redeems/${txid}/${outputIndex}`); }
  /** By chain code: exactly what the burn owner commits to (SPEC §9). */
  recipient(chain: ChainKey, address: string) { return this.req(`/recipients/${CHAIN_CODE[chain]}/${encodeURIComponent(address)}`); }

  /**
   * `{transaction}` carries the node JSON of a submitted burn, inserted as is
   * (it was built by the core and its integers must stay exact). The core's
   * JSON has no verboseData, so the id goes with it as `transactionId`, which
   * the coordinator requires (bridge/services/src/coordinator/api.ts).
   */
  postRedeem(body: { transaction: string; transactionId: string } | { txid: string; outputIndex: number; chain: number; address: string }) {
    const raw = 'transaction' in body ? `{"transaction":${body.transaction},"transactionId":${JSON.stringify(body.transactionId)}}` : JSON.stringify(body);
    return this.req('/redeems', { method: 'POST', rawBody: raw });
  }
}

/** Whether the guardian has paused minting on Kaspa, as `/status` says (what the web app's banner reads). */
export const minterPaused = (status: any): boolean => status?.kaspa?.minter?.state?.paused === true;

export interface ChainFees { feeBps: bigint; minDepositFee: bigint; minReleaseFee: bigint }

// At most 80 digits (Daybreak [38]): a coordinator's string of millions of digits would hold the wallet in BigInt for
// seconds, and no amount comes near 80 digits.
const nat = (v: unknown): bigint | null => {
  if (typeof v === 'number' && Number.isSafeInteger(v) && v >= 0) return BigInt(v);
  if (typeof v === 'string' && /^\d{1,80}$/.test(v)) return BigInt(v);
  return null;
};

/**
 * A chain's fees from `/status`. SPEC §13 only says the answer has "fees";
 * the wallet accepts the shapes a coordinator may reasonably give:
 *   fees.<chain>.{feeBps, minDepositFee, minReleaseFee}
 *   fees.{feeBps, minDepositFee: n | {<chain>: n}, minReleaseFee: n | {<chain>: n}}
 *   chains[i].fees (the chain's own entry), matched by `chain` (1, 2, "ethereum", "bsc")
 * and null when none fits.
 */
export function chainFees(status: any, chain: ChainKey): ChainFees | null {
  const code = chain === 'ethereum' ? 1 : 2;
  const pick = (o: any, k: string) => (o && typeof o === 'object' && !Array.isArray(o) && k in o ? nat(o[k]) ?? nat(o[k]?.[chain]) : null);
  const tryObj = (o: any): ChainFees | null => {
    const feeBps = pick(o, 'feeBps'), minDepositFee = pick(o, 'minDepositFee'), minReleaseFee = pick(o, 'minReleaseFee');
    return feeBps != null && minDepositFee != null && minReleaseFee != null ? { feeBps, minDepositFee, minReleaseFee } : null;
  };
  const fees = status?.fees;
  const perChain = fees?.[chain] && typeof fees[chain] === 'object' ? tryObj(fees[chain]) : null;
  if (perChain) return perChain;
  const flat = tryObj(fees);
  if (flat) return flat;
  const list = Array.isArray(status?.chains) ? status.chains : [];
  const entry = list.find((c: any) => c?.chain === code || c?.chain === chain);
  return entry ? tryObj(entry.fees ?? entry) : null;
}

/** `fee = max(minFee, ceil(units × feeBps / 10⁴))` (SPEC §7). */
export function feeOf(units: bigint, feeBps: bigint, minFee: bigint): bigint {
  const prop = (units * feeBps + 9_999n) / 10_000n;
  return prop > minFee ? prop : minFee;
}
