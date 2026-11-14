// Round 12, R12-WW-1: the wallet's own record of its states (kusdt/known.ts) must stay true where the node cannot
// correct it. A state at an address the node cannot list is never shown as gone by the node, so a record of one that
// was spent would stay "not checked" for good unless something else takes it out.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { KNOWN_KEEP, MISS_SPACING_MS, OWNERS_KEEP, UNLISTED_AFTER_MS, knownStates, noteBuilt, updateKnown } from '@/kusdt/known';
import { executeSend, loadTokens, planSend } from '@/kusdt/tokens';
import { local, session } from '@/lib/storage';
import { devKey } from './helpers';
import { USDT, holder } from './flooded';

const BOB = { ownerScheme: 0, owner: devKey('r12-full-bob').xonly };

beforeEach(async () => {
  for (const k of ['kusdt.pending.simnet', 'kusdt.unreadable.simnet']) await session.remove(k);
});
afterEach(() => { vi.restoreAllMocks(); });

describe('the record of a state at an address the node cannot list', () => {
  it('loses the state the moment the wallet\'s own transaction spends it', async () => {
    const h = holder('f1', [1_000n * USDT, 250n * USDT]);
    await loadTokens(h.ctx, h.signer);
    h.node.full.add(h.states[0].address);
    const plan = await planSend(h.ctx, h.signer, h.kas, { to: BOB, amount: 300n * USDT, unchecked: true });
    const { built } = await executeSend(h.ctx, h.signer, h.kas, plan);
    const known = await knownStates('simnet', h.alice.xonly);
    expect(known.map(k => k.txid)).not.toContain(h.states[0].txid);
    // Its change (700) is in the record instead, as the transaction made it.
    expect(known.find(k => k.txid === built.txid)).toMatchObject({ amount: (700n * USDT).toString(), daa: '0' });
    // The coordinator follows the spend and stops listing the state. Ten minutes on, when the mark on the
    // transaction's inputs has run out, the spent state does not come back as "not checked".
    h.listed.splice(0, 1);
    await session.remove('kusdt.pending.simnet');
    const t = await loadTokens(h.ctx, h.signer);
    expect(t.unread.map(s => s.utxo.transactionId)).not.toContain(h.states[0].txid);
  });

  it('keeps the state while it is not known that the node took the transaction', async () => {
    const h = holder('f2', [1_000n * USDT]);
    await loadTokens(h.ctx, h.signer);
    const plan = await planSend(h.ctx, h.signer, h.kas, { to: BOB, amount: 300n * USDT });
    await noteBuilt(h.ctx, plan.built!, false);
    const known = await knownStates('simnet', h.alice.xonly);
    expect(known.map(k => k.txid).sort()).toEqual([h.states[0].txid, plan.built!.txid].sort());
  });

  it('drops a record the coordinator\'s full list has stopped naming, after three looks and not before ten minutes', async () => {
    const h = holder('f3', [1_000n * USDT, 250n * USDT]);
    await loadTokens(h.ctx, h.signer);
    // The address is filled, and the state is spent with this key on another device: the coordinator no longer lists it.
    h.node.full.add(h.states[0].address);
    h.listed.splice(0, 1);
    for (let i = 0; i < 5; i++) expect((await loadTokens(h.ctx, h.signer)).unreadTotal).toBe(1_000n * USDT);
    // (A state the wallet made a moment ago is not in the coordinator's list yet either: that says nothing.)
    const now = Date.now();
    // Since round 13 (R13-CL-2) looks less than a minute apart count as one: they are spaced here.
    const at = (look: number) => vi.spyOn(Date, 'now').mockReturnValue(now + UNLISTED_AFTER_MS + 1 + look * MISS_SPACING_MS);
    at(0);
    await session.remove('kusdt.unreadable.simnet');
    expect((await loadTokens(h.ctx, h.signer)).unreadTotal).toBe(1_000n * USDT);
    at(1);
    expect((await loadTokens(h.ctx, h.signer)).unreadTotal).toBe(1_000n * USDT);
    // The third such look takes it out of the record; from the next one on it is not shown.
    at(2);
    await loadTokens(h.ctx, h.signer);
    expect((await knownStates('simnet', h.alice.xonly)).map(k => k.txid)).toEqual([h.states[1].txid]);
    const t = await loadTokens(h.ctx, h.signer);
    expect(t.unread).toEqual([]);
    expect(t.total).toBe(250n * USDT);
  });

  it('keeps it while the coordinator still names it, however long', async () => {
    const h = holder('f4', [1_000n * USDT]);
    await loadTokens(h.ctx, h.signer);
    h.node.full.add(h.states[0].address);
    const now = Date.now();
    vi.spyOn(Date, 'now').mockReturnValue(now + 10 * UNLISTED_AFTER_MS);
    await session.remove('kusdt.unreadable.simnet');
    for (let i = 0; i < 5; i++) expect((await loadTokens(h.ctx, h.signer)).unreadTotal).toBe(1_000n * USDT);
    // Nor is it dropped while the coordinator does not answer at all: its silence names nothing.
    h.ctx.api!.tokens = async () => { throw new Error('no answer'); };
    for (let i = 0; i < 5; i++) expect((await loadTokens(h.ctx, h.signer)).unreadTotal).toBe(1_000n * USDT);
  });
});

describe('the record is bounded', () => {
  it('keeps the states that hold the most: dust sent to the key cannot push the real ones out', async () => {
    const owner = devKey('r12-record-dust').xonly;
    const real = { txid: 'aa'.repeat(32), index: 0, amount: 5_000n * USDT, kas: 150_000_000n, daa: 1n };
    await updateKnown('simnet', owner, [real], []);
    const dust = Array.from({ length: KNOWN_KEEP + 100 }, (_, i) => ({ txid: (0xd0000000 + i).toString(16).padStart(64, '0'), index: 0, amount: 1n, kas: 150_000_000n, daa: 2n }));
    await updateKnown('simnet', owner, dust, []);
    const known = await knownStates('simnet', owner);
    expect(known).toHaveLength(KNOWN_KEEP);
    expect(known[0]).toMatchObject({ txid: real.txid, amount: (5_000n * USDT).toString() });
  });

  it('keeps records for a bounded number of owners', async () => {
    const owners = Array.from({ length: OWNERS_KEEP + 3 }, (_, i) => devKey(`r12-record-owner-${i}`).xonly);
    for (const o of owners) await updateKnown('simnet', o, [{ txid: 'bb'.repeat(32), index: 0, amount: 1n, kas: 1n, daa: 1n }], []);
    const index = await local.get<string[]>('kusdt.known.owners.simnet');
    expect(index!.length).toBeLessThanOrEqual(OWNERS_KEEP);
    expect(await knownStates('simnet', owners[0])).toEqual([]);
    expect(await knownStates('simnet', owners[owners.length - 1])).toHaveLength(1);
  });

  it('takes nothing that is not a well-formed entry', async () => {
    const owner = devKey('r12-record-junk').xonly;
    await local.set({ [`kusdt.known.simnet.${owner}`]: [{ txid: 'zz', index: 0, amount: '1', kas: '1', daa: '1' }, { txid: 'cc'.repeat(32), index: -1, amount: '1', kas: '1', daa: '1' }, { txid: 'cc'.repeat(32), index: 0, amount: '1e9', kas: '1', daa: '1' }, null] });
    expect(await knownStates('simnet', owner)).toEqual([]);
  });
});
