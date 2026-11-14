// Round 11, R11-WW-2: a pool transaction was reported done as soon as the
// wallet's node took it. Two transactions spending the same pool UTXO can each
// be taken by a node, and only one is ever accepted: the loser was shown as
// "Swapped", and the kUSDT and coins it named stayed hidden for 10 minutes.
// Now the wallet waits to see which it was: confirmed, lost (what it held is
// free again at once, and it goes again on the new pool under the usual rule),
// or not known yet (reported as sent, and looked at again at every refresh).

import { beforeEach, describe, expect, it } from 'vitest';
import { FakeNode, COVENANT, POOL, devKey, fakeApi, testCtx, signerFor, kasCoin, lastBuilt } from './helpers';
import { p2shAddressOf, scriptOf, reserveStateOf, poolValue } from '@/kusdt/verify';
import { LostRace, POOL_WAIT, QuoteChanged, minimumFor, quoteBuy, quoteRemove, quoteSell, removeLiquidity, swap } from '@/kusdt/pool';
import { kasCoins } from '@/kusdt/build';
import { inputsOf, markSpent, pendingSet } from '@/kusdt/pending';
import { CONFIRM_WAIT, awaitOutcome, lookAt, type Raced } from '@/kusdt/submit';
import { loadTokens } from '@/kusdt/tokens';
import { settleUnconfirmed, unconfirmedTxids } from '@/kusdt/unconfirmed';
import { plainState } from '@/kusdt/owner';
import { local, session } from '@/lib/storage';
import type { Built, PoolState } from '@/kusdt/types';

const alice = devKey('r11-alice');
const KAS = 100_000_000n;
const base: PoolState = { tokenCovid: COVENANT, kasReserve: 200n * KAS, tokenReserve: 20_000_000n, totalShares: 200n * KAS, protocolKas: 0n, protocolTokens: 0n, baseValue: KAS, admin: '11'.repeat(32), maxOutBps: 1_000n, windowLen: 36_000n, windowCredit: 0n, windowRef: 200n * KAS, windowOut: 0n, paused: false, guardian: '22'.repeat(32) };
/** The pool after someone else bought: a sale now gets more KAS, a purchase less kUSDT. */
const afterBuy: PoolState = { ...base, kasReserve: base.kasReserve + 5n * KAS, tokenReserve: base.tokenReserve - 480_000n };
/** The pool after someone else sold: a sale now gets less KAS, a purchase more kUSDT. */
const afterSell: PoolState = { ...base, kasReserve: base.kasReserve - 5n * KAS, tokenReserve: base.tokenReserve + 520_000n };

let n = 0;
const uniq = (c: string) => (++n).toString(16).padStart(64, c);

