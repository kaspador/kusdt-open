// KasPool math in exact integers, mirroring contracts/pool.ag.

export const BPS = 10_000n;
export const FEE_BPS = 50n;
export const PROTOCOL_BPS = 5n;
export const MIN_LIQUIDITY = 1_000n;
/** 2^61 - 1: the largest reserve, share count or amount the covenant's products accept. */
export const MAX_OPERAND = 2_305_843_009_213_693_951n;
/**
 * How far behind the virtual DAA the breaker's clock is taken: about 1 s at 10
 * blocks a second, so a swap's relative lock is met on nodes a moment behind the
 * one asked, while swaps more than 1 s apart can still claim their age (SPEC §15).
 * Never below the least claim: at the first DAA the lock allows, a client claims
 * exactly that (`clientNowDaa`). The wallet and the web app use the same.
 */
export const SELL_DAA_MARGIN = 10n;
/** While more than half of the cap is in use every public entry claims at least windowLen / MIN_AGE_PARTS of age (pool.ag). */
export const MIN_AGE_PARTS = 720n;

export interface PoolState {
  tokenCovid: string;
  kasReserve: bigint;
  tokenReserve: bigint;
  totalShares: bigint;
  protocolKas: bigint;
  protocolTokens: bigint;
  baseValue: bigint;
  admin: string;
  /** The circuit breaker (fixed at genesis): the cap is this share (bps) of the KAS reserve. */
  maxOutBps: bigint;
  /** The DAA it takes one full cap to refill. */
  windowLen: bigint;
  /** The room recent buys gave sells that is still KAS those buys left in the reserve: a withdrawal moves that much back onto windowOut (SPEC §15). */
  windowCredit: bigint;
  /** The KAS reserve the cap is measured on: set by the first deposit, then down with the reserve at once and up with claimed time. */
  windowRef: bigint;
  /** The allowance used, in net KAS (negative after net buying, at most one cap; a positive count is cut to a smaller cap only by a withdrawal that shrinks the pool). */
  windowOut: bigint;
  /** Swaps and new liquidity stop while paused; withdrawals don't. */
  paused: boolean;
  /** May pause, nothing else. */
  guardian: string;
}

export const effective = (amountIn: bigint) => (amountIn * (BPS - FEE_BPS)) / BPS;
export const protocolCut = (amountIn: bigint) => (amountIn * PROTOCOL_BPS) / BPS;

/** kUSDT out for `kasIn` sompi in. */
export function buyQuote(p: PoolState, kasIn: bigint): bigint {
  const e = effective(kasIn);
  return (p.tokenReserve * e) / (p.kasReserve + e);
}

/** Sompi out for `tokensIn` base units in. */
export function sellQuote(p: PoolState, tokensIn: bigint): bigint {
  const e = effective(tokensIn);
  return (p.kasReserve * e) / (p.tokenReserve + e);
}

/** The most one swap may take in (pool.ag's MAX_SWAP_INPUT: `amount × 10⁴` fits in 64 bits). */
const SWAP_INPUT_MOST = MAX_OPERAND / BPS;

/**
 * KAS in needed to receive at least `tokensOut` (smallest such amount). Throws when no swap the covenant takes
 * (at most SWAP_INPUT_MOST in) buys that much: until run 20 (ONC-1) the search stopped at 1,000 times the KAS
 * reserve and answered its bound, which bought less than asked, or an amount over what one swap may take.
 */
export function buyCost(p: PoolState, tokensOut: bigint): bigint {
  if (tokensOut >= p.tokenReserve) throw new Error('the pool does not hold that much kUSDT');
  let lo = 1n, hi = SWAP_INPUT_MOST;
  while (lo < hi) {
    const mid = (lo + hi) / 2n;
    if (buyQuote(p, mid) >= tokensOut) hi = mid; else lo = mid + 1n;
  }
  if (buyQuote(p, lo) < tokensOut) throw new Error('one swap cannot buy that much kUSDT');
  return lo;
}

export function addQuote(p: PoolState, kasIn: bigint, tokensIn: bigint): bigint {
  const byKas = (kasIn * p.totalShares) / p.kasReserve;
  const byTokens = (tokensIn * p.totalShares) / p.tokenReserve;
  return byKas < byTokens ? byKas : byTokens;
}

export function removeQuote(p: PoolState, shares: bigint): { kasOut: bigint; tokensOut: bigint } {
  return { kasOut: (shares * p.kasReserve) / p.totalShares, tokensOut: (shares * p.tokenReserve) / p.totalShares };
}

