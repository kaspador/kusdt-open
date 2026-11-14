// Round 12, R12-WW-1: anyone can send coins to an address, and a Kaspa node answers every coin at an address in one
// message or not at all. A kUSDT state's address follows from public fields (the owner's key and the amount), so an
// outsider can fill the address of a state a holder has, or send the holder a dust state at an address filled
// beforehand. The wallet asked its node for all of its state addresses in one call: that one call failed (the answer
// is over what a browser client reads, or it timed out), and with it the whole balance and every send, redemption
// and sale, also of the kUSDT at addresses that can be listed.
//
// Now one such address costs only the states that sit there, those are shown apart as not checked and can be spent
// from the wallet's record at the user's word, and the reads this takes are bounded. A fake node stands in for
// kaspad (test/flooded.ts).

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { balancesOf } from '@/wallet/context';
import { NodeRejected } from '@/kaspa/node';
import { KNOWN_KEEP, MISS_SPACING_MS, knownStates } from '@/kusdt/known';
import { plainState } from '@/kusdt/owner';
import { inputsOf } from '@/kusdt/pending';
import { freshPool, loadPositions } from '@/kusdt/pool';
import { LandsUnlisted, executeSend, loadTokens, planSend } from '@/kusdt/tokens';
import { UNREADABLE, unreadableNow } from '@/kusdt/unreadable';
import { MAX_LISTED, PoolUnreadable, p2shAddressOf, poolValue, reserveStateOf, scriptOf } from '@/kusdt/verify';
import { local, session } from '@/lib/storage';
import type { PoolState } from '@/kusdt/types';
import { COVENANT, NET, POOL, devKey, lastBuilt } from './helpers';
import { USDT, holder, type Holder } from './flooded';

const BOB = { ownerScheme: 0, owner: devKey('r12-full-bob').xonly };

beforeEach(async () => {
  for (const k of ['kusdt.pending.simnet', 'kusdt.unreadable.simnet']) await session.remove(k);
  await local.remove('kusdt.positions.simnet');
});
afterEach(() => { vi.restoreAllMocks(); });

/** How many reads of the UTXO set named `address`. */
const naming = (h: Holder, address: string) => h.node.reads.filter(r => r.includes(address)).length;

describe('one kUSDT state at an address too full to list', () => {
  it('does not take the rest of the holder\'s kUSDT out of the wallet (the gift: 1 unit at a filled address)', async () => {
    const h = holder('a1', [1_000n * USDT, 1n]);
    h.node.full.add(h.states[1].address);

    const t = await loadTokens(h.ctx, h.signer);
    expect(t.total).toBe(1_000n * USDT);
    expect(t.states.map(s => s.utxo.transactionId)).toEqual([h.states[0].txid]);

    const b = await balancesOf(h.ctx, h.kas, h.alice.xonly, h.alice.address);
    expect(b.kusdt).toBe(1_000n * USDT);
    expect(b.kusdtError).toBeUndefined();

    const plan = await planSend(h.ctx, h.signer, h.kas, { to: BOB, amount: 400n * USDT });
    expect(plan.built).not.toBeNull();
    expect(plan.picked.map(p => p.utxo.transactionId)).toEqual([h.states[0].txid]);
  });

  it('the same when the node is only too slow for that one address', async () => {
    const h = holder('a2', [1_000n * USDT, 250n * USDT]);
    h.node.slow.add(h.states[0].address);
    const t = await loadTokens(h.ctx, h.signer);
    expect(t.total).toBe(250n * USDT);
  });

  it('a position at a filled address is not shown as gone', async () => {
    const h = holder('a3', []);
    const state = { tokenCovid: COVENANT, shares: 5_000n, owner: h.alice.xonly };
    const spk = scriptOf(h.ctx, 'Position', state);
    const address = p2shAddressOf(spk, NET.prefix);
    const txid = 'a3e'.padEnd(64, '0');
    h.node.utxoSet.push({ address, transactionId: txid, index: 1, amount: 100_000_000n, scriptPublicKey: spk, blockDaaScore: 5n, isCoinbase: false, covenantId: POOL });
    h.ctx.api!.positions = async () => ({ positions: [{ utxo: { transactionId: txid, index: 1, amount: 100_000_000 }, state: { ...state, shares: 5000 } }] });
    const [seen] = await loadPositions(h.ctx, h.signer);
    expect(seen.id).toBe(`${txid}:1`);
    expect(seen.unread).toBeUndefined();
    h.node.full.add(address);
    const flooded = await loadPositions(h.ctx, h.signer);
    expect(flooded.map(p => p.id)).toEqual([`${txid}:1`]);
    // Listed as not checked, with what its record says.
    expect(flooded[0].unread).toBe(true);
    expect(flooded[0].located.utxo).toMatchObject({ amount: 100_000_000n, scriptPublicKey: spk, covenantId: POOL, unchecked: true });
    expect(flooded[0].located.state.shares).toBe(5_000n);
  });
});

