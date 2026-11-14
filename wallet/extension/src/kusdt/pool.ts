// The KAS ⇄ kUSDT pool: quotes, swaps and liquidity.
//
// Every pool transaction spends one exact pool state (and its reserve), so a
// quote made on a state someone else has since spent can't be submitted: the
// node refuses it. The wallet then fetches the newest state, quotes again and
// rebuilds, at most 3 times in all, and never submits below the minimum the
// user set. It goes ahead on its own only while the new quote is at least the
// one the user approved: a worse one stops with QuoteChanged, and the user
// confirms the new numbers first (SPEC §15).
//
// Paused (the guardian's pause), the pool takes no swaps and no new liquidity;
// removing liquidity stays open. Sells are also held to the circuit breaker:
// at most `maxOutBps` of the KAS reserve may leave at once, net of buys,
// refilling over `windowLen` DAA. Buys that left the count below zero add
// their credit (up to one more cap), which only claimed time takes back: a
// sell that claims age 0 keeps it, one that claims the age (as this wallet
// builds every sell) settles it away first. The wallet asks the core what a
// sell may take out at its
// clock (`quote` with `nowDaa` and the pool UTXO's DAA score) before anything
// is built or merged.
//
// While more than half of the cap is in use (the count windowOut above half of
// maxOutBps of windowRef) every pool transaction must claim at least a 720th of
// the window of the pool UTXO's age (50 DAA, about 5 s), so the wallet waits
// until its node shows the pool UTXO accepted and that old, and builds then, at
// the first DAA the lock allows, claiming exactly that. A node refuses a
// transaction whose relative lock is not met yet; it does not keep it for later,
// so the wallet sends again (LOCK_RETRY). A withdrawal while the pool is paused
// needs no claim.

import { local, session } from '../lib/storage';
import type { ApiLocated } from './api';
import { toBig } from '../lib/bigint';
import { fmtKas, fmtUsdt } from '../lib/format';
import { NodeRejected } from '../kaspa/node';
import { ABSORB_LIMIT, buildFunded, checkBuilt, CORE_MIN_CHANGE, feeNeeded, toCoreUtxo, type FundingCoin } from './build';
import { assertSettled } from './inputs';
import { restoreSpent } from './known';
import { inputsOf, releaseSpent } from './pending';
import { awaitOutcome, submitBuilt, type Raced } from './submit';
import { noteUnconfirmed } from './unconfirmed';
import { loadTokens, singleStateFor, walletCoins } from './tokens';
import { MAX_LISTED, openedPool, p2shAddressOf, reserveStateOf, scriptOf, verifyPool, verifyPosition, UNREAD, VerifyError, type OpenedPool, type VerifiedPool } from './verify';
import { toNat, isHex32 } from '../lib/bigint';
import { plainState, type TokenState } from './owner';
import type { Built, Ctx, Located, PoolState, PositionState, Signer } from './types';

export const MAX_POOL_TRIES = 3;
const BPS = 10_000n;
/**
 * How far the breaker's clock (the pool UTXO's age a swap claims) stays behind
 * the node's virtual DAA: about 1 s at 10 blocks a second, so its relative lock
 * is met on every node up to that far behind the one the wallet asked, while
 * swaps more than 1 s apart can still claim their age (SPEC §15). Never below the
 * least claim: at the first DAA the lock allows, the wallet claims exactly that
 * (`poolNowDaa`), and sends again if its node is a moment behind.
 */
export const SELL_DAA_MARGIN = 10n;
/** Nominal DAA scores per second (36 000 DAA, an hour at 10 BPS): for "about" times only. */
export const DAA_PER_SECOND = 10n;
/** The shares the pool's first deposit leaves unowned for good (SPEC §15 `init`; bridge/kaspa MIN_LIQUIDITY). */
export const LOCKED_SHARES = 1_000n;
/**
 * KAS a Max leaves for the network fee. The fee itself is small; what is left
 * over comes back as change, which the core keeps only from 0.2 KAS up.
 */
export const FEE_KEEP = 30_000_000n; // 0.3 KAS
/** The most one swap may take in (SPEC §15: `amount × 10⁴` fits in 64 bits). */
export const MAX_SWAP_INPUT = 230_584_300_921_369n;
/** pool.ag MIN_AGE_PARTS: while more than half of the cap is in use a pool transaction claims at least windowLen / 720 of age. */
export const MIN_AGE_PARTS = 720n;
/** How long the wallet waits for the pool UTXO to be old enough before it gives up (the minimum is about 5 s). */
export const READY_WAIT_MS = 60_000;
/** A node a moment behind refuses a relative lock that is met on the network: the wallet sends again, this often, this many times. */
export const LOCK_RETRY = { ms: 100, tries: 20 };
/** The node refused a transaction because a relative lock is not met yet (rusty-kaspa SequenceLockConditionsAreNotMet). */
const LOCK_NOT_MET = /sequence locks? conditions/i;

type ClaimState = Pick<PoolState, 'windowLen' | 'windowOut' | 'windowRef' | 'maxOutBps'>;

/**
 * The least a buy, sell or add on `pool` must claim (pool.ag require_claim): a 720th of the window (at least 1 DAA) while
 * more than half of the cap is in use (the stored count above half of maxOutBps of the stored reference), else nothing.
 */
export function leastClaimOf(pool: ClaimState): bigint {
  if (pool.windowOut <= (pool.windowRef * pool.maxOutBps) / BPS / 2n) return 0n;
  const least = pool.windowLen / MIN_AGE_PARTS;
  return least < 1n ? 1n : least;
}

/** The least a withdrawal must claim: nothing while the pool is paused, so the pause never holds providers in. */
export function leastRemoveClaimOf(pool: ClaimState & Pick<PoolState, 'paused'>): bigint {
  return pool.paused ? 0n : leastClaimOf(pool);
}

/**
 * The first virtual DAA at which a pool transaction claiming `least` can spend this pool UTXO: its acceptance plus the
 * least claim (at once when that is nothing). Null when a claim is needed and the UTXO is only in the mempool (no age).
 */
export function poolReadyAt(vp: Pick<VerifiedPool, 'pool'>, least = leastClaimOf(vp.pool.state)): bigint | null {
  if (least === 0n) return 0n;
  if (vp.pool.utxo.confirmed === false || !(vp.pool.utxo.blockDaaScore > 0n)) return null;
  return vp.pool.utxo.blockDaaScore + least;
}

/** Whether a pool transaction can be sent on this pool UTXO at virtual DAA `virtualDaa` (no margin: the first DAA the lock allows). */
export function poolReady(vp: Pick<VerifiedPool, 'pool'>, virtualDaa: bigint, least = leastClaimOf(vp.pool.state)): boolean {
  const at = poolReadyAt(vp, least);
  return at !== null && at <= virtualDaa;
}

/**
 * The clock a pool transaction is built with at virtual DAA `virtualDaa`: SELL_DAA_MARGIN behind it (`sellNowDaa`), but
 * never below the first DAA the lock allows, so at that DAA it claims exactly the least and meets anyone else there.
 */
export function poolNowDaa(vp: Pick<VerifiedPool, 'pool'>, virtualDaa: bigint, least = leastClaimOf(vp.pool.state)): bigint {
  const clock = sellNowDaa(vp.pool.state, virtualDaa);
  const at = poolReadyAt(vp, least);
  return at !== null && at > clock && at <= virtualDaa ? at : clock;
}

// ── Quotes (the core computes them exactly as the covenant checks them) ─────

export function quoteBuy(ctx: Pick<Ctx, 'core'>, pool: PoolState, kasIn: bigint): bigint {
  return toBig(ctx.core.call('quote', { kind: 'buy', pool, kasIn }).value.tokensOut);
}
export function quoteSell(ctx: Pick<Ctx, 'core'>, pool: PoolState, tokensIn: bigint): bigint {
  return toBig(ctx.core.call('quote', { kind: 'sell', pool, tokensIn }).value.kasOut);
}
export function quoteAdd(ctx: Pick<Ctx, 'core'>, pool: PoolState, kasIn: bigint, tokensIn: bigint): bigint {
  return toBig(ctx.core.call('quote', { kind: 'add', pool, kasIn, tokensIn }).value.shares);
}
export function quoteRemove(ctx: Pick<Ctx, 'core'>, pool: PoolState, shares: bigint): { kasOut: bigint; tokensOut: bigint } {
  const v = ctx.core.call('quote', { kind: 'remove', pool, shares }).value;
  return { kasOut: toBig(v.kasOut), tokensOut: toBig(v.tokensOut) };
}

