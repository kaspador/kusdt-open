// The deep round of the second outside review of rc.22, D4-1 (the wallet's part). The wallet's own record of its
// kUSDT states (kusdt/known.ts) let an input its own transaction spent go as soon as that transaction was seen
// accepted, at any depth: an output of it in the UTXO set, or the pool outcome "confirmed". A reorg that then drops
// the transaction for good puts the input back on the chain, unspent, and neither the wallet's record nor (on rc.23)
// the coordinator's index had it any more: the kUSDT was out of the wallet's balance. Now a spent input stays in the
// record, marked, until the node shows it spent: it leaves after three looks a minute apart that do not find it, as
// any other entry. One the node shows unspent an hour after it was marked was never spent: the mark goes and it is
// the user's again. One the node cannot show at all (its address too full to list) still goes after the hour, and is
// never offered as "not checked" while marked.
// Run (in wallet/extension): npx vitest run test/run20deep-known-reorg.test.ts
import { afterEach, describe, expect, it, vi } from 'vitest';
import { devKey } from './helpers';
import { USDT, holder } from './flooded';
import { MISS_SPACING_MS, SPENT_KEEP_MS, knownRecord, knownStates } from '@/kusdt/known';
import { executeSend, loadTokens, planSend } from '@/kusdt/tokens';
import { p2shAddressOf } from '@/kusdt/verify';
import { COVENANT } from './helpers';

const BOB = { ownerScheme: 0, owner: devKey('d41-bob').xonly };
afterEach(() => { vi.restoreAllMocks(); });
const at = (ms: number) => vi.spyOn(Date, 'now').mockReturnValue(ms);

/** A holder of 1,000 and 250 kUSDT who sends 300 of the 1,000 to Bob; the node takes the send. */
async function sent(tag: string) {
  const h = holder(tag, [1_000n * USDT, 250n * USDT]);
  await loadTokens(h.ctx, h.signer);
  const plan = await planSend(h.ctx, h.signer, h.kas, { to: BOB, amount: 300n * USDT });
  const { built } = await executeSend(h.ctx, h.signer, h.kas, plan);
  const change = built.outputs.find(o => (o.token as any)?.owner === h.alice.xonly)!;
  const input = h.node.utxoSet.find(u => u.transactionId === h.states[0].txid)!;
  const changeCoin = { address: p2shAddressOf(change.scriptPublicKey, 'kaspasim'), transactionId: built.txid, index: change.index, amount: change.value, scriptPublicKey: change.scriptPublicKey, blockDaaScore: 77n, isCoinbase: false, covenantId: COVENANT };
  /** A block accepts the send: the input is spent, the change is in the UTXO set. */
  const accept = () => { h.node.utxoSet = h.node.utxoSet.filter(u => u !== input); h.node.utxoSet.push(changeCoin); };
  /** A reorg drops the send for good: the input is back, unspent, and the change is gone. */
  const dropped = () => { h.node.utxoSet = h.node.utxoSet.filter(u => u !== changeCoin); h.node.utxoSet.push(input); };
  return { h, built, accept, dropped, spentId: h.states[0].outpoint };
}

describe('D4-1: the wallet keeps what its own transaction spent until the node shows it spent', () => {
  it('a send a reorg drops for good after it was seen accepted: the 1,000 is back in the balance (lost on rc.23)', async () => {
    const s = await sent('d41a');
    const t0 = Date.now();
    s.accept();
    // Seen accepted, and the coordinator cannot answer for the owner (or, as rc.23's index, no longer lists the 1,000).
    s.h.ctx.api!.tokens = async () => { throw new Error('no answer'); };
    at(t0 + 5_000);
    expect((await loadTokens(s.h.ctx, s.h.signer)).total).toBe(950n * USDT);
    // Still in the record, marked: not shown, not offered.
    expect((await knownRecord('simnet', s.h.alice.xonly)).find(k => `${k.txid}:${k.index}` === s.spentId)).toMatchObject({ spentBy: s.built.txid });
    expect((await knownStates('simnet', s.h.alice.xonly)).map(k => `${k.txid}:${k.index}`)).not.toContain(s.spentId);
    // Twenty seconds later the chain drops the send for good.
    s.dropped();
    at(t0 + 25_000);
    await loadTokens(s.h.ctx, s.h.signer);
    // Past the ten minutes its inputs are kept from selection: the 1,000 is in the balance again, the change is not.
    at(t0 + 11 * 60_000);
    expect((await loadTokens(s.h.ctx, s.h.signer)).total).toBe(1_250n * USDT);
    // An hour after it was marked, seen unspent: the mark goes, and it can be spent again.
    at(t0 + SPENT_KEEP_MS + 60_000);
    await loadTokens(s.h.ctx, s.h.signer);
    expect((await knownStates('simnet', s.h.alice.xonly)).map(k => `${k.txid}:${k.index}`)).toContain(s.spentId);
    expect((await knownRecord('simnet', s.h.alice.xonly)).find(k => `${k.txid}:${k.index}` === s.spentId)?.spentBy).toBeUndefined();
  });

  it('honest: a send that stays accepted: the 1,000 leaves the record after three looks a minute apart that do not find it, never shown meanwhile', async () => {
    const s = await sent('d41b');
    const t0 = Date.now();
    s.accept();
    s.h.ctx.api!.tokens = async () => { throw new Error('no answer'); };
    for (let look = 0; look < 2; look++) {
      at(t0 + 1_000 + look * MISS_SPACING_MS);
      expect((await loadTokens(s.h.ctx, s.h.signer)).total).toBe(950n * USDT);
      expect((await knownRecord('simnet', s.h.alice.xonly)).map(k => `${k.txid}:${k.index}`)).toContain(s.spentId);
    }
    at(t0 + 1_000 + 2 * MISS_SPACING_MS);
    expect((await loadTokens(s.h.ctx, s.h.signer)).total).toBe(950n * USDT);
    expect((await knownRecord('simnet', s.h.alice.xonly)).map(k => `${k.txid}:${k.index}`)).not.toContain(s.spentId);
  });

  it('honest: the coordinator listing the spent input a while longer changes nothing (not shown, it leaves the same way)', async () => {
    const s = await sent('d41c');
    const t0 = Date.now();
    s.accept();
    for (let look = 0; look < 3; look++) {
      at(t0 + 1_000 + look * MISS_SPACING_MS);
      expect((await loadTokens(s.h.ctx, s.h.signer)).total).toBe(950n * USDT);
    }
    expect((await knownRecord('simnet', s.h.alice.xonly)).map(k => `${k.txid}:${k.index}`)).not.toContain(s.spentId);
  });
});
