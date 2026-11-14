import { describe, expect, it } from 'vitest';
import { FakeNode, COVENANT, POOL, devKey, fakeApi, testCtx, signerFor, kasCoin, core, lastBuilt } from './helpers';
import { p2shAddressOf, scriptOf, reserveStateOf, poolValue, verifyPool } from '@/kusdt/verify';
import {
  POOL_WAIT, assertMinimum, BelowMinimum, BreakerLimit, FEE_KEEP, LOCKED_SHARES, PoolBusy, PoolPaused, QuoteChanged, SELL_DAA_MARGIN, addCheck, addLiquidity, largestSellWithin, leastClaimOf, lockedKasFor,
  maxKasIn, minimumFor, openPool, poolReady, quoteAdd, quoteBuy, quoteRemove, quoteSell, quoteSellAt, readyPool, removeCheck, removeLiquidity, sellNowDaa, swap, swapCheck, tokensForKas, withFreshPool, windowOver,
} from '@/kusdt/pool';
import { NodeRejected } from '@/kaspa/node';
import { emptyStatesOf, loadTokens, sweepEmptyStates } from '@/kusdt/tokens';
import { trimToShares } from '@/kusdt/pool';
import { plainState } from '@/kusdt/owner';
import type { PoolState } from '@/kusdt/types';
import type { FakeNode as FN } from './helpers';

const alice = devKey('alice');
POOL_WAIT.ms = 0;
POOL_WAIT.perDaaMs = 0;
const KAS = 100_000_000n;
const base: PoolState = { tokenCovid: COVENANT, kasReserve: 200n * KAS, tokenReserve: 20_000_000n, totalShares: 200n * KAS, protocolKas: 0n, protocolTokens: 0n, baseValue: KAS, admin: '11'.repeat(32), maxOutBps: 1_000n, windowLen: 36_000n, windowCredit: 0n, windowRef: 0n, windowOut: 0n, paused: false, guardian: '22'.repeat(32) };
/** Never opened: what pool genesis leaves (SPEC §15). */
const unopened: PoolState = { ...base, kasReserve: 0n, tokenReserve: 0n, totalShares: 0n };
/** The same, with this wallet's key as the pool's admin: the first deposit takes the admin's signature. */
const unopenedByAlice: PoolState = { ...unopened, admin: alice.xonly };
/** FakeNode's virtual DAA is 1 000 000: the wallet's clock is 10 behind it. */
const NOW = 1_000_000n - SELL_DAA_MARGIN;
/** A breaker with 15 of its 20 KAS (10 % of 200) already used: 5 KAS left, on a pool UTXO the wallet sees as new. */
const windowed: PoolState = { ...base, windowRef: 200n * KAS, windowOut: 15n * KAS };
/** While more than half of the cap is in use (15 of 20 KAS here) a pool transaction claims at least 50 DAA (36 000 / 720), which refills 50/36 000 of the 20 KAS cap. */
const MIN_AGE = 50n;
const REFILL_50 = (20n * KAS * MIN_AGE) / 36_000n;

describe('quotes', () => {
  it('are the constant-product formulas with the 0.50 % fee, exactly as the covenant checks them', () => {
    const eff = (x: bigint) => (x * 9_950n) / 10_000n;
    const kasIn = 10n * KAS;
    expect(quoteBuy({ core }, base, kasIn)).toBe((base.tokenReserve * eff(kasIn)) / (base.kasReserve + eff(kasIn)));
    expect(quoteSell({ core }, base, 2_000_000n)).toBe((base.kasReserve * eff(2_000_000n)) / (base.tokenReserve + eff(2_000_000n)));
    const t = tokensForKas(base, 20n * KAS);
    expect(quoteAdd({ core }, base, 20n * KAS, t)).toBe(20n * KAS); // even deposit: the KAS side decides
    expect(quoteRemove({ core }, base, base.totalShares / 10n)).toEqual({ kasOut: base.kasReserve / 10n, tokensOut: base.tokenReserve / 10n });
  });

  it('keep amounts above 2^53 exact', () => {
    const big = { ...base, kasReserve: 9_000_000_000_000_000n, tokenReserve: 900_000_000_000_000n, totalShares: 9_000_000_000_000_000n };
    const q = quoteBuy({ core }, big, 1_000_000_000_000_000n);
    const eff = (1_000_000_000_000_000n * 9_950n) / 10_000n;
    expect(q).toBe((big.tokenReserve * eff) / (big.kasReserve + eff));
  });
});