/** Spot price in kUSDT base units per KAS (×1e8 sompi), as a float for display only. */
export function priceKusdtPerKas(p: PoolState): number {
  return p.kasReserve === 0n ? 0 : Number(p.tokenReserve * 100_000_000n) / Number(p.kasReserve) / 1e6;
}

/** The successor of a buy claiming `elapsed` DAA of the pool UTXO's age, as the covenant forces it. */
export function afterBuy(p: PoolState, kasIn: bigint, tokensOut: bigint, elapsed = 0n): PoolState {
  const cut = protocolCut(kasIn);
  return { ...p, kasReserve: p.kasReserve + kasIn - cut, tokenReserve: p.tokenReserve - tokensOut, protocolKas: p.protocolKas + cut, ...breakerAfterBuy(p, kasIn - cut, elapsed) };
}

/** The reference after `elapsed` DAA: down to the reserve at once, up toward it by elapsed / windowLen of the gap. */
function advancedRef(p: PoolState, elapsed: bigint): bigint {
  if (p.kasReserve <= p.windowRef) return p.kasReserve;
  const room = p.kasReserve - p.windowRef;
  const gap = room < p.windowRef ? room : p.windowRef; // at most its own size per window
  return elapsed < p.windowLen ? p.windowRef + (gap * elapsed) / p.windowLen : p.windowRef + gap;
}
const shareOf = (p: PoolState, base: bigint) => (base * p.maxOutBps) / BPS;

/** `used` after `elapsed` DAA at `cap` per window: toward zero, never past it. Credit stays within one cap; a positive count is never cut. */
function settledOut(used: bigint, elapsed: bigint, cap: bigint, windowLen: bigint): bigint {
  let v = used < -cap ? -cap : used;
  const decay = (elapsed * cap) / windowLen;
  if (v > 0n) { v -= decay; if (v < 0n) v = 0n; } else if (v < 0n) { v += decay; if (v > 0n) v = 0n; }
  return v;
}

/** What is left of `credit` once `stored` has settled to `settled`: credit that lapsed with claimed time is gone from both. Time no spend claims takes none of it. */
function creditLeft(credit: bigint, stored: bigint, settled: bigint): bigint {
  if (stored >= 0n) return credit;
  const left = credit - (settled - stored);
  return left > 0n ? left : 0n;
}

/**
 * The breaker's clock (SPEC §15): how much of the pool UTXO's age a swap built at
 * `nowDaa` can claim, at most two windows. `poolDaa` is the DAA score the UTXO was
 * accepted at; without one (a pool UTXO only in the mempool) it claims no time.
 */
export function elapsedFor(p: PoolState, nowDaa: bigint, poolDaa?: bigint | null): bigint {
  if (poolDaa === undefined || poolDaa === null || poolDaa === 0n) return 0n;
  const age = nowDaa - poolDaa;
  return age < 0n ? 0n : age > 2n * p.windowLen ? 2n * p.windowLen : age;
}

/** The shortest age a public entry may claim while more than half of the cap is in use, and the shortest a tick ever claims: windowLen / 720, at least 1 (50 DAA at 36 000). */
export function minAge(p: Pick<PoolState, 'windowLen'>): bigint {
  const least = p.windowLen / MIN_AGE_PARTS;
  return least < 1n ? 1n : least;
}

type ClaimState = Pick<PoolState, 'windowLen' | 'windowOut' | 'windowRef' | 'maxOutBps'>;

/**
 * pool.ag require_claim's condition, on the stored values: more than half of the cap in use (windowOut above half of
 * maxOutBps of windowRef). Below it sells have at least half of the cap left, and a spend may claim nothing.
 */
export function aboveHalfCap(p: Omit<ClaimState, 'windowLen'>): boolean {
  return p.windowOut > (p.windowRef * p.maxOutBps) / BPS / 2n;
}

/** What a buy, sell, add or remove on this state must claim at least: the minimum while more than half of the cap is in use, else nothing. */
export function leastClaim(p: ClaimState): bigint {
  return aboveHalfCap(p) ? minAge(p) : 0n;
}

/** What a remove must claim at least: nothing while the pool is paused (it claims exactly 0 then: the breaker stands still, and the pause never holds providers in), else `leastClaim`. */
export function leastRemoveClaim(p: ClaimState & Pick<PoolState, 'paused'>): bigint {
  return p.paused ? 0n : leastClaim(p);
}

