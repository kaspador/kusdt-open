// Round 13 (2026-11-11, on rc.18), R13-CL-1: above the coordinator's 100 MB read GET /tokens failed for an owner with
// one state at a filled address, and a wallet with no record of its own (a new install, or another device) lost all
// of that key's kUSDT: loadTokens rethrew the coordinator's failure, so no balance, and every send, redemption and
// sale failed, also of the states at addresses anyone can list. The coordinator never answered again, since nothing
// removes the coins.
//
// Now the coordinator answers the rest, and its records at the full address apart (`unread`); the wallet takes those
// as it takes any state its node cannot show: apart, not in the balance, spent only at the user's word, and the node
// judges the spend.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CoordinatorClient, type ApiLocated } from '@/kusdt/api';
import { UNLISTED_AFTER_MS, knownStates } from '@/kusdt/known';
import { loadPositions } from '@/kusdt/pool';
import { executeSend, loadTokens, planSend } from '@/kusdt/tokens';
import { p2shAddressOf, scriptOf } from '@/kusdt/verify';
import { local, session } from '@/lib/storage';
import { COVENANT, NET, POOL, devKey } from './helpers';
import { USDT, holder } from './flooded';

const BOB = { ownerScheme: 0, owner: devKey('r13-unread-bob').xonly };

beforeEach(async () => {
  for (const k of ['kusdt.pending.simnet', 'kusdt.unreadable.simnet']) await session.remove(k);
  await local.remove('kusdt.positions.simnet');
});
afterEach(() => { vi.restoreAllMocks(); });

/** A holder whose first state sits at an address neither its node nor the coordinator can read: the coordinator answers it apart. */
function filled(tag: string, amounts: bigint[]) {
  const h = holder(tag, amounts);
  h.node.full.add(h.states[0].address);
  const unread: ApiLocated[] = h.listed.splice(0, 1);
  h.ctx.api!.tokens = async () => ({ states: h.listed, unread });
  return { ...h, unread };
}

describe('a wallet with no record, and the coordinator answering a state at a filled address apart', () => {
  it('shows the rest and the filled state apart, instead of failing (the reported case: 1,000 kUSDT filled, 250 readable)', async () => {
    const h = filled('d1', [1_000n * USDT, 250n * USDT]);
    expect(await knownStates('simnet', h.alice.xonly)).toEqual([]);
    const t = await loadTokens(h.ctx, h.signer);
    expect(t.total).toBe(250n * USDT);
    expect(t.fromMemory).toBe(false);
    expect(t.unread.map(s => [s.utxo.transactionId, s.state.amount, s.utxo.amount, s.utxo.unchecked])).toEqual([[h.states[0].txid, 1_000n * USDT, 150_000_000n, true]]);
    expect(t.unreadTotal).toBe(1_000n * USDT);
  });

  it('sends from the readable rest, and from the filled state at the user\'s word, which the node then judges', async () => {
    const h = filled('d2', [1_000n * USDT, 250n * USDT]);
    const plain = await planSend(h.ctx, h.signer, h.kas, { to: BOB, amount: 100n * USDT });
    expect(plain.picked.map(p => p.utxo.transactionId)).toEqual([h.states[1].txid]);
    expect(plain.unchecked).toBe(0n);
    const unchecked = await planSend(h.ctx, h.signer, h.kas, { to: BOB, amount: 100n * USDT, unchecked: true });
    expect(unchecked.picked.map(p => p.utxo.transactionId)).toEqual([h.states[0].txid]);
    expect(unchecked.unchecked).toBe(1_000n * USDT);
    const { txid } = await executeSend(h.ctx, h.signer, h.kas, unchecked);
    expect(txid).toMatch(/^[0-9a-f]{64}$/);
  });

  it('an answer with unread entries is not a full list: a record it does not name is not aged out by it', async () => {
    const h = holder('d3', [1_000n * USDT, 250n * USDT, 40n * USDT]);
    await loadTokens(h.ctx, h.signer);
    // The 1,000 is now at a filled address, and the coordinator answers only the 40 there apart (it has a filled address of its own).
    h.node.full.add(h.states[0].address);
    h.node.full.add(h.states[2].address);
    const unread = [h.listed[2]];
    h.ctx.api!.tokens = async () => ({ states: [h.listed[1]], unread });
    const now = Date.now();
    vi.spyOn(Date, 'now').mockReturnValue(now + 2 * UNLISTED_AFTER_MS);
    await session.remove('kusdt.unreadable.simnet');
    for (let i = 0; i < 5; i++) {
      vi.spyOn(Date, 'now').mockReturnValue(now + 2 * UNLISTED_AFTER_MS + (i + 1) * 120_000);
      expect((await loadTokens(h.ctx, h.signer)).unreadTotal).toBe(1_040n * USDT);
    }
    expect((await knownStates('simnet', h.alice.xonly)).map(k => k.txid)).toContain(h.states[0].txid);
  });

  it('still fails when the coordinator does not answer and the wallet has no record: there is nothing to look for', async () => {
    const h = holder('d4', [1_000n * USDT]);
    h.ctx.api!.tokens = async () => { throw new Error('no answer'); };
    await expect(loadTokens(h.ctx, h.signer)).rejects.toThrow('no answer');
  });

  it('a liquidity position the coordinator answers apart is listed as not checked', async () => {
    const h = holder('d5', []);
    const state = { tokenCovid: COVENANT, shares: 7_000n, owner: h.alice.xonly };
    const spk = scriptOf(h.ctx, 'Position', state);
    const address = p2shAddressOf(spk, NET.prefix);
    h.node.full.add(address);
    const txid = 'b5e'.padEnd(64, '0');
    h.ctx.api!.positions = async () => ({ positions: [], unread: [{ utxo: { transactionId: txid, index: 1, amount: 100_000_000, scriptPublicKey: spk, covenantId: POOL }, state: { ...state, shares: 7000 } }] });
    const [p] = await loadPositions(h.ctx, h.signer);
    expect(p).toMatchObject({ id: `${txid}:1`, unread: true });
    expect(p.located.utxo).toMatchObject({ amount: 100_000_000n, unchecked: true });
  });
});

describe('the coordinator client', () => {
  it('hands the wallet the `unread` entries of /tokens and /positions, and only lists', async () => {
    const answers: Record<string, string> = {
      '/tokens': '{"states":[{"utxo":{"transactionId":"aa","index":0},"state":{}}],"unread":[{"utxo":{"transactionId":"bb","index":0,"amount":150000000},"state":{"amount":"1"}}]}',
      '/positions': '{"positions":[],"unread":{"not":"a list"}}',
    };
    const fetcher = (async (url: string) => {
      const path = new URL(url).pathname.replace('/api/v1', '');
      return new Response(answers[path], { status: 200 });
    }) as unknown as typeof fetch;
    const api = new CoordinatorClient('http://x/api/v1', fetcher);
    const t = await api.tokens('00'.repeat(32));
    expect(t.states).toHaveLength(1);
    expect(t.unread).toEqual([{ utxo: { transactionId: 'bb', index: 0, amount: 150_000_000 }, state: { amount: '1' } }]);
    expect((await api.positions('00'.repeat(32))).unread).toEqual([]);
  });
});