describe('minimum to receive', () => {
  it('rounds down at the chosen slippage', () => {
    expect(minimumFor(1_000_000n, 50)).toBe(995_000n);
    expect(minimumFor(999n, 100)).toBe(989n);
    expect(minimumFor(1_000n, 0)).toBe(1_000n);
    expect(() => minimumFor(1_000n, 6_000)).toThrow();
  });

  it('refuses below the minimum, and a zero minimum', () => {
    expect(() => assertMinimum(994n, 995n)).toThrow(BelowMinimum);
    expect(() => assertMinimum(995n, 995n)).not.toThrow();
    expect(() => assertMinimum(5n, 0n)).toThrow(/above zero/);
  });
});

// A pool the fake node holds, at outpoint txid:0 (reserve at txid:1; none for a pool never opened).
function placePool(node: FN, ctx: ReturnType<typeof testCtx>, txid: string, pool: PoolState) {
  const pspk = scriptOf(ctx, 'Pool', pool);
  node.utxoSet.push({ address: p2shAddressOf(pspk, 'kaspasim'), transactionId: txid, index: 0, amount: poolValue(pool), scriptPublicKey: pspk, blockDaaScore: 999_990n, isCoinbase: false, covenantId: POOL });
  if (pool.totalShares === 0n) return { pool: { utxo: { transactionId: txid, index: 0 }, state: pool }, reserve: null };
  const reserve = reserveStateOf(POOL, pool);
  const rspk = scriptOf(ctx, 'KCC20', reserve);
  node.utxoSet.push({ address: p2shAddressOf(rspk, 'kaspasim'), transactionId: txid, index: 1, amount: 150_000_000n, scriptPublicKey: rspk, blockDaaScore: 1n, isCoinbase: false, covenantId: COVENANT });
  return { pool: { utxo: { transactionId: txid, index: 0 }, state: pool }, reserve: { utxo: { transactionId: txid, index: 1 }, state: reserve } };
}

/** One of the wallet's kUSDT states, on the node and in the coordinator's list. */
function tokenOf(ctx: ReturnType<typeof testCtx>, txid: string, amount: bigint) {
  const state = plainState({ ownerScheme: 0, owner: alice.xonly }, amount);
  const spk = scriptOf(ctx, 'KCC20', state);
  return {
    utxo: { address: p2shAddressOf(spk, 'kaspasim'), transactionId: txid, index: 0, amount: 150_000_000n, scriptPublicKey: spk, blockDaaScore: 5n, isCoinbase: false, covenantId: COVENANT },
    listed: { utxo: { transactionId: txid, index: 0 }, state: { ...state, amount: amount.toString() } },
  };
}

/** Puts the covenant outputs of the transaction just built on the node (what confirming it does). */
function landLast(node: FN) {
  const v = lastBuilt.value;
  for (const o of v.outputs) {
    if (!/^0000aa20[0-9a-f]{64}87$/.test(o.scriptPublicKey)) continue;
    node.utxoSet.push({ address: p2shAddressOf(o.scriptPublicKey, 'kaspasim'), transactionId: v.txid, index: o.index, amount: BigInt(o.value), scriptPublicKey: o.scriptPublicKey, blockDaaScore: 2n, isCoinbase: false, covenantId: o.kind === 'pool' || o.kind === 'position' ? POOL : COVENANT });
  }
}

let coinNo = 0;
const uniq = (c: string) => (++coinNo).toString(16).padStart(64, c);
function scenario(states: PoolState[], tokens: bigint[] = []) {
  const node = new FakeNode();
  let current = 0;
  const listed: any[] = [];
  const txids = states.map((_, i) => uniq(String((i % 9) + 1)));
  const answers: any[] = states.map(() => null);
  const api = fakeApi({ pool: async () => answers[current], tokens: async () => ({ states: listed }) });
  const ctx = testCtx(node, api);
  // Shows pool state i: the one before it is spent (gone from the node), this one is there.
  const show = (i: number) => {
    current = i;
    node.utxoSet = node.utxoSet.filter(u => !txids.includes(u.transactionId));
    answers[i] = placePool(node, ctx, txids[i], states[i]);
  };
  show(0);
  node.utxoSet.push(kasCoin(alice, uniq('e'), 1_000n * KAS), kasCoin(alice, uniq('e'), 1_000n * KAS));
  for (const amount of tokens) { const t = tokenOf(ctx, uniq('d'), amount); node.utxoSet.push(t.utxo); listed.push(t.listed); }
  return { node, ctx, show, answers };
}

