// Round 13 (2026-11-11, on rc.18), R13-CL-2: the wallet's own record of its states (kusdt/known.ts) is what keeps the
// balance while the coordinator cannot answer for the owner, and it lost exactly the newest states:
//   (a) what a transaction spends left the record as soon as the node took it, so the input of a pool transaction
//       that lost the race for the pool (still unspent) was gone from it;
//   (b) change of the wallet's own transaction still in the mempool was "not there" at each look (the node's UTXO
//       set is read), and three looks dropped it, however close together: a site asking for balances is a look.
// Now a spent input is marked, given back when its transaction lost, and dropped when it is seen accepted (or after
// an hour); change waits for its transaction; and looks less than a minute apart count as one. Since the deep round of
// the second outside review of rc.22 (D4-1) a marked input is dropped only once the node shows it spent, at three
// looks a minute apart, and not when its transaction is seen accepted (run20deep-known-reorg.test.ts).

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { COVENANT, FakeNode, POOL, devKey, fakeApi, kasCoin, lastBuilt, signerFor, testCtx } from './helpers';
import { USDT, holder } from './flooded';
import { MISS_SPACING_MS, OWN_FRESH_MS, SPENT_KEEP_MS, knownRecord, knownStates } from '@/kusdt/known';
import { POOL_WAIT, QuoteChanged, minimumFor, quoteSell, swap } from '@/kusdt/pool';
import { inputsOf } from '@/kusdt/pending';
import { CONFIRM_WAIT } from '@/kusdt/submit';
import { executeSend, loadTokens, planSend } from '@/kusdt/tokens';
import { settleUnconfirmed } from '@/kusdt/unconfirmed';
import { p2shAddressOf, poolValue, reserveStateOf, scriptOf } from '@/kusdt/verify';
import { plainState } from '@/kusdt/owner';
import { local, session } from '@/lib/storage';
import type { PoolState } from '@/kusdt/types';

const KAS = 100_000_000n;
const BOB = { ownerScheme: 0, owner: devKey('r13-known-bob').xonly };
const base: PoolState = { tokenCovid: COVENANT, kasReserve: 200n * KAS, tokenReserve: 20_000_000n, totalShares: 200n * KAS, protocolKas: 0n, protocolTokens: 0n, baseValue: KAS, admin: '11'.repeat(32), maxOutBps: 1_000n, windowLen: 36_000n, windowCredit: 0n, windowRef: 200n * KAS, windowOut: 0n, paused: false, guardian: '22'.repeat(32) };
/** After someone else sold: a sale now gets less KAS. */
const afterSell: PoolState = { ...base, kasReserve: base.kasReserve - 5n * KAS, tokenReserve: base.tokenReserve + 520_000n };
/** After someone else bought. */
const afterBuy: PoolState = { ...base, kasReserve: base.kasReserve + 5n * KAS, tokenReserve: base.tokenReserve - 480_000n };

let n = 0;
const uniq = (c: string) => (++n).toString(16).padStart(64, c);

/** A holder of kUSDT states beside a pool the test can move (as in round11-pool-outcome.test.ts). */
function scene(tag: string, tokens: bigint[]) {
  const alice = devKey(`r13-known-${tag}`);
  const node = new FakeNode();
  let daa = 1_000_000n;
  node.virtualDaa = async () => (daa += 10n);
  let answer: any = null;
  const listed: any[] = [];
  const ctx = testCtx(node, fakeApi({ pool: async () => answer, tokens: async () => ({ states: listed }) }));
  const poolTxids = new Set<string>();
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
  };
  for (const amount of tokens) {
    const state = plainState({ ownerScheme: 0, owner: alice.xonly }, amount), spk = scriptOf(ctx, 'KCC20', state), txid = uniq('e');
    node.utxoSet.push({ address: p2shAddressOf(spk, 'kaspasim'), transactionId: txid, index: 0, amount: 150_000_000n, scriptPublicKey: spk, blockDaaScore: 5n, isCoinbase: false, covenantId: COVENANT });
    listed.push({ utxo: { transactionId: txid, index: 0 }, state: { ...state, amount: amount.toString() } });
  }
  node.utxoSet.push(kasCoin(alice, uniq('c'), 10n * KAS));
  return { alice, signer: signerFor(alice), node, ctx, showPool, listed, silence: () => { ctx.api!.tokens = async () => { throw new Error('no answer'); }; } };
}

