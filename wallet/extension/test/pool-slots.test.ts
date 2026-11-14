// The pool's slots, the wallet's side (from the 2026-11-10 review of the pool clock, finding H1).
//
// While more than half of the cap is in use every pool transaction claims at least 50 DAA, so each pool UTXO can be spent
// once it is 50 DAA old: consensus (and so a bot) can spend it at virtual DAA d + 50. The wallet (and the web app, which
// runs this engine) is ready at that same DAA and claims exactly 50 there, so a bot has no head start: which spend gets
// the slot is the network's call. A node a moment behind that refuses the lock is asked again. At or below half of the
// cap, and for a withdrawal while the pool is paused, there is no minimum: the wallet builds at once.
import { describe, expect, it } from 'vitest';
import { FakeNode, COVENANT, POOL, fakeApi, testCtx } from './helpers';
import { p2shAddressOf, scriptOf, reserveStateOf, poolValue, verifyPool } from '@/kusdt/verify';
import { LOCK_RETRY, POOL_WAIT, PoolBusy, SELL_DAA_MARGIN, leastClaimOf, leastRemoveClaimOf, poolNowDaa, poolReady, readyPool, withFreshPool } from '@/kusdt/pool';
import { NodeRejected } from '@/kaspa/node';
import type { PoolState } from '@/kusdt/types';

POOL_WAIT.ms = 0;
POOL_WAIT.perDaaMs = 0;
LOCK_RETRY.ms = 0;

const KAS = 100_000_000n;
/** 15 KAS of a 20 KAS cap in use: above half. */
const inUse: PoolState = {
  tokenCovid: COVENANT, kasReserve: 200n * KAS, tokenReserve: 20_000_000n, totalShares: 200n * KAS, protocolKas: 0n, protocolTokens: 0n, baseValue: KAS,
  admin: '11'.repeat(32), maxOutBps: 1_000n, windowLen: 36_000n, windowCredit: 0n, windowRef: 200n * KAS, windowOut: 15n * KAS, paused: false, guardian: '22'.repeat(32),
};
const MIN_AGE = 50n;
const at = (blockDaaScore: bigint, state = inUse, confirmed = true) => ({ pool: { utxo: { transactionId: '00'.repeat(32), index: 0, amount: 1n, scriptPublicKey: '', blockDaaScore, isCoinbase: false, covenantId: POOL, confirmed }, state } });

/** A chain with one pool UTXO at a time, accepted at `poolDaa`; the coordinator reports the newest one. */
function chain(start: bigint, state = inUse) {
  const node = new FakeNode();
  let n = 0;
  let current: any = null;
  const ctx = testCtx(node, fakeApi({ pool: async () => current }));
  const s = { clock: start, poolDaa: start, spends: 0 };
  /** A new pool UTXO (a new txid), accepted at `daa`; the one before it is spent. */
  const accept = (daa: bigint) => {
    const txid = (++n).toString(16).padStart(64, '7');
    node.utxoSet = node.utxoSet.filter((u) => u.covenantId !== POOL && u.covenantId !== COVENANT);
    const pspk = scriptOf(ctx, 'Pool', state);
    node.utxoSet.push({ address: p2shAddressOf(pspk, 'kaspasim'), transactionId: txid, index: 0, amount: poolValue(state), scriptPublicKey: pspk, blockDaaScore: daa, isCoinbase: false, covenantId: POOL });
    const reserve = reserveStateOf(POOL, state);
    const rspk = scriptOf(ctx, 'KCC20', reserve);
    node.utxoSet.push({ address: p2shAddressOf(rspk, 'kaspasim'), transactionId: txid, index: 1, amount: 150_000_000n, scriptPublicKey: rspk, blockDaaScore: daa, isCoinbase: false, covenantId: COVENANT });
    current = { pool: { utxo: { transactionId: txid, index: 0 }, state }, reserve: { utxo: { transactionId: txid, index: 1 }, state: reserve } };
    s.poolDaa = daa;
  };
  accept(start);
  return { node, ctx, s, accept };
}