describe('a swap on a stale pool state', () => {
  const moved: PoolState = { ...base, kasReserve: base.kasReserve + 5n * KAS, tokenReserve: base.tokenReserve - 450_000n };
  const better: PoolState = { ...base, tokenReserve: base.tokenReserve + 450_000n };

  it('rebuilds on the newest state and goes ahead on its own when the new quote is at least the one approved', async () => {
    const { node, ctx, show, answers } = scenario([base, better]);
    let calls = 0;
    node.submitImpl = async () => {
      calls++;
      if (calls === 1) { show(1); throw new NodeRejected('transaction is a double spend'); }
      return lastBuilt.txid;
    };
    const kasIn = 10n * KAS;
    const seen = quoteBuy(ctx, base, kasIn);
    const r = await swap(ctx, signerFor(alice), [alice.address], { side: 'buy', amountIn: kasIn, minOut: minimumFor(seen, 100), quoted: seen });
    expect(r.tries).toBe(2);
    expect(r.amountOut).toBe(quoteBuy(ctx, better, kasIn));
    expect(r.amountOut).toBeGreaterThan(seen);
    // The second transaction spends the new pool state.
    expect(node.submitted[1]).toContain('"transactionId":"' + answers[1].pool.utxo.transactionId + '"');
  });

  it('stops with the new numbers when the new quote is worse than the one approved, even above the minimum; the confirmed new quote goes ahead', async () => {
    const { node, ctx, show } = scenario([base, moved]);
    let calls = 0;
    node.submitImpl = async () => {
      calls++;
      if (calls === 1) { show(1); throw new NodeRejected('transaction is a double spend'); }
      return lastBuilt.txid;
    };
    const kasIn = 10n * KAS;
    const seen = quoteBuy(ctx, base, kasIn), now = quoteBuy(ctx, moved, kasIn);
    const minOut = minimumFor(seen, 1_000); // 10 %: the new quote is well above it
    expect(now).toBeGreaterThan(minOut);
    const e = await swap(ctx, signerFor(alice), [alice.address], { side: 'buy', amountIn: kasIn, minOut, quoted: seen }).catch(x => x);
    expect(e).toBeInstanceOf(QuoteChanged);
    expect(e.seen).toBe(seen);
    expect(e.now).toBe(now);
    expect(node.submitted).toHaveLength(1); // nothing more was sent
    // The user confirms the new numbers: it goes ahead on them.
    const r = await swap(ctx, signerFor(alice), [alice.address], { side: 'buy', amountIn: kasIn, minOut, quoted: now });
    expect(r.amountOut).toBe(now);
    expect(node.submitted).toHaveLength(2);
  });

  it('asks again before even the first attempt when the newest pool already quotes less than what the user saw', async () => {
    const { node, ctx } = scenario([moved]);
    const kasIn = 10n * KAS;
    const seen = quoteBuy(ctx, base, kasIn);
    await expect(swap(ctx, signerFor(alice), [alice.address], { side: 'buy', amountIn: kasIn, minOut: 1n, quoted: seen })).rejects.toBeInstanceOf(QuoteChanged);
    expect(node.submitted).toHaveLength(0);
  });

  it('refuses to submit when the new state pays less than the minimum', async () => {
    const { node, ctx, show } = scenario([base, moved]);
    node.submitImpl = async () => { show(1); throw new NodeRejected('transaction is a double spend'); };
    const kasIn = 10n * KAS;
    const exact = quoteBuy(ctx, base, kasIn);
    await expect(swap(ctx, signerFor(alice), [alice.address], { side: 'buy', amountIn: kasIn, minOut: exact, quoted: exact })).rejects.toThrow(BelowMinimum);
    expect(node.submitted).toHaveLength(1);
  });

  it('stops after 3 tries in all', async () => {
    const states = [base, better, { ...better, tokenReserve: better.tokenReserve + 1n }, { ...better, tokenReserve: better.tokenReserve + 2n }];
    const { node, ctx, show } = scenario(states);
    let n = 0;
    node.submitImpl = async () => { show(++n); throw new NodeRejected('double spend'); };
    await expect(swap(ctx, signerFor(alice), [alice.address], { side: 'buy', amountIn: KAS, minOut: 1n, quoted: 1n })).rejects.toThrow(/3 times/);
    expect(node.submitted).toHaveLength(3);
  });

  it('does not retry a refusal while the pool is unchanged', async () => {
    const { node, ctx } = scenario([base]);
    node.submitImpl = async () => { throw new NodeRejected('some other rule'); };
    await expect(swap(ctx, signerFor(alice), [alice.address], { side: 'buy', amountIn: KAS, minOut: 1n, quoted: 1n })).rejects.toThrow(/some other rule/);
    expect(node.submitted).toHaveLength(1);
  });

  it('withFreshPool passes other errors straight through', async () => {
    const { ctx } = scenario([base]);
    let n = 0;
    await expect(withFreshPool(ctx, async () => { n++; throw new Error('boom'); })).rejects.toThrow('boom');
    expect(n).toBe(1);
  });
});