/** The least the user accepts for a quote, at `slippageBps` (50 = 0.5 %). Rounds down. */
export function minimumFor(quote: bigint, slippageBps: number): bigint {
  if (!Number.isInteger(slippageBps) || slippageBps < 0 || slippageBps > 5_000) throw new Error('Slippage must be between 0 % and 50 %.');
  return (quote * (BPS - BigInt(slippageBps))) / BPS;
}

export class BelowMinimum extends Error {
  constructor(readonly quote: bigint, readonly minimum: bigint) {
    super('The pool now pays less than the minimum you set. Nothing was sent.');
  }
}

/** Refuses an amount below the user's minimum (and a minimum of zero or less). */
export function assertMinimum(out: bigint, minimum: bigint): void {
  if (minimum <= 0n) throw new Error('Set a minimum to receive above zero.');
  if (out < minimum) throw new BelowMinimum(out, minimum);
}

/** KAS for `tokensIn` at the pool's price, rounded up, plus one (what an even deposit needs). */
export const tokensForKas = (pool: PoolState, kasIn: bigint): bigint =>
  pool.kasReserve === 0n ? 0n : (kasIn * pool.tokenReserve + pool.kasReserve - 1n) / pool.kasReserve + 1n;

/** The KAS an even deposit of `tokensIn` goes with, at the pool's price (rounded down). */
export const kasForTokens = (pool: PoolState, tokensIn: bigint): bigint =>
  pool.tokenReserve === 0n ? 0n : (tokensIn * pool.kasReserve) / pool.tokenReserve;

// ── Pause, the circuit breaker, and changed quotes ──────────────────────────

export class PoolPaused extends Error {
  constructor() { super('The pool is paused: swaps and new liquidity are stopped for now, and withdrawals stay open. Nothing was sent.'); }
}

/** Refuses a swap or new liquidity on a paused pool (removing liquidity is never refused for it). */
export function assertNotPaused(pool: PoolState): void {
  if (pool.paused) throw new PoolPaused();
}

/** What the circuit breaker allows a sell at some DAA score (core `quote` with `nowDaa`). */
export interface SellBreaker {
  /** KAS (sompi) sells may still take out now. */
  maxKasOut: bigint;
  /** The DAA score at which the allowance has fully refilled. */
  windowEndsDaa: bigint;
  /** This sell's KAS out fits. */
  allowed: boolean;
}
export interface SellQuote { kasOut: bigint; breaker: SellBreaker; paused: boolean; nowDaa: bigint }

/** The breaker's clock for a sell built now: the virtual DAA less the margin (SPEC §15). */
export function sellNowDaa(_pool: PoolState, virtualDaa: bigint): bigint {
  return virtualDaa > SELL_DAA_MARGIN ? virtualDaa - SELL_DAA_MARGIN : 0n;
}

/**
 * A sell quote from the core with what the circuit breaker allows at `nowDaa`,
 * and whether the pool is paused. `poolDaa` is the DAA score the pool UTXO was
 * accepted at (for an unconfirmed pool UTXO, the wallet's clock: it claims no age).
 */
export function quoteSellAt(ctx: Pick<Ctx, 'core'>, pool: PoolState, tokensIn: bigint, nowDaa: bigint, poolDaa?: bigint): SellQuote {
  const v = ctx.core.call('quote', { kind: 'sell', pool, tokensIn, nowDaa, ...(poolDaa !== undefined && { poolDaa }) }).value;
  const b = v?.breaker;
  if (!b || typeof b !== 'object') throw new Error('The core gave no circuit breaker for this sell.');
  return {
    kasOut: toNat(v.kasOut, 'sell quote'),
    breaker: { maxKasOut: toNat(b.maxKasOut, "breaker's room"), windowEndsDaa: toNat(b.windowEndsDaa, "breaker's window end"), allowed: b.allowed === true },
    paused: v.paused === true,
    nowDaa,
  };
}

/**
 * The largest kUSDT input (base units, at most `hi`) whose KAS out stays at or
 * below `maxKasOut`. A sell's KAS out never falls as its input grows, so a
 * binary search over the core's own quote finds it exactly.
 */
export function largestSellWithin(ctx: Pick<Ctx, 'core'>, pool: PoolState, maxKasOut: bigint, hi: bigint): bigint {
  if (hi > MAX_SWAP_INPUT) hi = MAX_SWAP_INPUT;
  if (hi <= 0n || maxKasOut <= 0n) return 0n;
  if (quoteSell(ctx, pool, hi) <= maxKasOut) return hi;
  let lo = 0n; // quote(0) = 0 ≤ maxKasOut; quote(hi) > maxKasOut
  while (hi - lo > 1n) {
    const mid = (lo + hi) / 2n;
    if (quoteSell(ctx, pool, mid) <= maxKasOut) lo = mid; else hi = mid;
  }
  return lo;
}

/** Whether the breaker's allowance is already full at `nowDaa` (a read of the core's `windowEndsDaa`). */
export const windowOver = (windowEndsDaa: bigint, nowDaa: bigint): boolean => windowEndsDaa <= nowDaa;

/** About how many seconds until the DAG reaches `daa`, from the wallet's clock `nowDaa`. */
export const secondsUntilDaa = (daa: bigint, nowDaa: bigint): number => (daa > nowDaa ? Number((daa - nowDaa) / DAA_PER_SECOND) : 0);

/** The breaker refuses this sell: what it allows, and the largest sell that fits. */
export class BreakerLimit extends Error {
  constructor(readonly kasOut: bigint, readonly maxKasOut: bigint, readonly windowEndsDaa: bigint, readonly maxTokensIn: bigint) {
    super(maxTokensIn > 0n
      ? `The pool's circuit breaker lets sells take out only ${fmtKas(maxKasOut, 4)} KAS more until its window ends (DAA ${windowEndsDaa}). Sell at most ${fmtUsdt(maxTokensIn)} kUSDT now. Nothing was sent.`
      : `The pool's circuit breaker lets no more KAS out through sells until its window ends (DAA ${windowEndsDaa}). Nothing was sent.`);
  }
}

/** Refuses a sell the covenant's circuit breaker would refuse, naming the largest that fits. */
export function assertSellFits(ctx: Pick<Ctx, 'core'>, pool: PoolState, tokensIn: bigint, nowDaa: bigint, poolDaa?: bigint): SellQuote {
  const q = quoteSellAt(ctx, pool, tokensIn, nowDaa, poolDaa);
  if (!q.breaker.allowed) throw new BreakerLimit(q.kasOut, q.breaker.maxKasOut, q.breaker.windowEndsDaa, largestSellWithin(ctx, pool, q.breaker.maxKasOut, tokensIn));
  return q;
}

/** A quote as the user approved it: one amount out (a swap, shares), or both sides of a withdrawal. */
export type Quoted = bigint | { kasOut: bigint; tokensOut: bigint };

/**
 * The pool moved and the new quote is worse than the one the user approved:
 * nothing was sent, and the new numbers need the user's confirmation.
 */
export class QuoteChanged<T extends Quoted = Quoted> extends Error {
  constructor(readonly seen: T, readonly now: T) {
    super('The pool moved before this went in, and it now gives less than what you approved. Nothing was sent: check the new numbers and confirm them to go ahead.');
  }
}

/** Equal or better than approved goes ahead; worse throws QuoteChanged. */
export function assertNotWorse<T extends Quoted>(seen: T, now: T): void {
  const worse = typeof seen === 'bigint'
    ? (now as bigint) < seen
    : (now as { kasOut: bigint }).kasOut < seen.kasOut || (now as { tokensOut: bigint }).tokensOut < seen.tokensOut;
  if (worse) throw new QuoteChanged(seen, now);
}

// ── The newest pool, and the retry ──────────────────────────────────────────

/** How long to wait between asks for a newer pool state (tests set it to 0). */
/** How long the wallet sleeps between looks at the pool, and (close to the DAA a pool UTXO is ready at) per DAA left. */
export const POOL_WAIT = { ms: 1_000, perDaaMs: 100 };
/** Closer than this to the DAA a pool UTXO is ready at, the wallet waits for that DAA on the state it has. */
const NEAR_DAA = 20n;
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

/**
 * The newest pool state, verified. The coordinator learns a new state from
 * blocks, so right after a pool transaction its answer can name a state the
 * node no longer has: asked again a few times before giving up.
 */