/**
 * The DAA score from which a public entry can spend this pool UTXO, accepted at `poolDaa`: its acceptance plus the
 * least claim (`least`, by default `leastClaim`). Null when a claim is needed and the UTXO is only in the mempool (it
 * has no age to prove): wait until it is accepted. A node refuses a transaction whose relative lock is not met yet; it
 * does not hold it, so a client sends at this DAA and sends again if its node says the lock is not met.
 */
export function readyAtDaa(p: PoolState, poolDaa?: bigint | null, least = leastClaim(p)): bigint | null {
  if (poolDaa === undefined || poolDaa === null || poolDaa === 0n) return least === 0n ? 0n : null;
  return poolDaa + least;
}

/**
 * The clock a client builds a pool transaction with at virtual DAA `virtualDaa`: SELL_DAA_MARGIN behind it, but never
 * below the least claim, so at the first DAA the lock allows it claims exactly that and meets any other client or bot
 * there (no margin on the lock). Null before that DAA (or while a claim is needed and the UTXO is unaccepted).
 */
export function clientNowDaa(p: PoolState, virtualDaa: bigint, poolDaa?: bigint | null, least = leastClaim(p)): bigint | null {
  const ready = readyAtDaa(p, poolDaa, least);
  if (ready === null || virtualDaa < ready) return null;
  const clock = virtualDaa > SELL_DAA_MARGIN ? virtualDaa - SELL_DAA_MARGIN : 0n;
  return clock > ready ? clock : ready;
}

/**
 * The age a public entry built at `nowDaa` claims on a pool UTXO accepted at `poolDaa` (`elapsedFor`), or null when
 * that is below what the covenant takes (`least`, by default `leastClaim`): then nothing can be sent yet, and the
 * caller waits for `readyAtDaa` (and for the UTXO to be accepted at all).
 */
export function claimFor(p: PoolState, nowDaa: bigint, poolDaa?: bigint | null, least = leastClaim(p)): bigint | null {
  const elapsed = elapsedFor(p, nowDaa, poolDaa);
  return elapsed >= least ? elapsed : null;
}

/**
 * The breaker's reference and allowance after a buy adding `kasAdded` to the reserve,
 * claiming `elapsed` DAA, as the covenant computes them: a buy gives sells that much
 * room, at most one cap, adds nothing to the reference, and records what it really credited.
 */
export function breakerAfterBuy(p: PoolState, kasAdded: bigint, elapsed = 0n): { windowRef: bigint; windowOut: bigint; windowCredit: bigint } {
  const ref = advancedRef(p, elapsed);
  const cap = shareOf(p, ref);
  const settled = settledOut(p.windowOut, elapsed, cap, p.windowLen);
  let next = settled - kasAdded;
  if (next < -cap) next = -cap;
  const credit = creditLeft(p.windowCredit, p.windowOut, settled) + (settled - next);
  return { windowRef: ref, windowOut: next, windowCredit: credit > MAX_OPERAND ? MAX_OPERAND : credit };
}

/**
 * The breaker after `elapsed` DAA of claimed time and nothing else, as the covenant computes it: what a tick leaves,
 * and how add and remove settle it before their own effect.
 */
export function breakerSettled(p: PoolState, elapsed: bigint): { windowRef: bigint; windowOut: bigint; windowCredit: bigint } {
  const ref = advancedRef(p, elapsed);
  const settled = settledOut(p.windowOut, elapsed, shareOf(p, ref), p.windowLen);
  return { windowRef: ref, windowOut: settled, windowCredit: creditLeft(p.windowCredit, p.windowOut, settled) };
}

/**
 * The breaker a withdrawal of `kasOut` claiming `elapsed` DAA leaves: settled first, then that much of recent buys'
 * credit goes back on the count, and a pool shrunk below the reference cuts the count to two of its smaller caps.
 */
export function breakerAfterRemove(p: PoolState, kasOut: bigint, elapsed = 0n): { windowRef: bigint; windowOut: bigint; windowCredit: bigint } {
  // While paused the breaker stands still: the claim is 0 and nothing settles.
  const settled = p.paused ? { windowRef: p.windowRef, windowOut: p.windowOut, windowCredit: p.windowCredit } : breakerSettled(p, elapsed);
  const reclaimed = kasOut < settled.windowCredit ? kasOut : settled.windowCredit;
  const reserve = p.kasReserve - kasOut;
  const count = settled.windowOut + reclaimed;
  if (reserve >= settled.windowRef) return { windowRef: settled.windowRef, windowOut: count, windowCredit: settled.windowCredit - reclaimed };
  // A smaller pool refills a smaller allowance: the count is cut down to two of its caps, which leaves no room and no long stall either.
  const limit = 2n * shareOf(p, reserve);
  return { windowRef: reserve, windowOut: count > limit ? limit : count, windowCredit: settled.windowCredit - reclaimed };
}