beforeEach(async () => {
  POOL_WAIT.ms = 0; POOL_WAIT.perDaaMs = 0;
  CONFIRM_WAIT.ms = 2_000; CONFIRM_WAIT.everyMs = 1;
  await session.remove('kusdt.pending.simnet', `kusdt.poolHint.simnet.${POOL}`, 'kusdt.unreadable.simnet');
  await local.remove('kusdt.unconfirmed.simnet');
});
afterEach(() => { vi.restoreAllMocks(); });

describe('(a) the input of a pool transaction that lost the race', () => {
  it('is back in the record at once (the reported case: a sale of 2 lost, 3,000,000 shown instead of 5,000,000)', async () => {
    const s = scene('a1', [2_000_000n, 3_000_000n]);
    s.showPool(base);
    expect((await loadTokens(s.ctx, s.signer)).total).toBe(5_000_000n);
    const seen = quoteSell(s.ctx, base, 2_000_000n);
    // The node takes the sale, and another transaction is accepted on the same pool UTXO; the new pool pays less.
    s.node.submitImpl = async () => { s.showPool(afterSell); return lastBuilt.txid; };
    const failed = await swap(s.ctx, s.signer, [s.alice.address], { side: 'sell', amountIn: 2_000_000n, minOut: minimumFor(seen, 1_000), quoted: seen }).catch(e => e);
    expect(failed).toBeInstanceOf(QuoteChanged);
    const sale = s.node.submitted[0];
    // Nothing the lost sale made stays in the record, and what it spent is there as before.
    expect((await knownStates('simnet', s.alice.xonly)).map(k => k.amount).sort()).toEqual(['2000000', '3000000']);
    expect((await knownRecord('simnet', s.alice.xonly)).some(k => inputsOf(sale).includes(`${k.txid}:${k.index}`) && k.spentBy !== undefined)).toBe(false);
    s.silence();
    const t = await loadTokens(s.ctx, s.signer);
    expect(t.fromMemory).toBe(true);
    expect(t.total).toBe(5_000_000n);
  });

  it('the same when the loss is seen later, at a refresh (settleUnconfirmed)', async () => {
    const s = scene('a2', [2_000_000n, 3_000_000n]);
    s.showPool(base);
    await loadTokens(s.ctx, s.signer);
    CONFIRM_WAIT.ms = 20;
    const seen = quoteSell(s.ctx, base, 2_000_000n);
    const r = await swap(s.ctx, s.signer, [s.alice.address], { side: 'sell', amountIn: 2_000_000n, minOut: minimumFor(seen, 100), quoted: seen });
    expect(r.confirmed).toBe(false);
    s.showPool(afterBuy);
    await settleUnconfirmed(s.ctx);
    expect(await settleUnconfirmed(s.ctx)).toEqual({ confirmed: [], lost: [r.txid] });
    s.silence();
    expect((await loadTokens(s.ctx, s.signer)).total).toBe(5_000_000n);
  });

  it('a spent input is never shown while marked, leaves once the transaction is seen accepted, and after an hour in any case', async () => {
    const h = holder('a3', [1_000n * USDT, 250n * USDT]);
    await loadTokens(h.ctx, h.signer);
    const plan = await planSend(h.ctx, h.signer, h.kas, { to: BOB, amount: 1_000n * USDT });
    const { built } = await executeSend(h.ctx, h.signer, h.kas, plan);
    const spentId = `${h.states[0].txid}:0`;
    const marked = (await knownRecord('simnet', h.alice.xonly)).find(k => `${k.txid}:${k.index}` === spentId);
    expect(marked).toMatchObject({ spentBy: built.txid });
    // Its address is filled, and the coordinator stops answering: it is not offered as "not checked".
    h.node.full.add(h.states[0].address);
    h.ctx.api!.tokens = async () => { throw new Error('no answer'); };
    const t = await loadTokens(h.ctx, h.signer);
    expect(t.unread).toEqual([]);
    expect(t.total).toBe(250n * USDT);
    // An hour on, the mark and the entry are gone.
    const now = Date.now();
    vi.spyOn(Date, 'now').mockReturnValue(now + SPENT_KEEP_MS + 1);
    await loadTokens(h.ctx, h.signer);
    expect((await knownRecord('simnet', h.alice.xonly)).map(k => `${k.txid}:${k.index}`)).not.toContain(spentId);
  });
});