export async function freshPool(ctx: Ctx, tries = 8): Promise<VerifiedPool> {
  if (!ctx.api) throw new Error('No coordinator API is set for this network.');
  for (let n = 1; ; n++) {
    try { return await verifyPool(ctx, await ctx.api.pool()); }
    catch (e) {
      if (!(e instanceof VerifyError)) throw e;
      // The pool state this wallet's own last pool transaction made, checked on the node the same way.
      const hint = await session.get<{ pool: ApiLocated; reserve: ApiLocated }>(POOL_HINT_KEY(ctx));
      if (hint) { try { return await verifyPool(ctx, hint); } catch { /* spent since */ } }
      if (n >= tries) throw e;
      await sleep(POOL_WAIT.ms);
    }
  }
}

const POOL_HINT_KEY = (ctx: Ctx) => `kusdt.poolHint.${ctx.network}.${ctx.config.poolId}`;

/**
 * Keeps the pool state a submitted pool transaction creates. The coordinator
 * follows swaps from blocks but not liquidity moves, so after an add or a
 * removal its /pool can name a spent state; this one is verified on the node
 * before it is used, exactly like the coordinator's answer.
 */
/** Sets the pool state the wallet falls back to (verified on the node before any use). */
export async function setPoolHint(ctx: Ctx, hint: { pool: ApiLocated; reserve: ApiLocated }): Promise<void> {
  await session.set({ [POOL_HINT_KEY(ctx)]: hint });
}

async function rememberPool(ctx: Ctx, built: Built): Promise<void> {
  const p = built.outputs[0];
  const r = built.outputs.find(o => o.kind === 'reserve');
  if (!p?.pool || !r?.token) return;
  await session.set({ [POOL_HINT_KEY(ctx)]: { pool: { utxo: { transactionId: built.txid, index: 0 }, state: p.pool }, reserve: { utxo: { transactionId: built.txid, index: r.index }, state: r.token } } });
}

/** A pool state other than `than`, waiting a little for the coordinator to see it; the same one if none comes. */
async function nextPool(ctx: Ctx, than: VerifiedPool): Promise<VerifiedPool> {
  let vp = than;
  for (let n = 0; n < 8; n++) {
    vp = await freshPool(ctx);
    if (outpoint(vp) !== outpoint(than)) return vp;
    await sleep(POOL_WAIT.ms);
  }
  return vp;
}

const outpoint = (vp: VerifiedPool) => `${vp.pool.utxo.transactionId}:${vp.pool.utxo.index}`;

/** The pool is spent again and again faster than its UTXO can age to the minimum claim. */
export class PoolBusy extends Error {
  constructor() { super('The pool was spent again before its last state was old enough to build on (a few seconds). Nothing was sent; try again.'); }
}

/**
 * A pool to build a transaction on now: `vp` once its node shows it accepted and old enough for the least claim (at once
 * while at most half of the cap is in use, or for a withdrawal while paused), else the newest verified pool when it is.
 * Close to that DAA it waits for exactly that DAA, so it is ready when the lock first allows the claim, as anyone else
 * is; further off it asks for the newest pool POOL_WAIT apart. Gives up after `waitMs`.
 */
export async function readyPool(ctx: Ctx, vp: VerifiedPool, waitMs = READY_WAIT_MS, leastOf: (s: PoolState) => bigint = leastClaimOf): Promise<VerifiedPool> {
  const until = Date.now() + waitMs;
  for (;;) {
    const at = poolReadyAt(vp, leastOf(vp.pool.state));
    const virtualDaa = await ctx.node.virtualDaa();
    if (at !== null && at <= virtualDaa) return vp;
    if (Date.now() >= until) throw new PoolBusy();
    if (at !== null && at - virtualDaa <= NEAR_DAA) {
      await sleep(Number(at - virtualDaa) * POOL_WAIT.perDaaMs);
      continue;
    }
    await sleep(POOL_WAIT.ms);
    vp = await freshPool(ctx);
  }
}

/**
 * A transaction that no block can take is sitting in the node's mempool and spends the pool (round 11, COV-1). While
 * the node holds it, it refuses every other spend of the pool as a double spend, so nothing is built: the user is
 * told why, instead of a refusal that says nothing.
 */
export class PoolHeld extends Error {
  constructor(readonly txid: string) {
    super(`The Kaspa node this wallet uses is holding a transaction that spends the pool and that no block can take (${txid}). Until the node drops it (up to 24 hours) or another pool transaction is confirmed, it refuses every trade and every deposit or withdrawal of liquidity. Nothing was sent, and your funds are where they were. Try again later, or set another Kaspa node in Settings.`);
  }
}

/**
 * The pool UTXO as the core takes it: one only in the mempool carries the node's mark for it, UNACCEPTED_DAA_SCORE
 * (toCoreUtxo), and claims no age (the clients claim 0 on it, as the core does). Throws PoolHeld for a pool the node
 * will take no spend of.
 */
const corePoolUtxo = (u: Located<PoolState>['utxo']) => {
  if (u.heldBy) throw new PoolHeld(u.heldBy);
  return toCoreUtxo(u);
};
// Before each build, assertSettled (kusdt/inputs.ts) refuses a covenant coin still in the mempool that the transaction
// which made the pool coin did not make (rc.22 require_settled_inputs): the pool's own reserve always comes with the
// pool coin; a position or a kUSDT state may not. Funding coins come from the UTXO set only (kasCoins).

// ── Sent is not done: what became of a pool transaction ────────────────────

/**
 * The node took this pool transaction, and another one spending the same pool UTXO was accepted instead: it can never
 * be accepted now. Nothing it spent has moved. `own`: the wallet's own outpoints it spent (everything but the pool's).
 */
export class LostRace extends Error {
  constructor(readonly txid: string, readonly own: string[]) {
    super('Another transaction reached the pool first, so this one did not go through. Nothing left your wallet; try again.');
  }
}

/**
 * Sends a pool transaction built on `vp` and waits to learn what became of it (kusdt/submit.ts awaitOutcome): a node
 * that takes a transaction has not accepted it, and of two transactions spending one pool UTXO only one ever is.
 * Answers whether it was seen confirmed. Lost: what it held is free again at once, and LostRace is thrown (withFreshPool
 * goes again on the new pool). Neither seen in time: sent, not confirmed; it is looked at again at every refresh
 * (kusdt/unconfirmed.ts), and its inputs stay out of selection meanwhile.
 */
async function sendToPool(ctx: Ctx, built: Built, vp: Pick<VerifiedPool, 'pool' | 'reserve'>): Promise<{ txid: string; confirmed: boolean }> {
  const u = vp.pool.utxo;
  const raced: Raced = {
    outpoint: `${u.transactionId}:${u.index}`, address: p2shAddressOf(u.scriptPublicKey, ctx.net.prefix),
    // Seen in the UTXO set at the build (not only in the mempool), at its own acceptance score at the least.
    seen: u.confirmed !== false, daa: (u.confirmed !== false ? u.blockDaaScore : 0n).toString(),
  };
  const txid = await submitBuilt(ctx, built);
  const outcome = await awaitOutcome(ctx, built, raced);
  if (outcome === 'lost') {
    const inputs = inputsOf(built.transaction);
    await releaseSpent(ctx.network, inputs);
    // The wallet's record of its states has what this transaction spent back, and drops what it made (round 13, R13-CL-2).
    await restoreSpent(ctx.network, txid).catch(() => {});
    const pools = new Set([raced.outpoint, ...(vp.reserve ? [`${vp.reserve.utxo.transactionId}:${vp.reserve.utxo.index}`] : [])]);
    throw new LostRace(txid, inputs.filter(i => !pools.has(i)));
  }
  await rememberPool(ctx, built);
  // Seen confirmed: what it spent stays in the wallet's record, marked, until the node shows it spent (kusdt/known.ts, D4-1).
  if (outcome === 'unknown') await noteUnconfirmed(ctx, built, raced).catch(() => {});
  return { txid, confirmed: outcome === 'confirmed' };
}

/** `coins` with those the lost transactions spent first: the transaction built in their place then spends one of them too. */
const lostFirst = (coins: FundingCoin[], lost: string[][]): FundingCoin[] => {
  const was = new Set(lost.flat());
  const of = (c: FundingCoin) => `${c.utxo.transactionId}:${c.utxo.index}`;
  return [...coins.filter(c => was.has(of(c))), ...coins.filter(c => !was.has(of(c)))];
};

