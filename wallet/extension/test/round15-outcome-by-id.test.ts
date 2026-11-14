// Round 15, R15-CL-4 (the client side of R14-ST-1): the wallet learned whether a
// pool transaction was still waiting by listing the mempool at the addresses its
// outputs pay, the wallet's own among them. Anyone can fill that answer with
// transactions no block takes; past the node's limit the read failed, every look
// was "unknown", and a transaction that lost the race for the pool was never
// seen lost: it was not tried again, and what it held stayed out of use for 10
// minutes. Now the mempool is asked for that one transaction by its id, and a
// failed mempool read alone no longer stops a look: the raced coin spent at a
// later DAA, on two looks in a row, decides as before.

import { describe, expect, it } from 'vitest';
import { FakeNode, devKey, POOL } from './helpers';
import { awaitOutcome, lookAt, type Raced } from '@/kusdt/submit';
import { settleUnconfirmed, noteUnconfirmed } from '@/kusdt/unconfirmed';
import { local } from '@/lib/storage';
import type { Built } from '@/kusdt/types';

const alice = devKey('r15-alice');
const spk = `000020${alice.xonly}ac`;
let n = 0;
const uniq = (c: string) => (++n).toString(16).padStart(64, c);
const built = (txid: string) => ({ txid, outputs: [{ index: 0, kind: 'change', value: 1n, scriptPublicKey: spk }], transaction: '{"inputs":[]}' }) as unknown as Built;

/** A node whose mempool answer for the wallet's address is past its limit, with a clock that moves; the pool coin it raced for is spent. */
function flooded() {
  const node = new FakeNode();
  let daa = 1_000n;
  node.virtualDaa = async () => (daa += 10n);
  const byAddress: string[][] = [];
  node.mempoolOutputs = async (addresses) => { byAddress.push(addresses); throw new Error('message too large: the answer is over the 64 MB limit'); };
  const byId: string[] = [];
  node.inMempool = async (txid) => { byId.push(txid); return node.mempool.some(o => o.transactionId === txid); };
  const raced: Raced = { outpoint: `${uniq('9')}:0`, address: 'kaspasim:pool', seen: true, daa: '5' };
  return { node, raced, byAddress, byId, ctx: { node, net: { prefix: 'kaspasim' }, network: 'simnet' } as any };
}

describe('a pool transaction\'s outcome at an address anyone has filled', () => {
  it('is still seen lost: the mempool is asked by id, not by address', async () => {
    const f = flooded();
    const txid = uniq('c');
    expect(await awaitOutcome(f.ctx, built(txid), { ...f.raced }, { ms: 50, everyMs: 1 })).toBe('lost');
    expect(f.byAddress).toHaveLength(0);
    expect(f.byId.every(t => t === txid)).toBe(true);
  });

  it('a transaction still in the mempool is never lost, however full its addresses are', async () => {
    const f = flooded();
    const txid = uniq('c');
    f.node.mempool.push({ address: alice.address, transactionId: txid, index: 0, amount: 1n, scriptPublicKey: spk, covenantId: null });
    expect(await awaitOutcome(f.ctx, built(txid), { ...f.raced }, { ms: 30, everyMs: 1 })).toBe('unknown');
  });

  it('a failed read by id says nothing by itself: two looks with the coin spent at a later DAA still decide, one does not', async () => {
    const f = flooded();
    f.node.inMempool = async () => { throw new Error('connection lost'); };
    const txid = uniq('c');
    const raced = { ...f.raced };
    expect(await lookAt(f.ctx, txid, [alice.address], raced)).toBe('gone');
    expect(await awaitOutcome(f.ctx, built(txid), { ...f.raced }, { ms: 0, everyMs: 0 })).toBe('unknown');
    expect(await awaitOutcome(f.ctx, built(txid), { ...f.raced }, { ms: 50, everyMs: 1 })).toBe('lost');
    // The pool coin still there: nobody has won it, whatever the mempool read did.
    const there = flooded();
    there.node.inMempool = async () => { throw new Error('connection lost'); };
    there.node.utxoSet.push({ address: there.raced.address, transactionId: there.raced.outpoint.slice(0, 64), index: 0, amount: 1n, scriptPublicKey: '00', blockDaaScore: 5n, isCoinbase: false, covenantId: POOL });
    expect(await awaitOutcome(there.ctx, built(txid), { ...there.raced }, { ms: 30, everyMs: 1 })).toBe('unknown');
    // A failed UTXO read still says nothing.
    f.node.utxos = async () => { throw new Error('connection lost'); };
    expect(await awaitOutcome(f.ctx, built(txid), { ...f.raced }, { ms: 20, everyMs: 1 })).toBe('unknown');
  });

  it('and one left waiting is settled at a refresh', async () => {
    await local.remove('kusdt.unconfirmed.simnet');
    const f = flooded();
    const b = built(uniq('c'));
    await noteUnconfirmed(f.ctx, b, { ...f.raced });
    expect(await settleUnconfirmed(f.ctx)).toEqual({ confirmed: [], lost: [] });
    expect(await settleUnconfirmed(f.ctx)).toEqual({ confirmed: [], lost: [b.txid] });
  });
});
