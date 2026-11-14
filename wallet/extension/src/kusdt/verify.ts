// Nothing the coordinator says about a covenant state is taken as fact. Before
// a state is shown or spent, the wallet:
//   1. checks the state's fields (a plain state of its own key, for tokens),
//   2. recomputes its locking script with the core's `script` command,
//   3. finds that exact outpoint at the script's P2SH address on the node,
//      with the same script and the pinned covenant ID (kUSDT's, or the pool's).
// A state that fails any step is dropped (tokens) or refused (the pool).
//
// Step 3 has a third outcome besides found and not there: the node could not list the address (it holds too many
// coins, or the read timed out: kusdt/unreadable.ts). Such a state is neither shown nor dropped. A token state is
// handed back apart, as unchecked; the pool is refused with the reason; a position is shown as not checked.
//
// The pool's kUSDT reserve made by the transaction that made the pool coin is proven instead, from that transaction's
// body (the coordinator serves it) checked against its id, and the pool coin found as in step 3: its address is then
// not listed at all (round 21, R21-POOL-1; verifyPool). One made before the pool coin is listed, and its body is taken
// only when its address cannot be.

import { encodeKaspaAddress, hexToBytes } from '@kusdt/kaspa';
import { reserveMadeBy } from '@kusdt/protocol';
import { toBig, toNat, isHex32, ZERO32 } from '../lib/bigint';
import { isPlainStateOf, OWNER_COVENANT_ID, type TokenState } from './owner';
import type { Ctx, CoreUtxo, Located, PoolState, PositionState } from './types';
import type { ApiLocated } from './api';
import type { MempoolJudged } from '../kaspa/node';
import { listAddresses } from './unreadable';
import { UNLISTED_AFTER_MS, type KnownState } from './known';

export class VerifyError extends Error {}

/** A wanted outpoint whose address the node could not list: not found, and not known to be absent. */
export const UNREAD = 'unread' as const;
type Found = CoreUtxo | null | typeof UNREAD;

/**
 * The pool or its reserve sits at an address the node cannot list, so the wallet cannot check the pool and builds
 * nothing on it. Not a VerifyError: asking again at once would get the same, so it is said at once.
 *
 * Which one is said: the reserve has an address of its own, which follows from its amount alone (second outside
 * review of rc.22, D6-2). It stops the wallet only when the coordinator served no transaction that proves the reserve
 * (round 21, R21-POOL-1: an older coordinator, or one that has not seen the reserve move since it started), and the
 * coordinator has one from the next trade or change of liquidity on. A tick moves the pool and not the reserve.
 */
export class PoolUnreadable extends Error {
  constructor(readonly which: 'pool' | 'reserve' | 'both' = 'pool') {
    const where = which === 'pool' ? 'the address the pool is at'
      : which === 'reserve' ? "the address the pool's kUSDT reserve is at"
        : 'the addresses the pool and its kUSDT reserve are at';
    const ends = which === 'pool'
      ? 'It ends when the pool next moves to a new address.'
      : "The wallet checks the reserve without that list when the coordinator gives the transaction that made it, and the coordinator gave none that proves it (it may not have seen the reserve move since it started). It ends with the pool's next trade or change of liquidity, not with its routine ticks.";
    super(`The Kaspa node could not list ${where} right now: ${which === 'both' ? 'they hold' : 'it holds'} too many coins (anyone can send coins to an address), or the node is too slow. So this wallet can't check the pool, and builds nothing on a pool it has not checked. ${ends} Nothing was sent, and your funds are where they were.`);
  }
}

/** The P2SH address of a covenant script ("0000" + aa20<hash>87). */
export function p2shAddressOf(spkHex: string, prefix: string): string {
  const m = /^0000aa20([0-9a-f]{64})87$/.exec(spkHex);
  if (!m) throw new VerifyError('A covenant state has an unexpected script.');
  return encodeKaspaAddress(prefix, 8, hexToBytes(m[1]));
}

/** The locking script of an actor's state, from the core. */
export function scriptOf(ctx: Pick<Ctx, 'core'>, actor: 'KCC20' | 'Pool' | 'Position' | 'BridgeMint', state: unknown): string {
  const spk = ctx.core.call<{ scriptPublicKey: string }>('script', { actor, state }).value.scriptPublicKey;
  if (typeof spk !== 'string' || !/^[0-9a-f]+$/.test(spk)) throw new VerifyError('The core gave no script.');
  return spk;
}