describe('liquidity quotes that got worse', () => {
  it('an add for fewer shares than approved asks again; as many or more goes ahead', async () => {
    const { ctx } = scenario([base]);
    const vp = await verifyPool(ctx, await ctx.api!.pool());
    const kasIn = 20n * KAS, tokensIn = tokensForKas(base, kasIn);
    const shares = quoteAdd(ctx, base, kasIn, tokensIn);
    expect(addCheck(ctx, vp, { kasIn, tokensIn, minShares: 1n, quoted: shares }).shares).toBe(shares);
    const e = (() => { try { addCheck(ctx, vp, { kasIn, tokensIn, minShares: 1n, quoted: shares + 1n }); } catch (x) { return x; } })() as QuoteChanged;
    expect(e).toBeInstanceOf(QuoteChanged);
    expect([e.seen, e.now]).toEqual([shares + 1n, shares]);
  });

  it('a removal asks again for less of either side, and is open while the pool is paused', async () => {
    const { ctx } = scenario([{ ...base, paused: true }]);
    const vp = await verifyPool(ctx, await ctx.api!.pool());
    const shares = base.totalShares / 10n;
    const q = quoteRemove(ctx, base, shares);
    expect(removeCheck(ctx, vp, shares, { position: 'x', minKas: 1n, minTokens: 1n, quoted: q })).toMatchObject(q);
    expect(() => removeCheck(ctx, vp, shares, { position: 'x', minKas: 1n, minTokens: 1n, quoted: { ...q, tokensOut: q.tokensOut + 1n } })).toThrow(QuoteChanged);
    expect(() => removeCheck(ctx, vp, shares, { position: 'x', minKas: 1n, minTokens: 1n, quoted: { kasOut: q.kasOut + 1n, tokensOut: q.tokensOut - 5n } })).toThrow(QuoteChanged);
  });
});

describe('a paused pool (SPEC §15)', () => {
  it('takes no swap and no new liquidity, and nothing is merged or sent first', async () => {
    const { node, ctx } = scenario([{ ...base, paused: true }], [1_000_000n, 1_000_000n]);
    await expect(swap(ctx, signerFor(alice), [alice.address], { side: 'buy', amountIn: KAS, minOut: 1n, quoted: 1n })).rejects.toBeInstanceOf(PoolPaused);
    // A sell would need a merge (two states of 1 kUSDT for 1.5): refused before it.
    await expect(swap(ctx, signerFor(alice), [alice.address], { side: 'sell', amountIn: 1_500_000n, minOut: 30_000_000n, quoted: 1n })).rejects.toBeInstanceOf(PoolPaused);
    await expect(addLiquidity(ctx, signerFor(alice), [alice.address], { kasIn: KAS, tokensIn: 1_500_000n, minShares: 1n, quoted: 1n })).rejects.toBeInstanceOf(PoolPaused);
    await expect(openPool(ctx, signerFor(alice), [alice.address], { kasIn: KAS, tokensIn: 1_000_000n })).rejects.toThrow(/has liquidity/);
    expect(node.submitted).toHaveLength(0);
  });
});