/** A node with a clock that moves, a pool the test can move, and transactions the test lets land or lose. */
function scene(tokens: bigint[] = []) {
  const node = new FakeNode();
  let daa = 1_000_000n;
  node.virtualDaa = async () => (daa += 10n);
  let answer: any = null;
  const listed: any[] = [];
  const ctx = testCtx(node, fakeApi({ pool: async () => answer, tokens: async () => ({ states: listed }) }));
  const poolTxids = new Set<string>();
  /** The pool at a new outpoint: the one before it is spent (by a transaction that was accepted). */
  const showPool = (pool: PoolState) => {
    node.utxoSet = node.utxoSet.filter(u => !poolTxids.has(u.transactionId));
    const txid = uniq('7');
    poolTxids.add(txid);
    const pspk = scriptOf(ctx, 'Pool', pool), reserve = reserveStateOf(POOL, pool), rspk = scriptOf(ctx, 'KCC20', reserve);
    node.utxoSet.push(
      { address: p2shAddressOf(pspk, 'kaspasim'), transactionId: txid, index: 0, amount: poolValue(pool), scriptPublicKey: pspk, blockDaaScore: 999_990n, isCoinbase: false, covenantId: POOL },
      { address: p2shAddressOf(rspk, 'kaspasim'), transactionId: txid, index: 1, amount: 150_000_000n, scriptPublicKey: rspk, blockDaaScore: 1n, isCoinbase: false, covenantId: COVENANT },
    );
    answer = { pool: { utxo: { transactionId: txid, index: 0 }, state: pool }, reserve: { utxo: { transactionId: txid, index: 1 }, state: reserve } };
    return txid;
  };
  for (const amount of tokens) {
    const state = plainState({ ownerScheme: 0, owner: alice.xonly }, amount), spk = scriptOf(ctx, 'KCC20', state), txid = uniq('e');
    node.utxoSet.push({ address: p2shAddressOf(spk, 'kaspasim'), transactionId: txid, index: 0, amount: 150_000_000n, scriptPublicKey: spk, blockDaaScore: 5n, isCoinbase: false, covenantId: COVENANT });
    listed.push({ utxo: { transactionId: txid, index: 0 }, state: { ...state, amount: amount.toString() } });
  }
  /** What accepting the transaction just built does on the node: its inputs go, its outputs are there. */
  const land = () => {
    const v = lastBuilt.value;
    const spent = new Set(inputsOf(node.submitted[node.submitted.length - 1]));
    node.utxoSet = node.utxoSet.filter(u => !spent.has(`${u.transactionId}:${u.index}`));
    for (const o of v.outputs) {
      const covenant = /^0000aa20[0-9a-f]{64}87$/.test(o.scriptPublicKey);
      node.utxoSet.push({
        address: covenant ? p2shAddressOf(o.scriptPublicKey, 'kaspasim') : alice.address, transactionId: v.txid, index: o.index, amount: BigInt(o.value), scriptPublicKey: o.scriptPublicKey,
        blockDaaScore: daa, isCoinbase: false, covenantId: covenant ? (o.kind === 'pool' || o.kind === 'position' ? POOL : COVENANT) : null,
      });
    }
    return v.txid as string;
  };
  return { node, ctx, showPool, land, listed, tick: (by: bigint) => { daa += by; } };
}

beforeEach(async () => {
  POOL_WAIT.ms = 0; POOL_WAIT.perDaaMs = 0;
  CONFIRM_WAIT.ms = 2_000; CONFIRM_WAIT.everyMs = 1;
  await session.remove('kusdt.pending.simnet', `kusdt.poolHint.simnet.${POOL}`);
  await local.remove('kusdt.unconfirmed.simnet');
});