/**
 * A transaction built in the place of ones that lost the race must spend at least one of the wallet's own outpoints
 * of each of them. Then it can never be accepted beside any of them: should the node have been wrong about a loss (a
 * node that is behind, or lies), the earlier one was accepted, its coins are spent, and this one is void.
 */
function assertReplaces(built: Built, lost: string[][]): void {
  const spends = new Set(inputsOf(built.transaction));
  if (!lost.every(own => own.some(o => spends.has(o)))) {
    throw new Error('An earlier try lost the race for the pool, and the wallet could not build the next one on the same coins. Nothing more was sent; try again.');
  }
}

/**
 * Runs `attempt` on the newest verified pool. When the node refuses the
 * transaction and the pool has moved on since, it runs again on the new state,
 * up to `tries` times in all. The same when the node took it and another
 * transaction won the pool UTXO (LostRace): `lost` then names, for each lost
 * try, the outpoints of the wallet's own that it spent, and the next one must
 * spend one of each. A refusal while the pool is unchanged is final,
 * except that a relative lock not met yet (a node a moment behind the DAA the
 * transaction was built at) is sent again on the same state, LOCK_RETRY apart.
 * Each attempt quotes again and decides for itself (minimum, pause, breaker,
 * a worse quote than approved) before it builds anything.
 */
export async function withFreshPool<T>(ctx: Ctx, attempt: (vp: VerifiedPool, n: number, lost: string[][]) => Promise<T>, tries = MAX_POOL_TRIES, first?: VerifiedPool): Promise<T> {
  let vp = first ?? await freshPool(ctx);
  let lockRetries = 0;
  const lost: string[][] = [];
  for (let n = 1; ; n++) {
    try { return await attempt(vp, n, lost); }
    catch (e) {
      if (e instanceof LostRace) {
        // Every later try must replace this one (assertReplaces).
        lost.push(e.own);
        if (n >= tries) throw e;
        const next = await nextPool(ctx, vp);
        if (outpoint(next) === outpoint(vp)) throw e;
        vp = next;
        continue;
      }
      if (e instanceof NodeRejected && LOCK_NOT_MET.test(e.said) && lockRetries < LOCK_RETRY.tries) {
        // A node a moment behind, or a reorg that moved the pool UTXO's acceptance DAA (the same outpoint, a new
        // blockDaaScore): the pool is verified again and the transaction built again on what the node shows now.
        lockRetries++;
        n--;
        await sleep(LOCK_RETRY.ms);
        const again = await freshPool(ctx).catch(() => null);
        if (again && outpoint(again) === outpoint(vp)) vp = again;
        continue;
      }
      if (!(e instanceof NodeRejected) || n >= tries) {
        if (e instanceof NodeRejected) throw new Error(`The pool kept changing while the wallet tried (${tries} times). Nothing was sent; try again.`);
        throw e;
      }
      const next = await nextPool(ctx, vp);
      if (outpoint(next) === outpoint(vp)) throw e;
      vp = next;
    }
  }
}

// ── Swaps ───────────────────────────────────────────────────────────────────

export interface SwapArgs {
  side: 'buy' | 'sell';
  amountIn: bigint;
  /** The hard floor: never less than this. */
  minOut: bigint;
  /** The quote the user saw and approved. A new quote below it stops with QuoteChanged; equal or better goes ahead. */
  quoted: bigint;
  /**
   * The node's feerate when the screen showed the fee (poolFeeAbout): a build at more than feerateCap of it is not sent
   * (R15-CL-3), nor is a merge a sale needs first (Daybreak [9]).
   */
  shownFeerate?: number;
  /** A network fee the screen showed besides (Max keeps FEE_KEEP for it): a build that leaves change to the network may pay up to it (R17-CL-1). */
  acceptedFee?: bigint;
}
/** `confirmed`: the node showed the swap accepted. False: sent, and not seen accepted (or lost) while the wallet waited. */
export interface SwapResult { txid: string; amountOut: bigint; tries: number; built: Built; confirmed: boolean }

/** `pinned`: coins the lost tries spent (assertReplaces): trying other coins within the input cap keeps them. */
function buildBuy(ctx: Ctx, signer: Signer, vp: OpenedPool, coins: Awaited<ReturnType<typeof walletCoins>>, kasIn: bigint, tokensOut: bigint, feerate: number, nowDaa: bigint, pinned?: ReadonlySet<string>): Built {
  const tokenValue = BigInt(ctx.config.tokenValue);
  const bought = plainState({ ownerScheme: 0, owner: signer.ownerHex }, tokensOut);
  assertSettled(vp.pool.utxo, [{ coin: vp.reserve.utxo, what: 'coin' }]);
  const built = buildFunded(ctx, signer, coins, 'pool-buy', kasIn + tokenValue, (funding, feerate) => ({
    network: ctx.network, feerate, changeAddress: signer.address, funding,
    pool: { utxo: corePoolUtxo(vp.pool.utxo), state: vp.pool.state },
    reserve: { utxo: toCoreUtxo(vp.reserve.utxo), state: vp.reserve.state },
    kasIn, tokensOut, buyer: signer.ownerHex, tokenValue, nowDaa,
  }), feerate, pinned);
  checkBuilt(ctx, built, signer, { tokens: [{ index: 2, state: bought, value: tokenValue }], covenant: [{ index: 0, kind: 'pool' }, { index: 1, kind: 'reserve' }] });
  return built;
}

/** The fee mass of a sale (measured 74 044 grams on rc.22's larger pool program; a few more coins fit under this). For the check before anything is signed only. */
export const SELL_FEE_MASS = 82_000n;
/**
 * The fee mass a swap, a deposit or a withdrawal is shown at before it is built and approved (round 15, R15-CL-3):
 * above what round15-pool-fee.test.ts measures (on rc.22, whose pool program is about 7.8 KB larger than rc.21's: a
 * buy about 66 000 grams, a sale 74 000, a deposit 77 000). The figure is an estimate.
 */
export const POOL_FEE_MASS = 80_000n;
/** About what a pool transaction pays the network at `feerate`: the figure the screens show before it is approved. */
export const poolFeeAbout = (feerate: number): bigint => POOL_FEE_MASS * BigInt(Math.ceil(feerate));
/** The highest feerate a pool transaction is built at once the screen showed `shown`: half as much again. */
export const feerateCap = (shown: number): number => Math.ceil((Math.ceil(shown) * 3) / 2);

/**
 * The node named a feerate above feerateCap of the one shown: nothing was sent. What a node names sets the fee, and a
 * node that named a low one while the screen asked and a high one at the build would otherwise be paid unseen.
 */
export class PoolFeeAboveShown extends Error {
  constructor(readonly feerate: number, readonly shown: number) {
    super(`The Kaspa node now asks ${feerate} sompi a gram for the network fee, more than half as much again as the ${shown} shown (about ${fmtKas(poolFeeAbout(feerate), 4)} KAS now), so nothing was sent. Check the new figure and try again.`);
  }
}

/** Refuses a build at a feerate above feerateCap of the one the screen showed (when the caller showed one). */
function assertFeerateShown(feerate: number, shown: number | undefined): void {
  if (shown == null) return;
  if (Math.ceil(feerate) > feerateCap(shown)) throw new PoolFeeAboveShown(Math.ceil(feerate), Math.ceil(shown));
}

/**
 * Round 17, R17-CL-1: the build would give the network change too small for it to keep (under 0.2 KAS once the change's
 * own storage is paid, about 0.8 KAS at 2000 sompi a gram), more than ABSORB_LIMIT of it, and the screen showed about
 * `shown`. Nothing was sent; `fee` is what it would have paid, `lost` the change in it.
 */
export class PoolFeeTakesChange extends Error {
  readonly kind = 'fee-takes-change' as const;
  constructor(readonly fee: bigint, readonly lost: bigint, readonly shown: bigint) {
    super(`This would pay ${fmtKas(fee, 4)} KAS to the network, not the about ${fmtKas(shown, 4)} KAS shown: ${fmtKas(lost, 4)} KAS of it is change too small for the network to keep. Nothing was sent. Change the amount a little, so that more of it comes back to you as change.`);
  }
}

/**
 * Holds a pool build's fee to the one shown (when the caller showed one): change it leaves to the network beyond
 * ABSORB_LIMIT is refused, unless its whole fee is at most `accepted`, a fee the screen showed besides (Max says it
 * keeps FEE_KEEP for the network fee). The feerate is held by assertFeerateShown.
 */