const hex32 = (v: unknown, what: string): string => {
  if (!isHex32(v)) throw new VerifyError(`A state's ${what} is not 32 bytes of hex.`);
  return v;
};
const byte = (v: unknown, what: string): number => {
  if (typeof v !== 'number' || !Number.isInteger(v) || v < 0 || v > 255) throw new VerifyError(`A state's ${what} is not a byte.`);
  return v;
};

export function parseTokenState(s: any): TokenState {
  if (!s || typeof s !== 'object') throw new VerifyError('A token state is missing.');
  return {
    amount: toNat(s.amount, 'token amount'),
    owner: hex32(s.owner, 'owner'),
    ownerScheme: byte(s.ownerScheme, 'owner scheme'),
    borrowScheme: byte(s.borrowScheme ?? 0, 'borrow scheme'),
    borrowGuard: hex32(s.borrowGuard ?? ZERO32, 'borrow guard'),
    extensionCommitment: hex32(s.extensionCommitment ?? ZERO32, 'extension commitment'),
  };
}

export function parsePoolState(s: any): PoolState {
  if (!s || typeof s !== 'object') throw new VerifyError('The pool state is missing.');
  return {
    tokenCovid: hex32(s.tokenCovid, 'token covenant ID'),
    kasReserve: toNat(s.kasReserve, 'KAS reserve'),
    tokenReserve: toNat(s.tokenReserve, 'token reserve'),
    totalShares: toNat(s.totalShares, 'total shares'),
    protocolKas: toNat(s.protocolKas, 'protocol KAS'),
    protocolTokens: toNat(s.protocolTokens, 'protocol tokens'),
    baseValue: toNat(s.baseValue, 'base value'),
    admin: hex32(s.admin, 'admin'),
    maxOutBps: toNat(s.maxOutBps, 'breaker share'),
    windowLen: toNat(s.windowLen, 'breaker window'),
    windowCredit: toNat(s.windowCredit, 'breaker window start'),
    windowRef: toNat(s.windowRef, 'breaker window reserve'),
    // The allowance used (sells less buys, less time): negative after net buying.
    windowOut: toBig(s.windowOut, 'breaker window out'),
    paused: s.paused === true,
    guardian: hex32(s.guardian, 'guardian'),
  };
}

export const poolValue = (p: PoolState): bigint => p.baseValue + p.kasReserve + p.protocolKas;

/** The pool's kUSDT reserve state (bridge/kaspa/src/pool.rs reserve_state). */
export const reserveStateOf = (poolId: string, p: PoolState): TokenState => ({
  amount: p.tokenReserve + p.protocolTokens, owner: poolId, ownerScheme: OWNER_COVENANT_ID,
  borrowScheme: 0, borrowGuard: ZERO32, extensionCommitment: ZERO32,
});

const sameToken = (a: TokenState, b: TokenState) =>
  a.amount === b.amount && a.owner === b.owner && a.ownerScheme === b.ownerScheme && a.borrowScheme === b.borrowScheme &&
  a.borrowGuard === b.borrowGuard && a.extensionCommitment === b.extensionCommitment;

interface Wanted { txid: string; index: number; spk: string; covenantId: string; amount?: bigint }

/**
 * Finds each wanted outpoint on the node: in the UTXO set, else (when
 * `mempool`) among outputs of transactions still in the mempool. Each must have
 * the expected script and covenant ID. Outpoints spent in the mempool count as gone.
 *
 * The mempool is believed only as far as a block can take what it shows (round 11, COV-1). A transaction that no block
 * can take is not on its way anywhere: an output it spends is still there (found, and marked `heldBy`, so that the
 * wallet can say why the node refuses a spend of it), and an output it makes is never built on. When the node cannot
 * be asked, nothing the mempool shows is built on.
 *
 * `context`: outputs that are not wanted themselves, but whose age a mempool transaction around the wanted ones may
 * claim (the confirmed pool a sale waiting in the mempool spends). Their addresses, worked out by the wallet from
 * states it holds, are read in the same one read, so that the judge knows when they were accepted: it lists no
 * address to find that out, least of all one a mempool transaction names (round 12, R12-WW-3).
 */