describe('a sale the node took and another transaction beat to the pool', () => {
  it('is not reported: the wallet sees it lost, frees what it held, and sells again on the new pool when that pays no less', async () => {
    const s = scene([5_000_000n]);
    s.showPool(base);
    s.node.utxoSet.push(kasCoin(alice, uniq('c'), 10n * KAS));
    const payer = `${s.listed[0].utxo.transactionId}:0`;
    const seen = quoteSell(s.ctx, base, 2_000_000n);
    const sent: string[] = [];
    s.node.submitImpl = async () => {
      sent.push(lastBuilt.txid);
      // The first: the node takes it, and another transaction (a purchase) is accepted on the same pool UTXO.
      if (sent.length === 1) s.showPool(afterBuy);
      // The second: it is accepted.
      else s.land();
      return lastBuilt.txid;
    };
    const r = await swap(s.ctx, signerFor(alice), [alice.address], { side: 'sell', amountIn: 2_000_000n, minOut: minimumFor(seen, 100), quoted: seen });
    expect(sent).toHaveLength(2);
    expect(r.txid).toBe(sent[1]);
    expect(r.txid).not.toBe(sent[0]);
    expect(r.tries).toBe(2);
    expect(r.confirmed).toBe(true);
    expect(r.amountOut).toBe(quoteSell(s.ctx, afterBuy, 2_000_000n));
    expect(r.amountOut).toBeGreaterThanOrEqual(seen);
    // The second transaction spends the same kUSDT state as the first: the two can never both be accepted.
    expect(inputsOf(s.node.submitted[0])).toContain(payer);
    expect(inputsOf(s.node.submitted[1])).toContain(payer);
  });

  it('stops for the user when the new pool pays less than they approved, with their kUSDT and coins back at once', async () => {
    const s = scene([2_000_000n]);
    s.showPool(base);
    s.node.utxoSet.push(kasCoin(alice, uniq('c'), 10n * KAS));
    const seen = quoteSell(s.ctx, base, 2_000_000n);
    s.node.submitImpl = async () => { s.showPool(afterSell); return lastBuilt.txid; };
    // All of the one state is sold, and the node took the transaction: both it and the coin are marked as spent.
    const failed = await swap(s.ctx, signerFor(alice), [alice.address], { side: 'sell', amountIn: 2_000_000n, minOut: minimumFor(seen, 1_000), quoted: seen }).catch(e => e);
    expect(failed).toBeInstanceOf(QuoteChanged);
    expect(s.node.submitted).toHaveLength(1);
    // Before the fix the sale was reported as done here, and these read 0 kUSDT and no coin for 10 minutes.
    expect((await loadTokens(s.ctx, signerFor(alice))).total).toBe(2_000_000n);
    expect(await kasCoins(s.ctx, [alice.address])).toHaveLength(1);
    expect([...(await pendingSet('simnet'))]).toEqual([]);
    expect(await unconfirmedTxids('simnet')).toEqual([]);
  });

  it('gives up with plain words after three lost races, with nothing held', async () => {
    const s = scene([5_000_000n]);
    s.showPool(base);
    s.node.utxoSet.push(kasCoin(alice, uniq('c'), 10n * KAS));
    const seen = quoteSell(s.ctx, base, 2_000_000n);
    s.node.submitImpl = async () => { s.showPool(afterBuy); return lastBuilt.txid; };
    const failed = await swap(s.ctx, signerFor(alice), [alice.address], { side: 'sell', amountIn: 2_000_000n, minOut: minimumFor(seen, 100), quoted: seen }).catch(e => e);
    expect(failed).toBeInstanceOf(LostRace);
    expect(failed.message).toMatch(/Another transaction reached the pool first/);
    expect(s.node.submitted).toHaveLength(3);
    expect((await loadTokens(s.ctx, signerFor(alice))).total).toBe(5_000_000n);
    expect([...(await pendingSet('simnet'))]).toEqual([]);
  });
});

describe('a purchase that lost the race', () => {
  it('is built again on one of the same coins, even when a larger coin has arrived meanwhile', async () => {
    const s = scene();
    s.showPool(base);
    const first = kasCoin(alice, uniq('c'), 30n * KAS);
    s.node.utxoSet.push(first);
    const kasIn = 10n * KAS, seen = quoteBuy(s.ctx, base, kasIn);
    const sent: string[] = [];
    s.node.submitImpl = async () => {
      sent.push(lastBuilt.txid);
      if (sent.length === 1) { s.showPool(afterSell); s.node.utxoSet.push(kasCoin(alice, uniq('d'), 500n * KAS)); }
      else s.land();
      return lastBuilt.txid;
    };
    const r = await swap(s.ctx, signerFor(alice), [alice.address], { side: 'buy', amountIn: kasIn, minOut: minimumFor(seen, 100), quoted: seen });
    expect(r.confirmed).toBe(true);
    expect(r.tries).toBe(2);
    const coin = `${first.transactionId}:0`;
    expect(inputsOf(s.node.submitted[0])).toContain(coin);
    // Largest first, the wallet would have picked the new 500 KAS coin alone: the first try could then be accepted beside it.
    expect(inputsOf(s.node.submitted[1])).toContain(coin);
  });
});