function assertChangeKept(built: Built, feerate: number, shown: number | undefined, accepted: bigint | undefined): void {
  if (shown == null) return;
  const lost = built.fee - feeNeeded(built, feerate);
  if (lost <= ABSORB_LIMIT || (accepted != null && built.fee <= accepted)) return;
  throw new PoolFeeTakesChange(built.fee, lost, poolFeeAbout(shown));
}

/** What an approval says when a pool transaction's network fee is a large share of the KAS it moves, or null. */
export function poolFeeShareText(feeAbout: bigint, kas: bigint): string | null {
  if (feeAbout * 10n <= kas) return null;
  return `The network fee is about ${fmtKas(feeAbout, 4)} KAS, more than a tenth of the ${fmtKas(kas, 4)} KAS this moves. The Kaspa node asks a high feerate right now: approve only if that is worth it to you.`;
}

/**
 * A sale that would give what it brings to the network instead of the seller. The core keeps change only from 0.2 KAS
 * and leaves less than that to the fee. A sale of a part of a state pays its proceeds out as change (the state's own
 * KAS goes on under what is not sold), so with no other KAS in the wallet, proceeds that leave under 0.2 KAS after
 * the fee are lost whole. Refused, as is a sale whose network fee is as large as what it brings.
 */
export class SaleLeavesNothing extends Error {
  constructor(readonly kasOut: bigint, readonly fee: bigint) {
    super(fee >= kasOut
      ? `The network fee (about ${fmtKas(fee, 4)} KAS now) is more than the ${fmtKas(kasOut, 4)} KAS this sale brings. Nothing was sent: sell more, or try again when the network is less busy.`
      : `This sale brings ${fmtKas(kasOut, 4)} KAS, and all of it would go to the network fee: after the fee (about ${fmtKas(fee, 4)} KAS) less than 0.2 KAS is left, which the network does not keep as change, and this wallet holds no other KAS to add to it. Nothing was sent: sell more, sell all of your kUSDT, or get some KAS first.`);
  }
}

/**
 * Refuses a sale that leaves nothing (SaleLeavesNothing), for a fee of `fee`. `other`: the plain KAS the wallet holds
 * besides. `whole`: the sale spends all of its kUSDT state, whose own KAS then comes back with the proceeds.
 */
export function assertSaleLeavesSomething(kasOut: bigint, fee: bigint, other: bigint, whole: boolean, stateKas: bigint): void {
  if (fee >= kasOut) throw new SaleLeavesNothing(kasOut, fee);
  if (kasOut - fee + other + (whole ? stateKas : 0n) < CORE_MIN_CHANGE) throw new SaleLeavesNothing(kasOut, fee);
}

function buildSell(ctx: Ctx, signer: Signer, vp: OpenedPool, coins: Awaited<ReturnType<typeof walletCoins>>, payer: Located<TokenState>, tokensIn: bigint, kasOut: bigint, feerate: number, nowDaa: bigint): Built {
  const tokenValue = BigInt(ctx.config.tokenValue);
  const secret = signer.secretFor(signer.address);
  if (!secret) throw new Error('The wallet is locked.');
  const all = tokensIn === payer.state.amount;
  assertSettled(vp.pool.utxo, [{ coin: vp.reserve.utxo, what: 'coin' }, { coin: payer.utxo, what: 'token' }]);
  const built = buildFunded(ctx, signer, coins, 'pool-sell', all ? 0n : tokenValue - payer.utxo.amount, (funding, feerate) => ({
    network: ctx.network, feerate, changeAddress: signer.address, funding,
    pool: { utxo: corePoolUtxo(vp.pool.utxo), state: vp.pool.state },
    reserve: { utxo: toCoreUtxo(vp.reserve.utxo), state: vp.reserve.state },
    payer: { utxo: toCoreUtxo(payer.utxo), state: payer.state, secretKey: secret },
    tokensIn, kasOut, tokenValue, nowDaa,
  }), feerate);
  const tokens = all ? [] : [{ index: 2, state: { ...payer.state, amount: payer.state.amount - tokensIn }, value: tokenValue }];
  // Against the fee the transaction's size needs, not the fee it pays: change the core could not keep (under 0.2 KAS)
  // is in the fee paid, and "the proceeds less the fee paid" is then zero and proves nothing. A sale never gives the
  // network more than its size needs; the transaction is signed by now, and it is dropped here, never sent.
  const need = feeNeeded(built, feerate);
  if (built.fee > need || need >= kasOut) throw new SaleLeavesNothing(kasOut, need);
  checkBuilt(ctx, built, signer, { tokens, covenant: [{ index: 0, kind: 'pool' }, { index: 1, kind: 'reserve' }], minChange: kasOut - need });
  return built;
}

/**
 * Everything a swap on `vp` must pass before anything is built: liquidity, the
 * pause, the circuit breaker (sells, at the wallet's clock), the minimum, and
 * no worse a quote than approved. Answers the amount out and the breaker clock.
 */
export async function swapCheck(ctx: Ctx, vp: VerifiedPool, args: SwapArgs): Promise<{ pool: OpenedPool; out: bigint; nowDaa: bigint }> {
  const pool = openedPool(vp);
  assertNotPaused(pool.pool.state);
  const nowDaa = poolNowDaa(pool, await ctx.node.virtualDaa());
  let out: bigint;
  if (args.side === 'buy') out = quoteBuy(ctx, pool.pool.state, args.amountIn);
  else out = assertSellFits(ctx, pool.pool.state, args.amountIn, nowDaa, pool.pool.utxo.blockDaaScore).kasOut;
  assertMinimum(out, args.minOut);
  assertNotWorse(args.quoted, out);
  return { pool, out, nowDaa };
}

/**
 * Swaps on the newest pool. Buy: `amountIn` sompi for at least `minOut` base
 * units. Sell: `amountIn` base units for at least `minOut` sompi (KAS arrives
 * as change to the wallet's address). A paused pool, a sell above the circuit
 * breaker's room and a quote worse than `quoted` are refused before any merge.
 */
export async function swap(ctx: Ctx, signer: Signer, kasAddresses: string[], args: SwapArgs, onStep?: (txid: string, built: Built) => void): Promise<SwapResult> {
  if (args.amountIn <= 0n) throw new Error('Enter an amount above zero.');
  if (args.amountIn > MAX_SWAP_INPUT) throw new Error('That is more than one swap can take.');
  assertMinimum(args.minOut, args.minOut);
  if (args.side === 'sell' && args.minOut < CORE_MIN_CHANGE) throw new Error('Sell enough kUSDT to receive at least 0.2 KAS.');
  // Checked first on the newest pool, so a refused swap merges nothing.
  const first = await freshPool(ctx);
  const checked = await swapCheck(ctx, first, args);
  if (args.side === 'sell') {
    // And before any key is used: a sale that would only feed the network fee (the build checks again, exactly).
    const [coins, feerate, held] = await Promise.all([walletCoins(ctx, kasAddresses), ctx.node.feerate(), loadTokens(ctx, signer)]);
    const whole = held.states.find(s => s.state.amount === args.amountIn);
    assertSaleLeavesSomething(checked.out, SELL_FEE_MASS * BigInt(Math.ceil(feerate)), coins.reduce((t, c) => t + c.utxo.amount, 0n), !!whole, whole?.utxo.amount ?? 0n);
  }
  // A sell spends one token state: merged first if no single one is enough, each merge at no more than the feerate shown.
  const payer = args.side === 'sell' ? await singleStateFor(ctx, signer, kasAddresses, args.amountIn, onStep, (feerate) => assertFeerateShown(feerate, args.shownFeerate)) : null;
  return withFreshPool(ctx, async (vp, tries, lost) => {
    const { pool, out, nowDaa } = await swapCheck(ctx, await readyPool(ctx, vp), args);
    const [coins, feerate] = await Promise.all([walletCoins(ctx, kasAddresses), ctx.node.feerate()]);
    const built = args.side === 'buy'
      ? buildBuy(ctx, signer, pool, lostFirst(coins, lost), args.amountIn, out, feerate, nowDaa, new Set(lost.flat()))
      : buildSell(ctx, signer, pool, coins, payer!, args.amountIn, out, feerate, nowDaa);
    assertFeerateShown(feerate, args.shownFeerate);
    assertChangeKept(built, feerate, args.shownFeerate, args.acceptedFee);
    assertReplaces(built, lost);
    const { txid, confirmed } = await sendToPool(ctx, built, pool);
    return { txid, amountOut: out, tries, built, confirmed };
  }, MAX_POOL_TRIES, payer ? undefined : first);
}