// ── What the new reads may cost ─────────────────────────────────────────────

describe('the reads a filled address can cause are bounded', () => {
  it('an address that could not be listed is not asked about again for ten minutes', async () => {
    const h = holder('b1', [1_000n * USDT, 1n]);
    const [, gift] = h.states;
    h.node.full.add(gift.address);
    await loadTokens(h.ctx, h.signer);
    // One read of both (refused), then each on its own: the filled one is asked about twice in all.
    expect(h.node.reads.map(r => r.length)).toEqual([2, 1, 1]);
    expect(naming(h, gift.address)).toBe(2);
    expect(await unreadableNow('simnet')).toEqual(new Set([gift.address]));

    for (let i = 0; i < 5; i++) expect((await loadTokens(h.ctx, h.signer)).total).toBe(1_000n * USDT);
    expect(naming(h, gift.address)).toBe(2);
    expect(h.node.reads.slice(3).every(r => r.length === 1 && r[0] === h.states[0].address)).toBe(true);

    // Ten minutes on it is asked about once more (the read of both, then its own), and then not again.
    const now = Date.now();
    vi.spyOn(Date, 'now').mockReturnValue(now + UNREADABLE.fullMs + 1);
    await loadTokens(h.ctx, h.signer);
    await loadTokens(h.ctx, h.signer);
    expect(naming(h, gift.address)).toBe(4);
  });

  it('an address that only timed out is asked again sooner, and is fine when the node answers', async () => {
    const h = holder('b2', [1_000n * USDT, 250n * USDT]);
    h.node.slow.add(h.states[0].address);
    expect((await loadTokens(h.ctx, h.signer)).unreadTotal).toBe(1_000n * USDT);
    h.node.slow.clear();
    // Still not asked about: a minute has not passed.
    expect((await loadTokens(h.ctx, h.signer)).total).toBe(250n * USDT);
    const now = Date.now();
    vi.spyOn(Date, 'now').mockReturnValue(now + UNREADABLE.slowMs + 1);
    const t = await loadTokens(h.ctx, h.signer);
    expect(t.total).toBe(1_250n * USDT);
    expect(t.unread).toEqual([]);
  });

  it('one look reads at most 64 addresses on their own; an owner with more has the rest read at the next looks', async () => {
    const h = holder('b3', Array.from({ length: 70 }, (_, i) => BigInt(1_000 + i) * USDT));
    // The filled one is the 68th in the order the wallet asks in: not reached by the first look's own reads.
    const bad = h.states[67];
    h.node.full.add(bad.address);
    const first = await loadTokens(h.ctx, h.signer);
    expect(h.node.reads.filter(r => r.length === 1)).toHaveLength(UNREADABLE.singles);
    expect(h.node.reads).toHaveLength(1 + UNREADABLE.singles);
    // What was not asked about is not in the balance and not dropped: it is "not read", this time only.
    expect(first.states).toHaveLength(64);
    expect(first.unread).toHaveLength(6);
    expect(await unreadableNow('simnet')).toEqual(new Set());

    h.node.reads = [];
    const second = await loadTokens(h.ctx, h.signer);
    expect(h.node.reads.length).toBeLessThanOrEqual(1 + UNREADABLE.singles);
    expect(await unreadableNow('simnet')).toEqual(new Set([bad.address]));
    expect(second.unread.some(s => s.utxo.transactionId === bad.txid)).toBe(true);

    h.node.reads = [];
    const third = await loadTokens(h.ctx, h.signer);
    expect(h.node.reads).toHaveLength(1);
    expect(third.states).toHaveLength(69);
    expect(third.unread.map(s => s.utxo.transactionId)).toEqual([bad.txid]);
  });

  it('a slow node is not asked address after address: after two timeouts the rest is left unasked, and not remembered', async () => {
    const h = holder('b4', [5n, 4n, 3n, 2n, 1n].map(v => v * USDT));
    for (const s of h.states) h.node.slow.add(s.address);
    const t = await loadTokens(h.ctx, h.signer);
    expect(h.node.reads.map(r => r.length)).toEqual([5, 1, 1]);
    expect(t.states).toEqual([]);
    expect(t.unread).toHaveLength(5);
    expect((await unreadableNow('simnet')).size).toBe(UNREADABLE.timeouts);
  });

  it('a node that refuses every list cannot make the wallet remember more than 64 addresses', async () => {
    const h = holder('b5', Array.from({ length: 70 }, (_, i) => BigInt(2_000 + i) * USDT));
    for (const s of h.states) h.node.full.add(s.address);
    for (let i = 0; i < 4; i++) await loadTokens(h.ctx, h.signer);
    expect((await unreadableNow('simnet')).size).toBeLessThanOrEqual(UNREADABLE.keep);
    expect(UNREADABLE.keep).toBe(64);
  });

  it('looks at no more states of the coordinator\'s answer than the coordinator ever gives', async () => {
    const h = holder('b6', [10n * USDT]);
    for (let i = 0; i < MAX_LISTED + 50; i++) {
      h.listed.push({ utxo: { transactionId: (0xb600000 + i).toString(16).padStart(64, '0'), index: 0 }, state: { ...plainState({ ownerScheme: 0, owner: h.alice.xonly }, BigInt(9_000_000 + i)), amount: 9_000_000 + i } });
    }
    await loadTokens(h.ctx, h.signer);
    expect(h.node.reads[0].length).toBe(MAX_LISTED);
  });

  it('any other failure of the node is still a failure: nothing is shown as "not read" for it', async () => {
    const h = holder('b7', [10n * USDT, 5n * USDT]);
    h.node.utxos = async () => { throw new Error('connection closed'); };
    await expect(loadTokens(h.ctx, h.signer)).rejects.toThrow('connection closed');
  });
});