describe('a pool transaction whose outcome the node does not show in time', () => {
  it('is reported as sent, not confirmed; what it holds stays held; a later look confirms it', async () => {
    const s = scene([2_000_000n]);
    s.showPool(base);
    s.node.utxoSet.push(kasCoin(alice, uniq('c'), 10n * KAS));
    CONFIRM_WAIT.ms = 20;
    const seen = quoteSell(s.ctx, base, 2_000_000n);
    // The node took it; neither it nor a rival is accepted while the wallet waits.
    const r = await swap(s.ctx, signerFor(alice), [alice.address], { side: 'sell', amountIn: 2_000_000n, minOut: minimumFor(seen, 100), quoted: seen });
    expect(r.confirmed).toBe(false);
    expect(await unconfirmedTxids('simnet')).toEqual([r.txid]);
    expect((await loadTokens(s.ctx, signerFor(alice))).total).toBe(0n);
    expect(await settleUnconfirmed(s.ctx)).toEqual({ confirmed: [], lost: [] });
    // It is accepted later.
    s.land();
    expect(await settleUnconfirmed(s.ctx)).toEqual({ confirmed: [r.txid], lost: [] });
    expect(await unconfirmedTxids('simnet')).toEqual([]);
  });

  it('a later look that shows it lost gives back what it held, after two looks in a row', async () => {
    const s = scene([2_000_000n]);
    s.showPool(base);
    s.node.utxoSet.push(kasCoin(alice, uniq('c'), 10n * KAS));
    CONFIRM_WAIT.ms = 20;
    const seen = quoteSell(s.ctx, base, 2_000_000n);
    const r = await swap(s.ctx, signerFor(alice), [alice.address], { side: 'sell', amountIn: 2_000_000n, minOut: minimumFor(seen, 100), quoted: seen });
    expect(r.confirmed).toBe(false);
    s.showPool(afterBuy); // another transaction is accepted on the pool UTXO it spent
    expect(await settleUnconfirmed(s.ctx)).toEqual({ confirmed: [], lost: [] });
    expect((await loadTokens(s.ctx, signerFor(alice))).total).toBe(0n);
    expect(await settleUnconfirmed(s.ctx)).toEqual({ confirmed: [], lost: [r.txid] });
    expect((await loadTokens(s.ctx, signerFor(alice))).total).toBe(2_000_000n);
    expect(await kasCoins(s.ctx, [alice.address])).toHaveLength(1);
    expect(await unconfirmedTxids('simnet')).toEqual([]);
  });
});