async function locate(ctx: Ctx, wanted: Wanted[], opts: { mempool: boolean; context?: Wanted[] }): Promise<Found[]> {
  const prefix = ctx.net.prefix;
  const addresses = [...new Set([...wanted, ...(opts.context ?? [])].map(w => p2shAddressOf(w.spk, prefix)))];
  // `unread`: the addresses the node could not list. What is wanted there is UNREAD, whatever else is known of it.
  const [{ utxos, unread }, spent] = await Promise.all([listAddresses(ctx, addresses), ctx.node.mempoolSpent(addresses).catch(() => new Set<string>())]);
  let pool: Awaited<ReturnType<Ctx['node']['mempoolOutputs']>> | null = null;
  let daa: bigint | null = null;
  // Asked once, and only when a wanted outpoint is spent in the mempool or found only there. `false`: the node could not be asked.
  let judged: MempoolJudged | false | undefined;
  const judge = async (): Promise<MempoolJudged | false | undefined> => {
    if (judged !== undefined || !ctx.node.mempoolJudged) return judged;
    const accepted = new Map(utxos.map(u => [`${u.transactionId}:${u.index}`, u.blockDaaScore] as const));
    judged = await ctx.node.mempoolJudged(addresses, wanted.map(w => ({ txid: w.txid, index: w.index })), accepted).catch(() => false as const);
    return judged;
  };
  const out: Found[] = [];
  for (const w of wanted) {
    let heldBy: string | undefined;
    if (spent.has(`${w.txid}:${w.index}`)) {
      // Spent by a transaction a block can take: gone. By one that no block can take: still there.
      const j = await judge();
      heldBy = j ? j.heldBy.get(`${w.txid}:${w.index}`)?.txid : undefined;
      if (!heldBy) { out.push(null); continue; }
    }
    if (unread.has(p2shAddressOf(w.spk, prefix))) { out.push(UNREAD); continue; }
    const u = utxos.find(x => x.transactionId === w.txid && x.index === w.index);
    if (u) {
      const ok = u.scriptPublicKey === w.spk && u.covenantId === w.covenantId && (w.amount == null || u.amount === w.amount);
      out.push(ok ? { transactionId: u.transactionId, index: u.index, amount: u.amount, scriptPublicKey: u.scriptPublicKey, blockDaaScore: u.blockDaaScore, isCoinbase: false, covenantId: u.covenantId, confirmed: true, ...(heldBy && { heldBy }) } : null);
      continue;
    }
    if (!opts.mempool || heldBy) { out.push(null); continue; }
    pool ??= await ctx.node.mempoolOutputs(addresses).catch(() => []);
    const m = pool.find(x => x.transactionId === w.txid && x.index === w.index);
    // An output of a transaction no block can take, or of one the node could not be asked about, is not built on.
    const j = m ? await judge() : undefined;
    if (m && (j === false || j?.unminable.has(m.transactionId))) { out.push(null); continue; }
    if (m && m.scriptPublicKey === w.spk && m.covenantId === w.covenantId && (w.amount == null || m.amount === w.amount)) {
      daa ??= await ctx.node.virtualDaa();
      out.push({ transactionId: m.transactionId, index: m.index, amount: m.amount, scriptPublicKey: m.scriptPublicKey, blockDaaScore: daa, isCoinbase: false, covenantId: m.covenantId, confirmed: false });
    } else out.push(null);
  }
  return out;
}

const outpointOf = (u: ApiLocated['utxo']): { txid: string; index: number } => {
  if (!u || typeof u !== 'object' || !/^[0-9a-f]{64}$/.test(String(u.transactionId)) || !Number.isInteger(u.index) || u.index < 0) {
    throw new VerifyError('A state has no valid outpoint.');
  }
  return { txid: u.transactionId, index: u.index };
};

export interface TokenCheck {
  verified: Located<TokenState>[];
  /** States the coordinator listed that failed a step: not this wallet's plain states, or not on the node. */
  rejected: number;
  /**
   * States whose address the node could not list (UNREAD), with the fields of a record: the wallet's own (`known`)
   * where it has one, else the coordinator's. `utxo.unchecked` is set on each. One without a recorded KAS amount
   * can't be built on and is only counted (`unreadNoRecord`).
   */
  unread: Located<TokenState>[];
  unreadNoRecord: number;
  /**
   * Outpoints that were not there ("txid:index"), for the wallet's own record: the node answered for them and did
   * not show them, or it could not answer and the coordinator's full list does not name a record that is old enough.
   */
  missing: string[];
}