// ── Liquidity ───────────────────────────────────────────────────────────────

export interface PositionRecord { txid: string; index: number; shares: string; owner: string; tokenCovid: string; at: number }
const POSITIONS_KEY = (network: string) => `kusdt.positions.${network}`;

export async function recordedPositions(network: string): Promise<PositionRecord[]> {
  return (await local.get<PositionRecord[]>(POSITIONS_KEY(network))) ?? [];
}
async function savePositions(network: string, list: PositionRecord[]): Promise<void> {
  await local.set({ [POSITIONS_KEY(network)]: list });
}
async function recordPosition(ctx: Ctx, signer: Signer, txid: string, shares: bigint): Promise<void> {
  const list = await recordedPositions(ctx.network);
  list.push({ txid, index: 1, shares: shares.toString(), owner: signer.ownerHex, tokenCovid: ctx.config.covenantId, at: Date.now() });
  await savePositions(ctx.network, list);
}

export interface Position {
  id: string; located: Located<PositionState>; at: number;
  /**
   * The node could not list this position's address (it holds too many coins, or the read timed out), so it is
   * neither checked nor gone (round 12, R12-WW-1: it was dropped from the list, and so could not be removed).
   * `located` is then a record's: the coordinator's, or the wallet's own of the deposit that made it. A removal
   * built on it is one the node refuses unless the position is there exactly as recorded.
   */
  unread?: boolean;
}

/**
 * The wallet's positions: those `GET /positions` lists for its key, and (as a
 * fallback, for one the coordinator hasn't seen yet or when it is down) those
 * the wallet recorded when it added liquidity. Each is found on the node with
 * the pool's covenant ID at the script the core computes for its state.
 */
export async function loadPositions(ctx: Ctx, signer: Signer): Promise<Position[]> {
  // `kas`: what the position's coin carries, by the record that names it (used only for one the node cannot show).
  const candidates = new Map<string, { txid: string; index: number; state: PositionState; at: number; kas: bigint }>();
  const positionValue = BigInt(ctx.config.positionValue);
  if (ctx.api) {
    try {
      const answer = await ctx.api.positions(signer.ownerHex);
      // With the coordinator's records at an address it cannot read (round 13, R13-CL-1): each is looked for on the
      // node all the same, and shown as not checked where the node cannot show it either. As many as it ever answers.
      for (const p of [...answer.positions, ...(Array.isArray(answer.unread) ? answer.unread : [])].slice(0, MAX_LISTED)) {
        const s = p?.state as any;
        const txid = p?.utxo?.transactionId, index = p?.utxo?.index;
        if (!isHex32(txid) || !Number.isInteger(index) || s?.owner !== signer.ownerHex || s?.tokenCovid !== ctx.config.covenantId) continue;
        let shares: bigint;
        try { shares = toNat(s.shares, 'shares'); } catch { continue; }
        if (shares <= 0n) continue;
        let kas = positionValue;
        try { kas = toNat(p.utxo.amount, 'position value'); } catch { /* the deployment's value */ }
        candidates.set(`${txid}:${index}`, { txid, index: index as number, state: { tokenCovid: s.tokenCovid, shares, owner: s.owner }, at: 0, kas });
      }
    } catch { /* the local record below */ }
  }
  for (const r of await recordedPositions(ctx.network)) {
    if (r.owner !== signer.ownerHex || r.tokenCovid !== ctx.config.covenantId) continue;
    const id = `${r.txid}:${r.index}`;
    const known = candidates.get(id);
    if (known) known.at = r.at;
    else candidates.set(id, { txid: r.txid, index: r.index, state: { tokenCovid: r.tokenCovid, shares: BigInt(r.shares), owner: r.owner }, at: r.at, kas: positionValue });
  }
  const out: Position[] = [];
  for (const [id, c] of candidates) {
    const located = await verifyPosition(ctx, c.txid, c.index, c.state).catch(() => null);
    if (located === UNREAD) {
      // Not placed: neither found in the UTXO set nor only in the mempool, so not marked as a mempool coin (score 0, as
      // in a block). The pool reads only whether such an input is in a block; the node judges that of this one, and
      // refuses a withdrawal on it if it is still in the mempool beside a newer pool coin. Nothing is lost by that.
      out.push({ id, at: c.at, unread: true, located: { state: c.state, utxo: { transactionId: c.txid, index: c.index, amount: c.kas, scriptPublicKey: scriptOf(ctx, 'Position', c.state), blockDaaScore: 0n, isCoinbase: false, covenantId: ctx.config.poolId, confirmed: true, unchecked: true } } });
    } else if (located) out.push({ id, located, at: c.at });
  }
  return out;
}

export interface AddArgs {
  kasIn: bigint;
  tokensIn: bigint;
  /** The hard floor. */
  minShares: bigint;
  /** The shares the user saw and approved: fewer stops with QuoteChanged. */
  quoted: bigint;
  /** As SwapArgs' (R15-CL-3; the merges first held to it too, Daybreak [9]). */
  shownFeerate?: number;
  /** As SwapArgs' (R17-CL-1). */
  acceptedFee?: bigint;
}

/** How far (bps) a deposit's two sides may be from the pool's ratio: what is above it goes to the pool for nothing. */
export const MAX_ADD_RATIO_DRIFT_BPS = 500n;

/** Why a deposit is too far off the pool's ratio to add, or null. Exact integers: kasIn/tokensIn against kasReserve/tokenReserve, cross-multiplied. */
export function addRatioProblem(pool: Pick<PoolState, 'kasReserve' | 'tokenReserve'>, kasIn: bigint, tokensIn: bigint): string | null {
  const a = kasIn * pool.tokenReserve, b = tokensIn * pool.kasReserve;
  const [hi, lo] = a > b ? [a, b] : [b, a];
  if ((hi - lo) * 10_000n <= hi * MAX_ADD_RATIO_DRIFT_BPS) return null;
  return `These amounts are more than ${MAX_ADD_RATIO_DRIFT_BPS / 100n} % off the pool's ratio: what is above the ratio would go to the pool for nothing. Nothing was sent.`;
}

/**
 * What a deposit of up to `kasIn` and `tokensIn` really puts in: the shares the smaller side buys (as the covenant counts
 * them, shares · X ≤ kas · S and shares · Y ≤ tokens · S), and for those shares the least of each side, rounded up. So
 * nothing above the pool's ratio goes to the pool; what is left of either side stays with the wallet. `shares` is what the
 * trimmed amounts buy (at least as many as the untrimmed ones).
 */
export function trimToShares(pool: Pick<PoolState, 'kasReserve' | 'tokenReserve' | 'totalShares'>, kasIn: bigint, tokensIn: bigint): { kasIn: bigint; tokensIn: bigint; shares: bigint } {
  const { kasReserve: x, tokenReserve: y, totalShares: s } = pool;
  if (x <= 0n || y <= 0n || s <= 0n) return { kasIn, tokensIn, shares: 0n };
  const buys = (k: bigint, t: bigint) => { const a = (k * s) / x, b = (t * s) / y; return a < b ? a : b; };
  const target = buys(kasIn, tokensIn);
  if (target <= 0n) return { kasIn, tokensIn, shares: 0n };
  const k = (target * x + s - 1n) / s, t = (target * y + s - 1n) / s;
  return { kasIn: k, tokensIn: t, shares: buys(k, t) };
}

/** What an add on `vp` must pass before anything is built; answers its shares and the amounts it really uses. */
/** An emptied pool (only the locked shares left): its first deposit again takes the admin's signature (SPEC §15). */
export const isEmptied = (s: Pick<PoolState, 'totalShares'>) => s.totalShares === LOCKED_SHARES;