describe('the circuit breaker on sells (SPEC §15)', () => {
  it('runs on a clock 10 DAA behind the node', () => {
    expect(sellNowDaa(base, 1_000_000n)).toBe(999_990n);
    expect(sellNowDaa(base, 5n)).toBe(0n);
  });

  it("asks the core what sells may still take out: what is left of the cap and when it is full again", () => {
    // The pool UTXO is new: a sell can claim only the 50 DAA it must wait for, so 5 KAS of the cap and that refill
    // are left, and about 27 000 DAA (less those 50) refill the rest.
    const q = quoteSellAt({ core }, windowed, 0n, NOW, NOW);
    expect(q.breaker.maxKasOut).toBe(5n * KAS + REFILL_50); // 10 % of 200 KAS, less the 15 already out, plus 50 DAA's refill
    expect(q.breaker.windowEndsDaa).toBe(NOW + 26_951n);
    expect(windowOver(q.breaker.windowEndsDaa, NOW)).toBe(false);
    // A pool UTXO one window old: the whole cap is back.
    const full = quoteSellAt({ core }, windowed, 0n, NOW, NOW - 36_000n);
    expect(full.breaker.maxKasOut).toBe(20n * KAS);
    expect(full.breaker.windowEndsDaa).toBe(NOW);
    expect(windowOver(full.breaker.windowEndsDaa, NOW)).toBe(true);
  });

  it('finds the largest sell that fits the room, exactly', () => {
    const room = 5n * KAS;
    const m = largestSellWithin({ core }, windowed, room, 10_000_000n);
    expect(quoteSell({ core }, windowed, m)).toBeLessThanOrEqual(room);
    expect(quoteSell({ core }, windowed, m + 1n)).toBeGreaterThan(room);
    expect(largestSellWithin({ core }, windowed, room, m - 7n)).toBe(m - 7n); // the balance is the cap when it is smaller
    expect(largestSellWithin({ core }, windowed, 0n, 10_000_000n)).toBe(0n);
  });

  it('refuses a sell above the room before merging or building anything, naming the largest that fits; one that fits goes through', async () => {
    const { node, ctx } = scenario([windowed], [600_000n, 600_000n, 3_000_000n]);
    const signer = signerFor(alice);
    const tooMuch = 1_000_000n; // ≈ 9.9 KAS out, above the 5 KAS left
    const e = await swap(ctx, signer, [alice.address], { side: 'sell', amountIn: tooMuch, minOut: 30_000_000n, quoted: 1n }).catch(x => x);
    expect(e).toBeInstanceOf(BreakerLimit);
    expect(e.maxKasOut).toBe(5n * KAS + REFILL_50);
    expect(e.maxTokensIn).toBe(largestSellWithin(ctx, windowed, 5n * KAS + REFILL_50, tooMuch));
    expect(e.message).toMatch(/circuit breaker.*5.0277 KAS.*Sell at most/);
    expect(node.submitted).toHaveLength(0);
    // The largest that fits is built and sent once the pool UTXO is 50 DAA old; the pool's window then holds the KAS it
    // took, less what those 50 DAA refilled.
    node.virtualDaa = async () => 1_000_000n + MIN_AGE;
    const fit = e.maxTokensIn as bigint;
    const out = quoteSell(ctx, windowed, fit);
    const r = await swap(ctx, signer, [alice.address], { side: 'sell', amountIn: fit, minOut: minimumFor(out, 50), quoted: out });
    expect(r.amountOut).toBe(out);
    const next = r.built.outputs[0].pool;
    expect(BigInt(next.windowOut)).toBe(windowed.windowOut - REFILL_50 + out);
    expect(lastBuilt.value.transaction.inputs[0].sequence).toBe(50);
  });

  it('swapCheck reports the clock the sell is built on', async () => {
    const { ctx } = scenario([windowed]);
    const vp = await verifyPool(ctx, await ctx.api!.pool());
    const out = quoteSell(ctx, windowed, 100_000n);
    const c = await swapCheck(ctx, vp, { side: 'sell', amountIn: 100_000n, minOut: 1n, quoted: out });
    expect(c.nowDaa).toBe(NOW);
    expect(c.out).toBe(out);
  });
});