describe('what counts as lost', () => {
  const built = (txid: string, spk: string) => ({ txid, outputs: [{ index: 0, kind: 'change', value: 1n, scriptPublicKey: spk }] }) as unknown as Built;
  const spk = `000020${alice.xonly}ac`;
  const pool = (node: FakeNode) => {
    const u = { address: 'kaspasim:pool', transactionId: uniq('9'), index: 0, amount: 1n, scriptPublicKey: '00', blockDaaScore: 5n, isCoinbase: false, covenantId: POOL };
    node.utxoSet.push(u);
    return { u, raced: { outpoint: `${u.transactionId}:0`, address: u.address, seen: true, daa: '5' } as Raced };
  };

  it('a node that is behind the one that showed the pool coin proves nothing by not having it', async () => {
    const node = new FakeNode();
    let daa = 1_000n;
    node.virtualDaa = async () => daa;
    const { u, raced } = pool(node);
    const ctx = { node, net: { prefix: 'kaspasim' } } as any;
    expect(await lookAt(ctx, 'ab'.repeat(32), [alice.address], raced)).toBe('unknown');
    expect(raced.daa).toBe('1000');
    // A new connection, to a node that has not caught up to that score: no pool coin, no transaction.
    node.utxoSet = node.utxoSet.filter(x => x !== u);
    daa = 900n;
    expect(await lookAt(ctx, 'ab'.repeat(32), [alice.address], raced)).toBe('unknown');
    daa = 1_000n;
    expect(await lookAt(ctx, 'ab'.repeat(32), [alice.address], raced)).toBe('unknown');
    // A node past it: the coin is spent, and the transaction is nowhere.
    daa = 1_010n;
    expect(await lookAt(ctx, 'ab'.repeat(32), [alice.address], raced)).toBe('gone');
  });

  it('a pool coin that was only in the mempool when it was built on proves nothing by being absent', async () => {
    const node = new FakeNode();
    let daa = 1_000n;
    node.virtualDaa = async () => (daa += 10n);
    const raced: Raced = { outpoint: `${'9a'.repeat(32)}:0`, address: 'kaspasim:pool', seen: false, daa: '0' };
    const ctx = { node, net: { prefix: 'kaspasim' } } as any;
    expect(await awaitOutcome(ctx, built('ab'.repeat(32), spk), raced, { ms: 30, everyMs: 1 })).toBe('unknown');
  });

  it('a transaction still in the mempool, or already in the UTXO set, is never lost; one look alone is not enough; a failed read says nothing', async () => {
    const node = new FakeNode();
    let daa = 1_000n;
    node.virtualDaa = async () => (daa += 10n);
    const { u, raced } = pool(node);
    const ctx = { node, net: { prefix: 'kaspasim' } } as any;
    const txid = 'cd'.repeat(32);
    node.utxoSet = node.utxoSet.filter(x => x !== u);
    node.mempool.push({ address: alice.address, transactionId: txid, index: 0, amount: 1n, scriptPublicKey: spk, covenantId: null });
    expect(await lookAt(ctx, txid, [alice.address], raced)).toBe('unknown');
    node.mempool = [];
    expect(await lookAt(ctx, txid, [alice.address], raced)).toBe('gone');
    // Gone once, then seen in the mempool again, then gone once: still not two looks in a row.
    let looks = 0;
    // Since round 15 (R15-CL-4) the look asks the mempool for the transaction by id: that read is the one stood in for.
    const real = node.inMempool.bind(node);
    node.inMempool = async (t) => (++looks === 2 ? t === txid : real(t));
    expect(await awaitOutcome(ctx, built(txid, spk), { ...raced }, { ms: 0, everyMs: 0 })).toBe('unknown');
    node.inMempool = real;
    expect(await awaitOutcome(ctx, built(txid, spk), { ...raced }, { ms: 50, everyMs: 1 })).toBe('lost');
    node.utxos = async () => { throw new Error('connection lost'); };
    expect(await awaitOutcome(ctx, built(txid, spk), { ...raced }, { ms: 20, everyMs: 1 })).toBe('unknown');
    const ok = new FakeNode();
    ok.utxoSet.push({ address: alice.address, transactionId: txid, index: 0, amount: 1n, scriptPublicKey: spk, blockDaaScore: 1n, isCoinbase: false, covenantId: null });
    expect(await awaitOutcome({ node: ok, net: { prefix: 'kaspasim' } } as any, built(txid, spk), { ...raced }, { ms: 0, everyMs: 0 })).toBe('confirmed');
  });

  it('marks of other transactions are left alone when a lost one is released', async () => {
    const s = scene([2_000_000n]);
    s.showPool(base);
    s.node.utxoSet.push(kasCoin(alice, uniq('c'), 10n * KAS));
    await markSpent('simnet', ['ff'.repeat(32) + ':3']);
    const seen = quoteSell(s.ctx, base, 2_000_000n);
    s.node.submitImpl = async () => { s.showPool(afterSell); return lastBuilt.txid; };
    await swap(s.ctx, signerFor(alice), [alice.address], { side: 'sell', amountIn: 2_000_000n, minOut: minimumFor(seen, 100), quoted: seen }).catch(() => {});
    expect([...(await pendingSet('simnet'))]).toEqual(['ff'.repeat(32) + ':3']);
  });
});