/** The most states of the coordinator's answer that are looked at: it answers at most this many (MAX_OUTPUTS_ANSWERED). */
export const MAX_LISTED = 500;

const natOrNull = (v: unknown): bigint | null => { try { return toNat(v); } catch { return null; } };

/**
 * The wallet's kUSDT states among `listed` (the coordinator's answer) and `known` (the wallet's own record of
 * states its node showed it before, kusdt/known.ts), each verified. Only plain p2pk-schnorr states of `ownerHex`
 * are kept: others can't be spent here. Both lists are only where to look: what is found on the node is the same
 * whichever named it. `complete`: `listed` is all the coordinator holds for this owner (it answered, with fewer
 * states than it ever gives at once).
 */
export async function verifyTokenStates(ctx: Ctx, listed: ApiLocated[], ownerHex: string, known: KnownState[] = [], complete = false): Promise<TokenCheck> {
  const covenantId = ctx.config.covenantId;
  if (!isHex32(covenantId)) throw new VerifyError('No kUSDT deployment is set for this network.');
  // `kas`, `daa`: the coin's KAS and acceptance score by a record, used only for a state the node cannot show.
  // `spent`: the wallet's own record says its own transaction spent it (kusdt/known.ts): shown only if the node shows it unspent.
  const candidates: { state: TokenState; want: Wanted; kas: bigint | null; daa: bigint; listed: boolean; at: number; spent?: boolean }[] = [];
  const now = Date.now();
  let rejected = 0;
  const seen = new Map<string, number>();
  for (const l of listed.slice(0, MAX_LISTED)) {
    try {
      const state = parseTokenState(l?.state);
      if (!isPlainStateOf(state, ownerHex)) { rejected++; continue; }
      const { txid, index } = outpointOf(l.utxo);
      if (seen.has(`${txid}:${index}`)) continue;
      seen.set(`${txid}:${index}`, candidates.length);
      candidates.push({ state, want: { txid, index, spk: scriptOf(ctx, 'KCC20', state), covenantId }, kas: natOrNull(l.utxo.amount), daa: natOrNull(l.utxo.blockDaaScore) ?? 0n, listed: true, at: now });
    } catch { rejected++; }
  }
  for (const k of known) {
    const at = seen.get(`${k.txid}:${k.index}`);
    const state: TokenState = { amount: BigInt(k.amount), owner: ownerHex, ownerScheme: 0, borrowScheme: 0, borrowGuard: ZERO32, extensionCommitment: ZERO32 };
    if (at !== undefined) {
      // Listed too: the wallet's own record stands before the coordinator's. It is what the node showed (or what the
      // wallet's own transaction made), and an output never changes: where the two differ, the record is the right
      // one. Otherwise a coordinator naming another amount for the outpoint would have it looked for at another
      // address, not found there, and so dropped from the record.
      const c = candidates[at];
      if (c.state.amount !== state.amount) { c.state = state; c.want = { ...c.want, spk: scriptOf(ctx, 'KCC20', state) }; }
      c.kas = BigInt(k.kas); c.daa = BigInt(k.daa);
      if (k.spentBy !== undefined) c.spent = true;
      continue;
    }
    seen.set(`${k.txid}:${k.index}`, candidates.length);
    candidates.push({ state, want: { txid: k.txid, index: k.index, spk: scriptOf(ctx, 'KCC20', state), covenantId }, kas: BigInt(k.kas), daa: BigInt(k.daa), listed: false, at: k.at, ...(k.spentBy !== undefined && { spent: true }) });
  }
  if (candidates.length === 0) return { verified: [], rejected, unread: [], unreadNoRecord: 0, missing: [] };
  const found = await locate(ctx, candidates.map(c => c.want), { mempool: false });
  const verified: Located<TokenState>[] = [], unread: Located<TokenState>[] = [], missing: string[] = [];
  let unreadNoRecord = 0;
  found.forEach((u, i) => {
    const c = candidates[i];
    if (u === UNREAD) {
      // Spent by the wallet's own transaction, by its record: never offered as not checked (round 13, R13-CL-2).
      if (c.spent) return;
      // Only the wallet's record names it, the coordinator's full list does not, and it is not a new one the
      // coordinator has yet to see: most likely spent (by this key elsewhere). It counts as missing, and leaves the
      // record after three such looks; a state that sits there unspent would be in the coordinator's list.
      if (!c.listed && complete && now - c.at >= UNLISTED_AFTER_MS) missing.push(`${c.want.txid}:${c.want.index}`);
      if (c.kas === null) { unreadNoRecord++; return; }
      unread.push({ state: c.state, utxo: { transactionId: c.want.txid, index: c.want.index, amount: c.kas, scriptPublicKey: c.want.spk, blockDaaScore: c.daa, isCoinbase: false, covenantId, confirmed: true, unchecked: true } });
    } else if (u) verified.push({ utxo: u, state: c.state });
    else { missing.push(`${c.want.txid}:${c.want.index}`); if (c.listed) rejected++; }
  });
  return { verified, rejected, unread, unreadNoRecord, missing };
}