describe('the pool slots: the wallet meets a bot at the first DAA consensus allows', () => {
  it('is ready at d + 50 and claims exactly 50 there; further on, its clock is the margin behind', () => {
    const d = 5_000_000n;
    expect(leastClaimOf(inUse)).toBe(MIN_AGE);
    // Consensus (rusty-kaspa check_sequence_lock): a sequence of 50 on a UTXO accepted at d is met once the merging block's DAA is d + 50.
    const consensusAllows = (virtualDaa: bigint) => d + MIN_AGE - 1n < virtualDaa;
    let firstConsensus = -1n, firstWallet = -1n;
    for (let v = d; v < d + 100n; v++) {
      if (firstConsensus < 0n && consensusAllows(v)) firstConsensus = v;
      if (firstWallet < 0n && poolReady(at(d), v)) firstWallet = v;
    }
    expect(firstConsensus).toBe(d + 50n);
    expect(firstWallet).toBe(d + 50n);
    expect(poolNowDaa(at(d), d + 50n) - d).toBe(MIN_AGE);
    expect(poolNowDaa(at(d), d + 55n) - d).toBe(MIN_AGE);
    expect(poolNowDaa(at(d), d + 200n)).toBe(d + 200n - SELL_DAA_MARGIN);
    // Unaccepted (only in the mempool): no age to claim, not ready.
    expect(poolReady(at(d, inUse, false), d + 1_000n)).toBe(false);
  });

  it('at or below half of the cap, and for a withdrawal while paused, it builds at once, the mempool\'s pool UTXO too', () => {
    const d = 5_000_000n;
    const half = { ...inUse, windowOut: 10n * KAS };
    expect(leastClaimOf(half)).toBe(0n);
    expect(leastClaimOf({ ...half, windowOut: 10n * KAS + 1n })).toBe(MIN_AGE);
    expect(poolReady(at(d, half, false), d)).toBe(true);
    expect(poolNowDaa(at(d, half), d + 3n)).toBe(d + 3n - SELL_DAA_MARGIN);
    const paused = { ...inUse, paused: true };
    expect(leastClaimOf(paused)).toBe(MIN_AGE);
    expect(leastRemoveClaimOf(paused)).toBe(0n);
    expect(leastRemoveClaimOf(inUse)).toBe(MIN_AGE);
    expect(poolReady(at(d, paused, false), d, leastRemoveClaimOf(paused))).toBe(true);
  });

  it('hands the pool over at d + 50 with or without a bot; the race for the slot is then the network\'s', async () => {
    // No bot: the clock moves a DAA per read; readyPool hands the pool over at d + 50.
    const quiet = chain(5_000_000n);
    quiet.node.virtualDaa = async () => (quiet.s.clock += 1n);
    const vp0 = await verifyPool(quiet.ctx, await quiet.ctx.api!.pool());
    const got = await readyPool(quiet.ctx, vp0, 5_000);
    expect(got.pool.utxo.blockDaaScore).toBe(5_000_000n);
    expect(quiet.s.clock).toBe(5_000_000n + 50n);

    // A bot that spends every pool UTXO the moment it is 50 DAA old: the wallet is ready at that same DAA, every slot
    // (the review's version of this test ended in PoolBusy: the wallet was ready only at d + 60).
    const c = chain(5_000_000n);
    c.node.virtualDaa = async () => (c.s.clock += 1n);
    for (let slot = 0; slot < 10; slot++) {
      const vp = await verifyPool(c.ctx, await c.ctx.api!.pool());
      const ready = await readyPool(c.ctx, vp, 4_000);
      expect(ready.pool.utxo.blockDaaScore).toBe(c.s.poolDaa);
      expect(c.s.clock - c.s.poolDaa).toBe(MIN_AGE);
      // The bot's spend of that slot lands (it reached the miners first): the next slot.
      c.s.spends++;
      c.accept(c.s.clock + 1n);
    }
    expect(c.node.submitted).toHaveLength(0);
  });

  it('a pool that never ages gives up, sending nothing', async () => {
    const stuck = chain(5_000_000n);
    stuck.node.virtualDaa = async () => stuck.s.clock;
    const vp = await verifyPool(stuck.ctx, await stuck.ctx.api!.pool());
    await expect(readyPool(stuck.ctx, vp, 0)).rejects.toBeInstanceOf(PoolBusy);
  });

  it('a node a moment behind the lock is asked again on the same pool state; any other refusal is not', async () => {
    const c = chain(5_000_000n);
    let tries = 0;
    const r = await withFreshPool(c.ctx, async (vp, n) => {
      tries++;
      if (tries <= 3) throw new NodeRejected('transaction rejected: one of the transaction sequence locks conditions was not met');
      return { n, txid: vp.pool.utxo.transactionId };
    });
    expect(tries).toBe(4);
    expect(r.n).toBe(1);
    // A node that keeps refusing the lock: LOCK_RETRY.tries more, then the refusal stands.
    let always = 0;
    await expect(withFreshPool(c.ctx, async () => { always++; throw new NodeRejected('one of the transaction sequence locks conditions was not met'); })).rejects.toThrow();
    expect(always).toBeGreaterThan(LOCK_RETRY.tries);
    // A double spend on an unchanged pool is final at once.
    let spent = 0;
    await expect(withFreshPool(c.ctx, async () => { spent++; throw new NodeRejected('double spend'); })).rejects.toThrow(/double spend/);
    expect(spent).toBe(1);
  });
});