export function addCheck(ctx: Pick<Ctx, 'core'>, vp: VerifiedPool, args: AddArgs, ownerHex?: string): { pool: OpenedPool; shares: bigint; kasIn: bigint; tokensIn: bigint } {
  if (vp.pool.state.totalShares === 0n) throw new Error('The pool has no liquidity yet: open it first.');
  if (isEmptied(vp.pool.state) && ownerHex !== undefined && ownerHex !== vp.pool.state.admin) {
    throw new Error("Every provider has left the pool: only its admin can deposit into it first, which starts its sell cap again. Nothing was sent.");
  }
  const pool = openedPool(vp);
  assertNotPaused(pool.pool.state);
  const off = addRatioProblem(pool.pool.state, args.kasIn, args.tokensIn);
  if (off) throw new Error(off);
  // Only what the shares need: the rest of either side stays with the wallet.
  const used = trimToShares(pool.pool.state, args.kasIn, args.tokensIn);
  const shares = quoteAdd(ctx, pool.pool.state, used.kasIn, used.tokensIn);
  if (shares !== used.shares) throw new Error('The deposit could not be trimmed to the pool ratio. Nothing was sent.');
  assertMinimum(shares, args.minShares);
  assertNotWorse(args.quoted, shares);
  return { pool, shares, kasIn: used.kasIn, tokensIn: used.tokensIn };
}

/**
 * Adds liquidity: at most `kasIn` and `tokensIn`, and only as much of each as the shares need (`trimToShares`, on the
 * pool state it is built on). Answers the amounts really put in.
 */
export async function addLiquidity(ctx: Ctx, signer: Signer, kasAddresses: string[], args: AddArgs, onStep?: (txid: string, built: Built) => void): Promise<{ txid: string; shares: bigint; kasIn: bigint; tokensIn: bigint; built: Built; confirmed: boolean }> {
  if (args.kasIn <= 0n || args.tokensIn <= 0n) throw new Error('Add some KAS and some kUSDT.');
  assertMinimum(args.minShares, args.minShares);
  // Checked first on the newest pool, so a refused deposit merges nothing.
  addCheck(ctx, await freshPool(ctx), args, signer.ownerHex);
  const provider = await singleStateFor(ctx, signer, kasAddresses, args.tokensIn, onStep, (feerate) => assertFeerateShown(feerate, args.shownFeerate));
  const secret = signer.secretFor(signer.address);
  if (!secret) throw new Error('The wallet is locked.');
  const tokenValue = BigInt(ctx.config.tokenValue), positionValue = BigInt(ctx.config.positionValue);
  const result = await withFreshPool(ctx, async (vp, _n, lost) => {
    const { pool, shares, kasIn, tokensIn } = addCheck(ctx, await readyPool(ctx, vp), args, signer.ownerHex);
    // The deposit claims the pool UTXO's age for the breaker, as a swap does.
    const [coins, feerate, virtualDaa] = await Promise.all([walletCoins(ctx, kasAddresses), ctx.node.feerate(), ctx.node.virtualDaa()]);
    const nowDaa = poolNowDaa(pool, virtualDaa);
    assertSettled(pool.pool.utxo, [{ coin: pool.reserve.utxo, what: 'coin' }, { coin: provider.utxo, what: 'token' }]);
    const built = buildFunded(ctx, signer, coins, 'pool-add', kasIn + positionValue + tokenValue - provider.utxo.amount, (funding, feerate) => ({
      network: ctx.network, feerate, changeAddress: signer.address, funding,
      pool: { utxo: corePoolUtxo(pool.pool.utxo), state: pool.pool.state },
      reserve: { utxo: toCoreUtxo(pool.reserve.utxo), state: pool.reserve.state },
      provider: { utxo: toCoreUtxo(provider.utxo), state: provider.state, secretKey: secret },
      kasIn, tokensIn, shares, positionOwner: signer.ownerHex, tokenValue, positionValue, nowDaa,
      ...(isEmptied(pool.pool.state) && { adminSecretKey: secret }),
    }), feerate);
    const pos = built.outputs[1]?.position;
    if (!pos || pos.owner !== signer.ownerHex || toBig(pos.shares) !== shares || pos.tokenCovid !== ctx.config.covenantId || built.outputs[1].value !== positionValue) {
      throw new Error('The built position is not the one approved. Nothing was sent.');
    }
    checkBuilt(ctx, built, signer, {
      tokens: [{ index: 3, state: { ...provider.state, amount: provider.state.amount - tokensIn }, value: tokenValue }],
      covenant: [{ index: 0, kind: 'pool' }, { index: 1, kind: 'position' }, { index: 2, kind: 'reserve' }],
    });
    assertFeerateShown(feerate, args.shownFeerate);
    assertChangeKept(built, feerate, args.shownFeerate, args.acceptedFee);
    assertReplaces(built, lost);
    const { txid, confirmed } = await sendToPool(ctx, built, pool);
    return { txid, shares, kasIn, tokensIn, built, confirmed };
  });
  await recordPosition(ctx, signer, result.txid, result.shares);
  return result;
}

export interface RemoveArgs {
  position: string;
  minKas: bigint;
  minTokens: bigint;
  /** What the user saw and approved: less of either side stops with QuoteChanged. */
  quoted: { kasOut: bigint; tokensOut: bigint };
  /** The node's feerate when the screen showed the fee (poolFeeAbout): a build at more than feerateCap of it is not sent (R15-CL-3). */
  shownFeerate?: number;
  /** As SwapArgs' (R17-CL-1). */
  acceptedFee?: bigint;
}

/** Open while the pool is paused (SPEC §15): only the minimum and the approved quote decide. */
export function removeCheck(ctx: Pick<Ctx, 'core'>, vp: VerifiedPool, shares: bigint, args: RemoveArgs): { pool: OpenedPool; kasOut: bigint; tokensOut: bigint } {
  const pool = openedPool(vp);
  const { kasOut, tokensOut } = quoteRemove(ctx, pool.pool.state, shares);
  if (kasOut < args.minKas || tokensOut < args.minTokens) throw new BelowMinimum(kasOut, args.minKas);
  assertNotWorse(args.quoted, { kasOut, tokensOut });
  return { pool, kasOut, tokensOut };
}

export async function removeLiquidity(ctx: Ctx, signer: Signer, kasAddresses: string[], args: RemoveArgs): Promise<{ txid: string; kasOut: bigint; tokensOut: bigint; built: Built; confirmed: boolean }> {
  const pos = (await loadPositions(ctx, signer)).find(p => p.id === args.position);
  if (!pos) throw new Error('That position was not found in this wallet.');
  const secret = signer.secretFor(signer.address);
  if (!secret) throw new Error('The wallet is locked.');
  const tokenValue = BigInt(ctx.config.tokenValue);
  return withFreshPool(ctx, async (vp, _n, lost) => {
    // While paused a withdrawal needs no minimum claim: it goes at once, and claims 0 (the breaker stands still).
    const { pool, kasOut, tokensOut } = removeCheck(ctx, await readyPool(ctx, vp, READY_WAIT_MS, leastRemoveClaimOf), pos.located.state.shares, args);
    // The withdrawal claims the pool UTXO's age for the breaker, as a swap does (still open while paused).
    const [coins, feerate, virtualDaa] = await Promise.all([walletCoins(ctx, kasAddresses), ctx.node.feerate(), ctx.node.virtualDaa()]);
    const nowDaa = poolNowDaa(pool, virtualDaa, leastRemoveClaimOf(pool.pool.state));
    const received = plainState({ ownerScheme: 0, owner: signer.ownerHex }, tokensOut);
    // A position only in the mempool goes in only beside the pool coin its own deposit made.
    assertSettled(pool.pool.utxo, [{ coin: pool.reserve.utxo, what: 'coin' }, { coin: pos.located.utxo, what: 'position' }]);
    const built = buildFunded(ctx, signer, coins, 'pool-remove', tokenValue - pos.located.utxo.amount - kasOut, (funding, feerate) => ({
      network: ctx.network, feerate, changeAddress: signer.address, funding,
      pool: { utxo: corePoolUtxo(pool.pool.utxo), state: pool.pool.state },
      reserve: { utxo: toCoreUtxo(pool.reserve.utxo), state: pool.reserve.state },
      position: { utxo: toCoreUtxo(pos.located.utxo), state: pos.located.state }, positionSecretKey: secret,
      kasOut, tokensOut, receiver: signer.ownerHex, tokenValue, nowDaa,
    }), feerate);
    checkBuilt(ctx, built, signer, {
      tokens: [{ index: 2, state: received, value: tokenValue }],
      covenant: [{ index: 0, kind: 'pool' }, { index: 1, kind: 'reserve' }],
      // As for a sale: against the fee its size needs, so change left to the fee never counts as paid for.
      minChange: kasOut - feeNeeded(built, feerate),
    });
    assertFeerateShown(feerate, args.shownFeerate);
    assertChangeKept(built, feerate, args.shownFeerate, args.acceptedFee);
    assertReplaces(built, lost);
    const { txid, confirmed } = await sendToPool(ctx, built, pool);
    return { txid, kasOut, tokensOut, built, confirmed };
  });
}