describe('(b) change of the wallet\'s own transaction still in the mempool', () => {
  it('is kept through any number of looks while it waits (the reported case: 300 of 1,000 sent, the 700 lost)', async () => {
    const h = holder('b1', [1_000n * USDT, 250n * USDT]);
    await loadTokens(h.ctx, h.signer);
    const plan = await planSend(h.ctx, h.signer, h.kas, { to: BOB, amount: 300n * USDT });
    const { built } = await executeSend(h.ctx, h.signer, h.kas, plan);
    // The send waits in the mempool for a long while; the user and a site look many times, minutes apart.
    const now = Date.now();
    for (let look = 0; look < 30; look++) {
      vi.spyOn(Date, 'now').mockReturnValue(now + look * 2 * MISS_SPACING_MS);
      await loadTokens(h.ctx, h.signer);
    }
    expect((await knownStates('simnet', h.alice.xonly)).find(k => k.txid === built.txid)).toMatchObject({ amount: (700n * USDT).toString(), daa: '0' });
    // Then it is accepted, and the coordinator cannot answer for the owner.
    const change = built.outputs.find(o => (o.token as any)?.owner === h.alice.xonly)!;
    h.node.utxoSet = h.node.utxoSet.filter(u => u.transactionId !== h.states[0].txid);
    h.node.utxoSet.push({ address: p2shAddressOf(change.scriptPublicKey, 'kaspasim'), transactionId: built.txid, index: change.index, amount: change.value, scriptPublicKey: change.scriptPublicKey, blockDaaScore: 77n, isCoinbase: false, covenantId: COVENANT });
    h.ctx.api!.tokens = async () => { throw new Error('no answer'); };
    const t = await loadTokens(h.ctx, h.signer);
    expect(t.fromMemory).toBe(true);
    expect(t.total).toBe(950n * USDT);
    // Seen accepted: the spent 1,000 is not offered, and it stays in the record, marked, until the node has shown it
    // spent at three looks a minute apart (since the deep round of the second outside review of rc.22, D4-1: it left
    // at once, and a reorg that dropped the send took it out of the balance; test/run20deep-known-reorg.test.ts).
    expect((await knownStates('simnet', h.alice.xonly)).map(k => k.txid)).not.toContain(h.states[0].txid);
    expect((await knownRecord('simnet', h.alice.xonly)).find(k => k.txid === h.states[0].txid)).toMatchObject({ spentBy: built.txid });
    const seenAt = now + 29 * 2 * MISS_SPACING_MS;
    for (let look = 1; look <= 2; look++) { vi.spyOn(Date, 'now').mockReturnValue(seenAt + look * MISS_SPACING_MS); await loadTokens(h.ctx, h.signer); }
    expect((await knownRecord('simnet', h.alice.xonly)).map(k => k.txid)).not.toContain(h.states[0].txid);
  });

  it('a transaction of its own that never made it: its change leaves the record, ten minutes and three spaced looks on', async () => {
    const h = holder('b2', [1_000n * USDT]);
    await loadTokens(h.ctx, h.signer);
    const plan = await planSend(h.ctx, h.signer, h.kas, { to: BOB, amount: 300n * USDT });
    await (await import('@/kusdt/known')).noteBuilt(h.ctx, plan.built!, false);
    const now = Date.now();
    for (let look = 0; look < 3; look++) { vi.spyOn(Date, 'now').mockReturnValue(now + OWN_FRESH_MS + look * MISS_SPACING_MS); await loadTokens(h.ctx, h.signer); }
    expect((await knownStates('simnet', h.alice.xonly)).map(k => k.txid)).toEqual([h.states[0].txid]);
  });
});

describe('looks close together count as one', () => {
  it('a site asking for balances fifty times in a minute ages no record (it took three)', async () => {
    const h = holder('c1', [1_000n * USDT, 250n * USDT]);
    await loadTokens(h.ctx, h.signer);
    // The 250 is spent elsewhere: the node no longer shows it, and the coordinator does not answer.
    h.node.utxoSet = h.node.utxoSet.filter(u => u.transactionId !== h.states[1].txid);
    h.ctx.api!.tokens = async () => { throw new Error('no answer'); };
    const now = Date.now();
    for (let i = 0; i < 50; i++) { vi.spyOn(Date, 'now').mockReturnValue(now + i * 1_000); await loadTokens(h.ctx, h.signer); }
    expect(await knownStates('simnet', h.alice.xonly)).toHaveLength(2);
    // A look a minute after each of two more: three in all, and it is gone.
    for (let i = 1; i <= 2; i++) { vi.spyOn(Date, 'now').mockReturnValue(now + i * MISS_SPACING_MS); await loadTokens(h.ctx, h.signer); }
    expect((await knownStates('simnet', h.alice.xonly)).map(k => k.txid)).toEqual([h.states[0].txid]);
  });
});