/**
 * The pool and its kUSDT reserve, both verified. `reserve` is null only for a
 * pool that was never opened: before its first deposit (SPEC §15 `init`) it
 * holds nothing and has no reserve state yet.
 */
export interface VerifiedPool { pool: Located<PoolState>; reserve: Located<TokenState> | null }
/** A pool that has had its first deposit: it always has its reserve. */
export interface OpenedPool { pool: Located<PoolState>; reserve: Located<TokenState> }

/** Never opened: no shares, no reserves, nothing the protocol kept in kUSDT (SPEC §15 `init`: X = Y = S = 0 before). */
export const isUnopened = (p: PoolState): boolean =>
  p.totalShares === 0n && p.kasReserve === 0n && p.tokenReserve === 0n && p.protocolTokens === 0n;

/** The pool with its reserve; throws for a pool that has no liquidity yet. */
export function openedPool(vp: VerifiedPool): OpenedPool {
  if (!vp.reserve || vp.pool.state.totalShares === 0n) throw new Error('The pool has no liquidity yet.');
  return { pool: vp.pool, reserve: vp.reserve };
}

/**
 * The confirmed pool the coordinator names beside the newest one, as context for `locate`: a sale or a tick waiting
 * in the mempool claims that coin's age, and the newest pool is then its output. One more address in the same read,
 * of a pool state's own script as the core computes it. A confirmed pool that is not named, or is named wrongly, is
 * left out: the wallet then does not build on such an output, and asks again.
 */
function confirmedPool(ctx: Ctx, answer: { confirmed?: { pool?: ApiLocated } | null }, poolId: string): Wanted[] {
  try {
    const named = answer.confirmed?.pool;
    if (!named) return [];
    return [{ ...outpointOf(named.utxo), spk: scriptOf(ctx, 'Pool', parsePoolState(named.state)), covenantId: poolId }];
  } catch { return []; }
}

/**
 * Bodies of transactions that made the pool's reserve, by id, once one proved it: a body that hashes to an id is that
 * transaction's for good. So each is fetched once (GET /pool/made/:txid), and a reserve this wallet has seen proven
 * needs no body from the coordinator again (one that has not followed the reserve's last move holds none). The newest few.
 */
const madeSeen = new Map<string, unknown>();

/**
 * The pool and its reserve as the coordinator gives them, verified; throws otherwise.
 *
 * The reserve's address follows from its amount alone: anyone can fill it, and anyone can trade the reserve back to it
 * after every move, which held every wallet off the pool for as long as they kept it up (round 21, R21-POOL-1). So the
 * reserve is proven from the body of the transaction that made it (named by `reserve.made`, served by
 * `GET /pool/made/:txid`; protocol/pool-follow.ts reserveMadeBy) when that transaction also made the pool coin the node
 * shows: the reserve is then spent only with that coin, and its address is not listed. The body of an earlier one shows
 * what its outpoint held, not that the outpoint is still there, so a reserve made before the pool coin is listed as
 * before, and its body is taken only when its address cannot be listed. Without a body that proves it the reserve is
 * listed, as before.
 */