describe('the shortest claim while more than half of the cap is in use (SPEC §15)', () => {
  it('is a 720th of the window, as the core says, and none at or below half of the cap', () => {
    expect(leastClaimOf(windowed)).toBe(MIN_AGE);
    expect(leastClaimOf(base)).toBe(0n);
    expect(leastClaimOf({ ...windowed, windowLen: 8n })).toBe(1n);
    expect(BigInt(core.call('quote', { kind: 'sell', pool: windowed, tokensIn: 1n, nowDaa: NOW, poolDaa: NOW - 100n }).value.breaker.minAgeDaa)).toBe(leastClaimOf(windowed));
    expect(BigInt(core.call('quote', { kind: 'sell', pool: base, tokensIn: 1n, nowDaa: NOW, poolDaa: NOW - 100n }).value.breaker.minAgeDaa)).toBe(0n);
  });

  it('a pool UTXO only in the mempool, or younger than the minimum, is not built on; one old enough is', () => {
    const at = (blockDaaScore: bigint, confirmed: boolean) => ({ pool: { utxo: { transactionId: '00'.repeat(32), index: 0, amount: 1n, scriptPublicKey: '', blockDaaScore, isCoinbase: false, covenantId: POOL, confirmed }, state: windowed } });
    expect(poolReady(at(NOW - 50n, true), NOW)).toBe(true);
    expect(poolReady(at(NOW - 49n, true), NOW)).toBe(false);
    expect(poolReady(at(NOW - 5_000n, false), NOW)).toBe(false);
    // With nothing in use, any pool UTXO goes, the mempool's too.
    expect(poolReady({ pool: { ...at(NOW, false).pool, state: base } }, NOW)).toBe(true);
  });

  it('a swap waits for the pool UTXO to be old enough, then claims its age; a pool that never ages gives up, sending nothing', async () => {
    const { node, ctx } = scenario([windowed]);
    let clock = 1_000_000n;
    node.virtualDaa = async () => (clock += 5n);
    const kasIn = KAS;
    const out = quoteBuy(ctx, windowed, kasIn);
    const r = await swap(ctx, signerFor(alice), [alice.address], { side: 'buy', amountIn: kasIn, minOut: out, quoted: out });
    expect(lastBuilt.value.transaction.inputs[0].sequence).toBeGreaterThanOrEqual(50);
    expect(node.submitted).toHaveLength(1);
    // A clock that never reaches the minimum: PoolBusy, nothing sent.
    const stuck = scenario([windowed]);
    const vp = await verifyPool(stuck.ctx, await stuck.ctx.api!.pool());
    await expect(readyPool(stuck.ctx, vp, 0)).rejects.toBeInstanceOf(PoolBusy);
    expect(stuck.node.submitted).toHaveLength(0);
  });
});

describe('a deposit puts in only what its shares need (the round-10 review)', () => {
  it('trims both sides to the shares the smaller one buys, rounded up, and never above what was asked', () => {
    const S = base.totalShares, X = base.kasReserve, Y = base.tokenReserve;
    for (const [kasIn, tokensIn] of [[KAS, 105_000n], [KAS, 95_000n], [10n * KAS + 7n, 1_000_003n], [123_456_789n, 12_345n]] as const) {
      const used = trimToShares(base, kasIn, tokensIn);
      expect(used.kasIn <= kasIn && used.tokensIn <= tokensIn).toBe(true);
      // The least of each side for those shares: one sompi or base unit less would buy fewer.
      expect(used.shares * X <= used.kasIn * S && used.shares * Y <= used.tokensIn * S).toBe(true);
      const target = (kasIn * S) / X < (tokensIn * S) / Y ? (kasIn * S) / X : (tokensIn * S) / Y;
      expect(used.shares >= target).toBe(true);
      expect((used.kasIn - 1n) * S < target * X && (used.tokensIn - 1n) * S < target * Y).toBe(true);
    }
  });

  it('a deposit 5 % off the ratio keeps the extra: the pool gets exactly what the shares need, the change the rest', async () => {
    const { node, ctx } = scenario([base], [3_000_000n]);
    node.submitImpl = async () => { landLast(node); return lastBuilt.txid; };
    // 1 KAS needs 0.1 kUSDT at this pool (200 KAS against 20 kUSDT): 0.105 offered.
    const kasIn = KAS, tokensIn = 105_000n;
    const used = trimToShares(base, kasIn, tokensIn);
    expect(used.tokensIn).toBeLessThan(tokensIn);
    const shares = quoteAdd(ctx, base, kasIn, tokensIn);
    const r = await addLiquidity(ctx, signerFor(alice), [alice.address], { kasIn, tokensIn, minShares: shares, quoted: shares });
    expect([r.kasIn, r.tokensIn]).toEqual([used.kasIn, used.tokensIn]);
    const [pool, , , change] = r.built.outputs;
    expect(BigInt(pool.pool.kasReserve)).toBe(base.kasReserve + used.kasIn);
    expect(BigInt(pool.pool.tokenReserve)).toBe(base.tokenReserve + used.tokensIn);
    expect(BigInt(change.token.amount)).toBe(3_000_000n - used.tokensIn);
    expect(r.shares).toBe(used.shares);
  });
});