// ── Opening the pool (its first deposit) ────────────────────────────────────

export interface OpenArgs {
  kasIn: bigint; tokensIn: bigint;
  /**
   * The node's feerate when the screen showed the fee: the opening is not built above feerateCap of it, nor is a merge
   * it needs first (Daybreak [9], as a sale or a deposit).
   */
  shownFeerate?: number;
  /** A network fee the screen showed besides (Max keeps FEE_KEEP for it): an opening that leaves change to the network may pay up to it (R17-CL-1). */
  acceptedFee?: bigint;
}

/** What the first deposit makes: the shares the wallet's position gets, the pool's total, and the KAS it locks in new states. */
export function openTerms(ctx: Pick<Ctx, 'config'>, args: OpenArgs): { shares: bigint; totalShares: bigint; positionValue: bigint; reserveValue: bigint; changeValue: bigint } {
  const tokenValue = BigInt(ctx.config.tokenValue);
  return { shares: args.kasIn - LOCKED_SHARES, totalShares: args.kasIn, positionValue: BigInt(ctx.config.positionValue), reserveValue: tokenValue, changeValue: tokenValue };
}

/** What an opening on `vp` must pass before anything is built. */
/** The pool's first deposit takes its admin's signature (SPEC §15): only a wallet whose key is the admin's can make it. */
export const ONLY_THE_ADMIN = "Only the pool's admin can open it: its first deposit takes the admin's signature. Nothing was sent.";

export function openCheck(vp: VerifiedPool, args: OpenArgs, ownerHex?: string): void {
  if (vp.pool.state.totalShares !== 0n || vp.reserve) throw new Error('The pool has liquidity now: someone opened it first. Nothing was sent; check its price and add liquidity instead.');
  if (ownerHex !== undefined && ownerHex !== vp.pool.state.admin) throw new Error(ONLY_THE_ADMIN);
  assertNotPaused(vp.pool.state);
  if (args.kasIn <= LOCKED_SHARES) throw new Error(`Put in more than ${LOCKED_SHARES} sompi of KAS: the first ${LOCKED_SHARES} shares stay in the pool for good.`);
  if (args.tokensIn <= 0n) throw new Error('Put in some kUSDT: together with the KAS it sets the first price.');
}

/**
 * Opens a pool that has no liquidity yet (SPEC §15 `init`): the wallet's KAS
 * and one kUSDT state of its own (merged first if needed) become the reserves
 * and set the first price. The position, owned by the wallet's key, gets
 * `kasIn − 1000` shares; the other 1000 stay unowned for good.
 */
export async function openPool(ctx: Ctx, signer: Signer, kasAddresses: string[], args: OpenArgs, onStep?: (txid: string, built: Built) => void): Promise<{ txid: string; shares: bigint; built: Built; confirmed: boolean }> {
  openCheck(await freshPool(ctx), args, signer.ownerHex);
  // The kUSDT goes in as one state: merged first if no single one is enough, each merge at no more than the feerate shown.
  const provider = await singleStateFor(ctx, signer, kasAddresses, args.tokensIn, onStep, (feerate) => assertFeerateShown(feerate, args.shownFeerate));
  const secret = signer.secretFor(signer.address);
  if (!secret) throw new Error('The wallet is locked.');
  const tokenValue = BigInt(ctx.config.tokenValue), positionValue = BigInt(ctx.config.positionValue);
  const { shares } = openTerms(ctx, args);
  const result = await withFreshPool(ctx, async (vp, _n, lost) => {
    openCheck(vp, args, signer.ownerHex);
    const [coins, feerate] = await Promise.all([walletCoins(ctx, kasAddresses), ctx.node.feerate()]);
    // The pool's own KAS stays with it; the reserve and the change token carry tokenValue each, the position positionValue.
    assertSettled(vp.pool.utxo, [{ coin: provider.utxo, what: 'token' }]);
    const built = buildFunded(ctx, signer, coins, 'pool-init', args.kasIn + positionValue + 2n * tokenValue - provider.utxo.amount, (funding, feerate) => ({
      network: ctx.network, feerate, changeAddress: signer.address, funding,
      pool: { utxo: corePoolUtxo(vp.pool.utxo), state: vp.pool.state },
      provider: { utxo: toCoreUtxo(provider.utxo), state: provider.state, secretKey: secret },
      kasIn: args.kasIn, tokensIn: args.tokensIn, positionOwner: signer.ownerHex, tokenValue, positionValue, adminSecretKey: secret,
    }), feerate);
    assertFeerateShown(feerate, args.shownFeerate);
    // Change too small for the network to keep goes to the fee: not past what was shown (R17-CL-1, as the other pool actions).
    assertChangeKept(built, feerate, args.shownFeerate, args.acceptedFee);
    const next = built.outputs[0]?.pool, pos = built.outputs[1]?.position;
    if (!next || toBig(next.kasReserve) !== args.kasIn || toBig(next.tokenReserve) !== args.tokensIn || toBig(next.totalShares) !== args.kasIn) {
      throw new Error('The built pool is not the one approved. Nothing was sent.');
    }
    if (!pos || pos.owner !== signer.ownerHex || toBig(pos.shares) !== shares || pos.tokenCovid !== ctx.config.covenantId || built.outputs[1].value !== positionValue) {
      throw new Error('The built position is not the one approved. Nothing was sent.');
    }
    const reserve = built.outputs[2];
    const expected = reserveStateOf(ctx.config.poolId, { ...vp.pool.state, kasReserve: args.kasIn, tokenReserve: args.tokensIn, totalShares: args.kasIn });
    if (!reserve?.token || toBig(reserve.token.amount) !== expected.amount || reserve.token.owner !== expected.owner || reserve.token.ownerScheme !== expected.ownerScheme) {
      throw new Error('The built pool reserve is not the one approved. Nothing was sent.');
    }
    checkBuilt(ctx, built, signer, {
      tokens: [{ index: 3, state: { ...provider.state, amount: provider.state.amount - args.tokensIn }, value: tokenValue }],
      covenant: [{ index: 0, kind: 'pool' }, { index: 1, kind: 'position' }, { index: 2, kind: 'reserve' }],
    });
    assertReplaces(built, lost);
    const { txid, confirmed } = await sendToPool(ctx, built, vp);
    return { txid, shares, built, confirmed };
  });
  await recordPosition(ctx, signer, result.txid, result.shares);
  return result;
}

// ── What Max leaves ─────────────────────────────────────────────────────────

/**
 * KAS a pool transaction locks in new states besides the KAS paid in: a buy's
 * new kUSDT state; a deposit's position (its change token carries the
 * provider's own KAS on); an opening's position and the pool's reserve token.
 */
export function lockedKasFor(ctx: Pick<Ctx, 'config'>, kind: 'buy' | 'add' | 'open'): bigint {
  const tokenValue = BigInt(ctx.config.tokenValue), positionValue = BigInt(ctx.config.positionValue);
  return kind === 'buy' ? tokenValue : kind === 'add' ? positionValue : positionValue + tokenValue;
}

/** The most KAS a form's Max puts in: spendable less what the transaction locks and FEE_KEEP. */
export function maxKasIn(ctx: Pick<Ctx, 'config'>, kind: 'buy' | 'add' | 'open', spendable: bigint): bigint {
  const left = spendable - lockedKasFor(ctx, kind) - FEE_KEEP;
  return left > 0n ? left : 0n;
}

/**
 * The network fee a buy may pay beyond the one at the feerate shown: FEE_KEEP, when it puts in the form's Max or more
 * (maxKasIn of `spendable`), which keeps FEE_KEEP for the fee, change the network does not keep included (R17-CL-1).
 * Undefined for any other swap. The wallet's own Swap screen and, since round 18 (R18-CL-2), a site's buy in the
 * approval window: a site's Max is the same rule on the balance the wallet gave it, and the window passed no fee, so a
 * Max buy through the web app was refused at every try while the feerate was high. A site's figure is never taken
 * for it: the window works it out from this wallet's own coins.
 */
export function maxBuyAcceptedFee(ctx: Pick<Ctx, 'config'>, side: 'buy' | 'sell', amountIn: bigint, spendable: bigint | null | undefined): bigint | undefined {
  if (side !== 'buy' || spendable == null) return undefined;
  const max = maxKasIn(ctx, 'buy', spendable);
  return max > 0n && amountIn >= max ? FEE_KEEP : undefined;
}