// ── Spending a state the node cannot show ───────────────────────────────────

describe('a state at an address the node cannot list', () => {
  it('is not in the balance and is never chosen by itself', async () => {
    const h = holder('c1', [1_000n * USDT, 250n * USDT]);
    h.node.full.add(h.states[0].address);
    const t = await loadTokens(h.ctx, h.signer);
    expect(t.total).toBe(250n * USDT);
    expect(t.unread.map(s => [s.utxo.transactionId, s.state.amount, s.utxo.unchecked])).toEqual([[h.states[0].txid, 1_000n * USDT, true]]);
    expect(t.unreadTotal).toBe(1_000n * USDT);
    await expect(planSend(h.ctx, h.signer, h.kas, { to: BOB, amount: 300n * USDT })).rejects.toThrow('Not enough kUSDT.');
    const b = await balancesOf(h.ctx, h.kas, h.alice.xonly, h.alice.address);
    expect(b).toMatchObject({ kusdt: 250n * USDT, unchecked: 1, uncheckedKusdt: 1_000n * USDT });
  });

  it('is spent from its record when the user says so, and the plan says how much of it is unchecked', async () => {
    const h = holder('c2', [1_000n * USDT, 250n * USDT]);
    h.node.full.add(h.states[0].address);
    const plan = await planSend(h.ctx, h.signer, h.kas, { to: BOB, amount: 300n * USDT, unchecked: true });
    expect(plan.unchecked).toBe(1_000n * USDT);
    expect(plan.picked.map(p => p.utxo.transactionId)).toEqual([h.states[0].txid]);
    expect(inputsOf(plan.built!.transaction)).toContain(h.states[0].outpoint);
    // The outputs are the wallet's own making, as in every send: 300 to Bob, 700 back to its own key.
    expect(plan.built!.outputs.filter(o => o.token).map(o => [o.token.owner, BigInt(o.token.amount)])).toEqual([[BOB.owner, 300n * USDT], [h.alice.xonly, 700n * USDT]]);
    const { txid } = await executeSend(h.ctx, h.signer, h.kas, plan);
    expect(txid).toBe(lastBuilt.txid);
    expect(h.node.submitted).toHaveLength(1);
    // A plan made without the user's word has none of it: it takes the 250 the node shows, or fails.
    const other = holder('c2b', [1_000n * USDT, 250n * USDT]);
    other.node.full.add(other.states[0].address);
    const plain = await planSend(other.ctx, other.signer, other.kas, { to: BOB, amount: 200n * USDT });
    expect(plain.unchecked).toBe(0n);
    expect(plain.picked.map(p => p.utxo.transactionId)).toEqual([other.states[1].txid]);
  });

  it('the node is the judge: its refusal is said as what it means', async () => {
    const h = holder('c3', [1_000n * USDT]);
    h.node.full.add(h.states[0].address);
    const plan = await planSend(h.ctx, h.signer, h.kas, { to: BOB, amount: 300n * USDT, unchecked: true });
    h.node.submitImpl = async () => { throw new NodeRejected('transaction spends a missing outpoint'); };
    const e = await executeSend(h.ctx, h.signer, h.kas, plan).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(NodeRejected);
    expect((e as Error).message).toMatch(/could not check on the node.*Nothing was sent/);
    expect((e as Error).message).toContain('missing outpoint');
  });

  it('is built on the wallet\'s own record of the coin where it has one, not on the coordinator\'s', async () => {
    const h = holder('c4', [1_000n * USDT]);
    // The wallet sees the state once while its address can still be listed...
    await loadTokens(h.ctx, h.signer);
    expect((await knownStates('simnet', h.alice.xonly)).map(k => [k.txid, k.amount, k.kas])).toEqual([[h.states[0].txid, (1_000n * USDT).toString(), '150000000']]);
    // ...then the address is filled, and the coordinator names another KAS amount for the coin.
    h.node.full.add(h.states[0].address);
    (h.listed[0].utxo as { amount: unknown }).amount = 900_000_000;
    const t = await loadTokens(h.ctx, h.signer);
    expect(t.unread[0].utxo.amount).toBe(150_000_000n);
    // Nor can the coordinator talk the wallet out of its record by naming another kUSDT amount for the outpoint: it
    // would then be looked for at another address, not found there, and dropped after three looks.
    (h.listed[0].state as { amount: unknown }).amount = 5_000_000_000;
    for (let i = 0; i < 5; i++) {
      const again = await loadTokens(h.ctx, h.signer);
      expect(again.unread.map(s => [s.utxo.transactionId, s.state.amount, s.utxo.amount])).toEqual([[h.states[0].txid, 1_000n * USDT, 150_000_000n]]);
      expect(again.rejected).toBe(0);
    }
    expect(await knownStates('simnet', h.alice.xonly)).toHaveLength(1);
  });

  it('a state the node says is not there is never offered as "not read"', async () => {
    const h = holder('c5', [1_000n * USDT, 250n * USDT]);
    // Listed by the coordinator, absent on the node, at an address that lists fine.
    h.node.utxoSet = h.node.utxoSet.filter(u => u.transactionId !== h.states[0].txid);
    let t = await loadTokens(h.ctx, h.signer);
    expect(t.unread).toEqual([]);
    expect(t.rejected).toBe(1);
    // At a filled address, but spent by a transaction in the mempool: on its way out, not "not read".
    h.node.full.add(h.states[1].address);
    h.node.spent.add(h.states[1].outpoint);
    t = await loadTokens(h.ctx, h.signer);
    expect(t.unread).toEqual([]);
    await expect(planSend(h.ctx, h.signer, h.kas, { to: BOB, amount: 1n * USDT, unchecked: true })).rejects.toThrow('Not enough kUSDT.');
  });

  it('is not sent back to the address it sits at: all of it to oneself, or change of the same amount, is refused', async () => {
    const h = holder('c6', [1_000n * USDT, 250n * USDT]);
    h.node.full.add(h.states[0].address);
    const self = { ownerScheme: 0, owner: h.alice.xonly };
    await expect(planSend(h.ctx, h.signer, h.kas, { to: self, amount: 1_000n * USDT, unchecked: true })).rejects.toBeInstanceOf(LandsUnlisted);
    // 250 of the 1,250 to Bob would leave change of exactly 1,000: the same address again.
    await expect(planSend(h.ctx, h.signer, h.kas, { to: BOB, amount: 250n * USDT, unchecked: true })).resolves.toMatchObject({ unchecked: 1_000n * USDT });
    const both = await planSend(h.ctx, h.signer, h.kas, { to: self, amount: 1_250n * USDT, unchecked: true });
    expect(both.picked).toHaveLength(2);
    // A part to oneself moves it: both new states have other amounts, so other addresses.
    const part = await planSend(h.ctx, h.signer, h.kas, { to: self, amount: 400n * USDT, unchecked: true });
    expect(part.built!.outputs.filter(o => o.token).map(o => BigInt(o.token.amount))).toEqual([400n * USDT, 600n * USDT]);
  });

  it('a state with no record of its coin is counted, and cannot be built on', async () => {
    const h = holder('c7', [1_000n * USDT]);
    h.node.full.add(h.states[0].address);
    delete (h.listed[0].utxo as { amount?: unknown }).amount;
    const t = await loadTokens(h.ctx, h.signer);
    expect(t.unread).toEqual([]);
    expect(t.unreadNoRecord).toBe(1);
    expect((await balancesOf(h.ctx, h.kas, h.alice.xonly, h.alice.address)).unchecked).toBe(1);
  });
});