describe('empty kUSDT states (a deposit that used a whole state leaves one)', () => {
  it('are listed with the KAS they hold, and freed into another state of the wallet', async () => {
    const { node, ctx } = scenario([base], [0n, 0n, 2_000_000n]);
    const signer = signerFor(alice);
    const { states } = await loadTokens(ctx, signer);
    expect(emptyStatesOf(states)).toHaveLength(2);
    const r = await sweepEmptyStates(ctx, signer, [alice.address]);
    expect(lastBuilt.command).toBe('transfer');
    const tx = JSON.parse(r.built.transaction);
    // The state holding kUSDT and both empty ones in, one state of the same amount out: two states' KAS freed.
    const tokenOutputs = r.built.outputs.filter((o: any) => o.token);
    expect(tokenOutputs).toHaveLength(1);
    expect(BigInt(tokenOutputs[0].token.amount)).toBe(2_000_000n);
    expect(tx.inputs.length).toBeGreaterThanOrEqual(3);
    expect(r.freed).toBeGreaterThan(2n * 150_000_000n - 10_000_000n);
    expect(node.submitted).toHaveLength(1);
  });

  it('with no state that holds kUSDT, empty ones go into one; a single empty one waits for another state', async () => {
    const two = scenario([base], [0n, 0n]);
    const r = await sweepEmptyStates(two.ctx, signerFor(alice), [alice.address]);
    expect(BigInt(r.built.outputs.filter((o: any) => o.token)[0].token.amount)).toBe(0n);
    const one = scenario([base], [0n]);
    await expect(sweepEmptyStates(one.ctx, signerFor(alice), [alice.address])).rejects.toThrow(/another kUSDT state/);
    const none = scenario([base], [1_000_000n]);
    await expect(sweepEmptyStates(none.ctx, signerFor(alice), [alice.address])).rejects.toThrow(/no empty/);
  });
});