export async function verifyPool(ctx: Ctx, answer: { pool?: ApiLocated; reserve?: (ApiLocated & { made?: unknown }) | null; confirmed?: { pool?: ApiLocated } | null } | null): Promise<VerifiedPool> {
  const { covenantId, poolId } = ctx.config;
  if (!isHex32(covenantId) || !isHex32(poolId)) throw new VerifyError('No pool is set for this network.');
  if (!answer?.pool) throw new VerifyError('The coordinator gave no pool.');
  const pool = parsePoolState(answer.pool.state);
  if (pool.tokenCovid !== covenantId) throw new VerifyError('The pool trades another token than kUSDT.');
  if (!answer.reserve) {
    // Only a pool that was never opened has no reserve; its state is checked on the node all the same.
    if (!isUnopened(pool)) throw new VerifyError('The coordinator gave no pool reserve.');
    const [pu] = await locate(ctx, [{ ...outpointOf(answer.pool.utxo), spk: scriptOf(ctx, 'Pool', pool), covenantId: poolId, amount: poolValue(pool) }], { mempool: true });
    if (pu === UNREAD) throw new PoolUnreadable();
    if (!pu) throw new VerifyError('The pool state could not be found on the Kaspa node (it may have just changed).');
    return { pool: { utxo: pu, state: pool }, reserve: null };
  }
  const reserve = parseTokenState(answer.reserve.state);
  const expected = reserveStateOf(poolId, pool);
  if (!sameToken(reserve, expected)) throw new VerifyError('The pool reserve does not match the pool.');
  const p = outpointOf(answer.pool.utxo), r = outpointOf(answer.reserve.utxo);
  const rspk = scriptOf(ctx, 'KCC20', reserve);
  const wanted = { ...p, spk: scriptOf(ctx, 'Pool', pool), covenantId: poolId, amount: poolValue(pool) };
  const context = confirmedPool(ctx, answer, poolId).filter(c => c.txid !== p.txid || c.index !== p.index);
  // The reserve's KAS, from the body of the transaction that made it; null when there is none that proves it. The body
  // is kept from before, or fetched once by its id when /pool says the coordinator holds it (`reserve.made`).
  const body = madeSeen.get(r.txid) ?? (answer.reserve.made === r.txid ? await ctx.api?.poolMade?.(r.txid).catch(() => undefined) : undefined);
  const made = reserveMadeBy(body, { transactionId: r.txid, index: r.index }, rspk, { covenantId, poolId });
  if (made !== null) {
    madeSeen.delete(r.txid);
    madeSeen.set(r.txid, body);
    if (madeSeen.size > 8) madeSeen.delete(madeSeen.keys().next().value as string);
  }
  const withPool = made !== null && r.txid === p.txid;
  const [pu, ru] = await locate(ctx, withPool ? [wanted] : [wanted, { ...r, spk: rspk, covenantId }], { mempool: true, context });
  // Never built on unchecked: the pool's state is the price, and the coordinator's word for it is not enough.
  if (pu === UNREAD) throw new PoolUnreadable(!withPool && ru === UNREAD ? 'both' : 'pool');
  if (!pu) throw new VerifyError('The pool state could not be found on the Kaspa node (it may have just changed).');
  if (!withPool) {
    if (ru !== UNREAD) {
      if (!ru) throw new VerifyError('The pool state could not be found on the Kaspa node (it may have just changed).');
      return { pool: { utxo: pu, state: pool }, reserve: { utxo: ru, state: reserve } };
    }
    if (made === null) throw new PoolUnreadable('reserve');
  }
  // From the body. Made with the pool coin, the reserve is where the pool coin is: in a block, or only in the mempool.
  // Made before it, and its address too full to list, it is in a block unless the node still holds its transaction;
  // that it is unspent is the node's to judge when the transaction comes (a spent one is refused). Its own acceptance
  // score is not in the body: the pool coin's, no earlier, stands in for it, as the scripts only ask whether a coin is
  // in a block (bridge_mint.ag require_settled_inputs).
  const confirmed = withPool ? pu.confirmed !== false : pu.confirmed !== false || !(await ctx.node.inMempool(r.txid));
  return {
    pool: { utxo: pu, state: pool },
    reserve: { utxo: { transactionId: r.txid, index: r.index, amount: made, scriptPublicKey: rspk, blockDaaScore: pu.blockDaaScore, isCoinbase: false, covenantId, confirmed }, state: reserve },
  };
}

/**
 * A liquidity position the wallet recorded, checked on the node. Null when it is gone. UNREAD when the node could
 * not list its address: it is then neither shown as checked nor taken for gone.
 */
export async function verifyPosition(ctx: Ctx, txid: string, index: number, state: PositionState): Promise<Located<PositionState> | null | typeof UNREAD> {
  const [u] = await locate(ctx, [{ txid, index, spk: scriptOf(ctx, 'Position', state), covenantId: ctx.config.poolId }], { mempool: true });
  return u === UNREAD ? UNREAD : u ? { utxo: u, state } : null;
}