// ── The wallet's own record ─────────────────────────────────────────────────

describe('what the wallet has seen for itself', () => {
  it('keeps its balance when the coordinator cannot answer for the owner, and says where the list came from', async () => {
    const h = holder('d1', [1_000n * USDT, 250n * USDT]);
    expect((await loadTokens(h.ctx, h.signer)).fromMemory).toBe(false);
    h.ctx.api!.tokens = async () => { throw new Error('too many coins at one of this owner\'s addresses'); };
    const t = await loadTokens(h.ctx, h.signer);
    expect(t.total).toBe(1_250n * USDT);
    expect(t.fromMemory).toBe(true);
    expect((await balancesOf(h.ctx, h.kas, h.alice.xonly, h.alice.address)).kusdtFromMemory).toBe(true);
    // Nothing is taken on the record's word: a state the node no longer shows is not in the balance.
    h.node.utxoSet = h.node.utxoSet.filter(u => u.transactionId !== h.states[1].txid);
    expect((await loadTokens(h.ctx, h.signer)).total).toBe(1_000n * USDT);
    // And what is missing for a send is said as the coordinator's silence, not as an empty wallet.
    await expect(planSend(h.ctx, h.signer, h.kas, { to: BOB, amount: 1_100n * USDT })).rejects.toThrow(/bridge server did not answer \(too many coins/);
  });

  it('a wallet that never saw its states fails as before when the coordinator does not answer', async () => {
    const h = holder('d2', [1_000n * USDT], { api: { tokens: async () => { throw new Error('Could not reach the coordinator API.'); } } });
    await expect(loadTokens(h.ctx, h.signer)).rejects.toThrow('Could not reach the coordinator API.');
  });

  it('follows its own change: after a send with the coordinator silent, what it kept is found again', async () => {
    const h = holder('d3', [1_000n * USDT]);
    await loadTokens(h.ctx, h.signer);
    h.ctx.api!.tokens = async () => { throw new Error('no answer'); };
    const plan = await planSend(h.ctx, h.signer, h.kas, { to: BOB, amount: 300n * USDT });
    const { built } = await executeSend(h.ctx, h.signer, h.kas, plan);
    // The node accepts it: the spent state goes, the outputs appear.
    h.node.utxoSet = h.node.utxoSet.filter(u => u.transactionId !== h.states[0].txid);
    for (const o of built.outputs.filter(x => x.token)) {
      h.node.utxoSet.push({ address: p2shAddressOf(o.scriptPublicKey, NET.prefix), transactionId: built.txid, index: o.index, amount: o.value, scriptPublicKey: o.scriptPublicKey, blockDaaScore: 9n, isCoinbase: false, covenantId: COVENANT });
    }
    const t = await loadTokens(h.ctx, h.signer);
    expect(t.fromMemory).toBe(true);
    expect(t.states.map(s => [s.utxo.transactionId, s.state.amount])).toEqual([[built.txid, 700n * USDT]]);
    // Bob's state is not this wallet's to keep.
    expect(await knownStates('simnet', BOB.owner)).toEqual([]);
  });

  it('forgets a state the node did not show at three looks in a row, and holds a bounded number', async () => {
    const h = holder('d4', [1_000n * USDT, 250n * USDT]);
    await loadTokens(h.ctx, h.signer);
    h.node.utxoSet = h.node.utxoSet.filter(u => u.transactionId !== h.states[1].txid);
    h.listed.splice(1, 1);
    // Since round 13 (R13-CL-2) looks less than a minute apart count as one: they are spaced here.
    const now = Date.now();
    const at = (look: number) => vi.spyOn(Date, 'now').mockReturnValue(now + look * MISS_SPACING_MS);
    for (let i = 0; i < 2; i++) { at(i); await loadTokens(h.ctx, h.signer); }
    expect(await knownStates('simnet', h.alice.xonly)).toHaveLength(2);
    at(2);
    await loadTokens(h.ctx, h.signer);
    expect((await knownStates('simnet', h.alice.xonly)).map(k => k.txid)).toEqual([h.states[0].txid]);
    expect(KNOWN_KEEP).toBe(600);
  });
});

// ── The pool ────────────────────────────────────────────────────────────────

describe('the pool at an address the node cannot list', () => {
  it('is refused at once with the reason, and is never built on unchecked', async () => {
    const h = holder('e1', []);
    const KAS = 100_000_000n;
    const pool: PoolState = { tokenCovid: COVENANT, kasReserve: 200n * KAS, tokenReserve: 20_000_000n, totalShares: 200n * KAS, protocolKas: 0n, protocolTokens: 0n, baseValue: KAS, admin: '11'.repeat(32), maxOutBps: 1_000n, windowLen: 36_000n, windowCredit: 0n, windowRef: 0n, windowOut: 0n, paused: false, guardian: '22'.repeat(32) };
    const pspk = scriptOf(h.ctx, 'Pool', pool), reserve = reserveStateOf(POOL, pool), rspk = scriptOf(h.ctx, 'KCC20', reserve);
    const ptx = 'e1f'.padEnd(64, '0');
    h.node.utxoSet.push(
      { address: p2shAddressOf(pspk, NET.prefix), transactionId: ptx, index: 0, amount: poolValue(pool), scriptPublicKey: pspk, blockDaaScore: 1n, isCoinbase: false, covenantId: POOL },
      { address: p2shAddressOf(rspk, NET.prefix), transactionId: ptx, index: 1, amount: 150_000_000n, scriptPublicKey: rspk, blockDaaScore: 1n, isCoinbase: false, covenantId: COVENANT },
    );
    let asked = 0;
    h.ctx.api!.pool = async () => { asked++; return { pool: { utxo: { transactionId: ptx, index: 0 }, state: pool }, reserve: { utxo: { transactionId: ptx, index: 1 }, state: reserve } }; };
    expect((await freshPool(h.ctx)).pool.utxo.transactionId).toBe(ptx);
    asked = 0;
    h.node.full.add(p2shAddressOf(pspk, NET.prefix));
    const e = await freshPool(h.ctx).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(PoolUnreadable);
    expect((e as Error).message).toMatch(/too many coins.*Nothing was sent/);
    // Said at once: asking again would get the same.
    expect(asked).toBe(1);
  });
});