describe('a pool with no liquidity yet', () => {
  it('is verified on the node without a reserve, and only while it was never opened', async () => {
    const { ctx, node } = scenario([unopened]);
    const answer = await ctx.api!.pool();
    const vp = await verifyPool(ctx, answer);
    expect(vp.reserve).toBeNull();
    expect(vp.pool.state.totalShares).toBe(0n);
    // A pool with liquidity always has its reserve: an answer without one is refused.
    const opened = placePool(node, ctx, uniq('f'), base) as any;
    await expect(verifyPool(ctx, { pool: opened.pool, reserve: null } as any)).rejects.toThrow(/reserve/);
    // And an unopened state the node doesn't hold is refused like any other.
    await expect(verifyPool(ctx, { pool: { utxo: { transactionId: uniq('f'), index: 0 }, state: unopened }, reserve: null } as any)).rejects.toThrow(/could not be found/);
  });

  it("swaps and deposits are refused: there's nothing to trade with", async () => {
    const { node, ctx } = scenario([unopened]);
    await expect(swap(ctx, signerFor(alice), [alice.address], { side: 'buy', amountIn: KAS, minOut: 1n, quoted: 1n })).rejects.toThrow(/no liquidity/);
    await expect(addLiquidity(ctx, signerFor(alice), [alice.address], { kasIn: KAS, tokensIn: 1n, minShares: 1n, quoted: 1n })).rejects.toThrow(/no liquidity/);
    expect(node.submitted).toHaveLength(0);
  });

  it("only the pool's admin opens it: another wallet is refused before anything is merged or sent", async () => {
    const { node, ctx } = scenario([unopened], [3_000_000n, 3_000_000n]);
    await expect(openPool(ctx, signerFor(alice), [alice.address], { kasIn: 50n * KAS, tokensIn: 5_000_000n })).rejects.toThrow(/Only the pool's admin/);
    expect(node.submitted).toHaveLength(0);
  });

  it('opens with the wallet (the admin) as the position owner, merging its kUSDT into one state first; 1000 shares stay locked', async () => {
    // 3 + 3 kUSDT in two states, 5 to put in: merged into one 6 kUSDT state first, as a sell would be.
    const { node, ctx } = scenario([unopenedByAlice], [3_000_000n, 3_000_000n]);
    const signer = signerFor(alice);
    node.submitImpl = async () => { landLast(node); return lastBuilt.txid; };
    const kasIn = 50n * KAS, tokensIn = 5_000_000n;
    const merges: string[] = [];
    const r = await openPool(ctx, signer, [alice.address], { kasIn, tokensIn }, (t) => merges.push(t));
    expect(merges).toHaveLength(1);
    expect(node.submitted).toHaveLength(2);
    expect(lastBuilt.command).toBe('pool-init');
    expect(r.shares).toBe(kasIn - LOCKED_SHARES);
    const [pool, position, reserve, change] = r.built.outputs;
    expect([pool.kind, position.kind, reserve.kind]).toEqual(['pool', 'position', 'reserve']);
    expect(BigInt(pool.pool.kasReserve)).toBe(kasIn);
    expect(BigInt(pool.pool.tokenReserve)).toBe(tokensIn);
    expect(BigInt(pool.pool.totalShares)).toBe(kasIn); // the position's shares + the 1000 nobody owns
    expect(position.position.owner).toBe(alice.xonly);
    expect(BigInt(position.position.shares)).toBe(kasIn - LOCKED_SHARES);
    expect(position.value).toBe(BigInt(ctx.config.positionValue));
    expect(BigInt(reserve.token.amount)).toBe(tokensIn);
    expect(reserve.token.owner).toBe(POOL);
    expect(BigInt(change.token.amount)).toBe(1_000_000n);
    expect(change.token.owner).toBe(alice.xonly);
    // The opened pool is what the wallet sees next (its own hint, checked on the node).
    const after = await verifyPool(ctx, { pool: { utxo: { transactionId: r.txid, index: 0 }, state: pool.pool }, reserve: { utxo: { transactionId: r.txid, index: 2 }, state: reserve.token } });
    expect(after.pool.state.totalShares).toBe(kasIn);
  });

  it("an emptied pool takes a first deposit again only from its admin, whose deposit starts the sell cap again", async () => {
    // Every provider left: only the 1000 locked shares and the dust they hold.
    const emptied: PoolState = { ...base, totalShares: LOCKED_SHARES, kasReserve: 1_000n, tokenReserve: 100n, windowRef: 1_000n, windowOut: 0n };
    const kasIn = 50_000_000n, tokensIn = (kasIn * 100n + 999n) / 1_000n + 1n;
    const other = scenario([emptied], [10_000_000n]);
    await expect(addLiquidity(other.ctx, signerFor(alice), [alice.address], { kasIn, tokensIn, minShares: 1n, quoted: 1n })).rejects.toThrow(/only its admin/);
    expect(other.node.submitted).toHaveLength(0);
    const mine = scenario([{ ...emptied, admin: alice.xonly }], [10_000_000n]);
    const shares = quoteAdd(mine.ctx, emptied, kasIn, tokensIn);
    mine.node.submitImpl = async () => { landLast(mine.node); return lastBuilt.txid; };
    const r = await addLiquidity(mine.ctx, signerFor(alice), [alice.address], { kasIn, tokensIn, minShares: shares, quoted: shares });
    expect(lastBuilt.command).toBe('pool-add');
    expect(BigInt(r.built.outputs[0].pool.windowRef)).toBe(1_000n + kasIn);
  });

  it('refuses amounts the covenant refuses, and stops when someone opened the pool first', async () => {
    const { node, ctx, show } = scenario([unopenedByAlice, { ...base, admin: alice.xonly }], [10_000_000n]);
    await expect(openPool(ctx, signerFor(alice), [alice.address], { kasIn: LOCKED_SHARES, tokensIn: 1_000_000n })).rejects.toThrow(/more than 1000 sompi/);
    await expect(openPool(ctx, signerFor(alice), [alice.address], { kasIn: KAS, tokensIn: 0n })).rejects.toThrow(/some kUSDT/);
    expect(node.submitted).toHaveLength(0);
    // Someone else's opening lands first: the wallet's is refused, and it does not try on the opened pool.
    node.submitImpl = async () => { show(1); throw new NodeRejected('double spend'); };
    await expect(openPool(ctx, signerFor(alice), [alice.address], { kasIn: 50n * KAS, tokensIn: 5_000_000n })).rejects.toThrow(/someone opened it first/);
    expect(node.submitted).toHaveLength(1);
  });
});

describe('what Max leaves', () => {
  const ctx = { config: { tokenValue: '150000000', positionValue: '200000000' } } as any;
  it('keeps the KAS each transaction locks in new states, and 0.3 KAS for the fee', () => {
    expect(lockedKasFor(ctx, 'buy')).toBe(150_000_000n);
    expect(lockedKasFor(ctx, 'add')).toBe(200_000_000n);
    expect(lockedKasFor(ctx, 'open')).toBe(350_000_000n);
    expect(maxKasIn(ctx, 'buy', 10n * KAS)).toBe(10n * KAS - 150_000_000n - FEE_KEEP);
    expect(maxKasIn(ctx, 'open', 10n * KAS)).toBe(10n * KAS - 350_000_000n - FEE_KEEP);
    expect(maxKasIn(ctx, 'add', KAS)).toBe(0n);
  });
});