/**
 * The successor of an add claiming `elapsed` DAA, as the covenant forces it: the breaker settled, then the liquidity in.
 * Into an emptied pool (only the MIN_LIQUIDITY unowned shares left; the admin's deposit) the reference starts again at
 * the new reserve, as init's does.
 */
export function afterAdd(p: PoolState, kasIn: bigint, tokensIn: bigint, shares: bigint, elapsed = 0n): PoolState {
  const next = { ...p, kasReserve: p.kasReserve + kasIn, tokenReserve: p.tokenReserve + tokensIn, totalShares: p.totalShares + shares, ...breakerSettled(p, elapsed) };
  return isEmptied(p) ? { ...next, windowRef: next.kasReserve } : next;
}

/** An emptied pool: only the MIN_LIQUIDITY unowned shares left. Its first deposit takes the admin's signature (pool.ag add). */
export const isEmptied = (p: Pick<PoolState, 'totalShares'>) => p.totalShares === MIN_LIQUIDITY;

/** The successor of a remove of `shares` paying `kasOut` and `tokensOut`, claiming `elapsed` DAA, as the covenant forces it. */
export function afterRemove(p: PoolState, shares: bigint, kasOut: bigint, tokensOut: bigint, elapsed = 0n): PoolState {
  return { ...p, kasReserve: p.kasReserve - kasOut, tokenReserve: p.tokenReserve - tokensOut, totalShares: p.totalShares - shares, ...breakerAfterRemove(p, kasOut, elapsed) };
}

/** The successor of a tick claiming `elapsed` DAA: the breaker settled, nothing else. */
export function afterTick(p: PoolState, elapsed: bigint): PoolState {
  return { ...p, ...breakerSettled(p, elapsed) };
}

/** The breaker a sell of `kasOut` claiming `elapsed` DAA leaves, as the covenant computes it. */
export function windowAfter(p: PoolState, kasOut: bigint, elapsed: bigint): { windowCredit: bigint; windowRef: bigint; windowOut: bigint } {
  const ref = advancedRef(p, elapsed);
  const used = settledOut(p.windowOut, elapsed, shareOf(p, ref), p.windowLen);
  const afterReserve = p.kasReserve - kasOut;
  const credit = creditLeft(p.windowCredit, p.windowOut, used) - kasOut;
  return { windowCredit: credit > 0n ? credit : 0n, windowRef: ref < afterReserve ? ref : afterReserve, windowOut: used + kasOut };
}

/**
 * What sells may still take out of the KAS reserve at `nowDaa` (sompi), for a pool
 * UTXO accepted at `poolDaa`, and the DAA score at which the allowance is full again.
 * `readyAtDaa`: from when a sell can be sent at all (null while the pool UTXO is only
 * in the mempool and a claim is needed); before it, the room is what it will be then.
 */
export function sellCapacity(p: PoolState, nowDaa: bigint, poolDaa?: bigint | null): { maxKasOut: bigint; windowEndsDaa: bigint; readyAtDaa: bigint | null } {
  const ready = readyAtDaa(p, poolDaa);
  const least = leastClaim(p);
  let elapsed = elapsedFor(p, nowDaa, poolDaa);
  if (elapsed < least) elapsed = least;
  const cap = shareOf(p, advancedRef(p, elapsed));
  const used = settledOut(p.windowOut, elapsed, cap, p.windowLen);
  const left = cap - used;
  const windowEndsDaa = used <= 0n || cap === 0n ? nowDaa : nowDaa + (used * p.windowLen + cap - 1n) / cap;
  return { maxKasOut: left > 0n ? left : 0n, windowEndsDaa, readyAtDaa: ready };
}

/** The successor of a sell claiming `elapsed` DAA (the breaker included), as the covenant forces it. */
export function afterSell(p: PoolState, tokensIn: bigint, kasOut: bigint, elapsed: bigint): PoolState {
  const cut = protocolCut(tokensIn);
  return {
    ...p, kasReserve: p.kasReserve - kasOut, tokenReserve: p.tokenReserve + tokensIn - cut, protocolTokens: p.protocolTokens + cut,
    ...windowAfter(p, kasOut, elapsed),
  };
}