describe('a withdrawal', () => {
  it('says confirmed only once the node shows it accepted', async () => {
    const s = scene();
    s.showPool(base);
    s.node.utxoSet.push(kasCoin(alice, uniq('c'), 10n * KAS));
    const state = { tokenCovid: COVENANT, shares: 20n * KAS, owner: alice.xonly };
    const pspk = scriptOf(s.ctx, 'Position', state), ptx = uniq('a');
    s.node.utxoSet.push({ address: p2shAddressOf(pspk, 'kaspasim'), transactionId: ptx, index: 1, amount: 150_000_000n, scriptPublicKey: pspk, blockDaaScore: 5n, isCoinbase: false, covenantId: POOL });
    s.ctx.api!.positions = async () => ({ positions: [{ utxo: { transactionId: ptx, index: 1 }, state: { ...state, shares: state.shares.toString() } }] });
    const q = quoteRemove(s.ctx, base, state.shares);
    s.node.submitImpl = async () => { s.land(); return lastBuilt.txid; };
    const r = await removeLiquidity(s.ctx, signerFor(alice), [alice.address], { position: `${ptx}:1`, minKas: minimumFor(q.kasOut, 100), minTokens: minimumFor(q.tokensOut, 100), quoted: q });
    expect(r.confirmed).toBe(true);
    expect(await unconfirmedTxids('simnet')).toEqual([]);
  });
});

describe('what the wallet says about it afterwards', () => {
  it('a refresh settles a transaction that was only sent: Activity says it did not go through, and the balance has its kUSDT again', async () => {
    const { balancesOf } = await import('@/wallet/context');
    const { LOST, UNCONFIRMED, addActivity, listActivity, markOutcomes, outcomeStatus } = await import('@/activity/history');
    const s = scene([2_000_000n]);
    s.showPool(base);
    s.node.utxoSet.push(kasCoin(alice, uniq('c'), 10n * KAS));
    CONFIRM_WAIT.ms = 20;
    const seen = quoteSell(s.ctx, base, 2_000_000n);
    const r = await swap(s.ctx, signerFor(alice), [alice.address], { side: 'sell', amountIn: 2_000_000n, minOut: minimumFor(seen, 100), quoted: seen });
    expect(outcomeStatus(true)).toEqual({});
    await addActivity('simnet', { kind: 'swap-sell', txid: r.txid, kusdt: '2000000', kas: r.amountOut.toString(), ...outcomeStatus(r.confirmed) });
    const entry = async () => (await listActivity('simnet')).find(a => a.txid === r.txid)!;
    expect((await entry()).status).toBe(UNCONFIRMED);
    expect((await balancesOf(s.ctx, [alice.address], alice.xonly, alice.address)).kusdt).toBe(0n);
    s.showPool(afterBuy); // another transaction took the pool UTXO it spent
    await balancesOf(s.ctx, [alice.address], alice.xonly, alice.address);
    const b = await balancesOf(s.ctx, [alice.address], alice.xonly, alice.address);
    expect(b.kusdt).toBe(2_000_000n);
    expect(b.kasSpendable).toBe(10n * KAS);
    expect((await entry()).status).toBe(LOST);
    // One that confirmed loses its mark; entries of other transactions are left as they are.
    await addActivity('simnet', { kind: 'swap-buy', txid: 'aa'.repeat(32), status: UNCONFIRMED });
    await addActivity('simnet', { kind: 'redeem', txid: 'bb'.repeat(32), status: 'queued' });
    await markOutcomes('simnet', { confirmed: ['aa'.repeat(32), 'bb'.repeat(32)], lost: [] });
    const all = await listActivity('simnet');
    expect(all.find(a => a.txid === 'aa'.repeat(32))!.status).toBeUndefined();
    expect(all.find(a => a.txid === 'bb'.repeat(32))!.status).toBe('queued');
  });
});
