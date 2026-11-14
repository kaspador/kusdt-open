// Round 12 (2026-11-11, on rc.17), R12-COV-1, R12-ST-1 and R12-WW-3: the check of rc.17 asked, for every input with a
// relative lock, when the output it spends was accepted, and the reads behind it answered by listing every coin at the
// address that input's own signature script names. The judged transaction is an outsider's: it chose the address, how
// many coins sit there and how many of its inputs ask. A few hundred locked inputs were a few hundred whole-address
// reads, each time the transaction was looked at.
//
// Now the check asks about an output's acceptance only what its caller already knows, a bounded number of times, and
// the reads through a node list no address at all.

import { describe, expect, it } from 'vitest';
import { MINABLE_KEPT_MS, MINABLE_MAX_AGE_ASKS, UNMINABLE_KEPT_MS, VerdictMemory, minability, nodeMinableReads, type MinableReads, type Minability } from './minable';

const id = (n: number) => n.toString(16).padStart(64, '0');
// A signature script that is one push of a 40-byte redeem script: rc.17 took the address to list from it.
const namesAnAddress = '28' + Array.from({ length: 40 }, (_, i) => i.toString(16).padStart(2, '0')).join('');
const input = (parent: number, sequence: unknown = 0, index = 0) => ({ previousOutpoint: { transactionId: id(parent), index }, sequence, signatureScript: namesAnAddress });
const tx = (...inputs: any[]) => ({ inputs });
const no = (v: Minability) => { if (v.minable) throw new Error('expected a transaction no block can take'); return v; };

function counting(accepted: Record<string, bigint> = {}, mempool: Record<number, any> = {}) {
  const asked = { mempool: [] as string[], accepted: [] as string[] };
  const byId = new Map(Object.entries(mempool).map(([n, body]) => [id(Number(n)), body]));
  const reads: MinableReads = {
    virtualDaa: async () => 1_000_000n,
    mempoolTransaction: async (txid) => { asked.mempool.push(txid); return byId.get(txid) ?? null; },
    acceptedDaa: async (o) => { asked.accepted.push(`${Number.parseInt(o.transactionId, 16)}:${o.index}`); return accepted[`${Number.parseInt(o.transactionId, 16)}:${o.index}`] ?? null; },
  };
  return { reads, asked };
}

describe('R12-COV-1 / R12-ST-1: what one check costs is bounded, whatever the judged transaction holds', () => {
  it('a spender with hundreds of inputs that each claim an age is refused without one read', async () => {
    // The pool coin (7), then 400 coins of the attacker's address, each at sequence 1, from 60 confirmed transactions.
    const filler = Array.from({ length: 400 }, (_, i) => input(1_000 + (i % 60), 1, Math.floor(i / 60)));
    const n = counting({ '7:0': 999_000n });
    const v = no(await minability(id(1), tx(input(7, 600), ...filler), n.reads));
    expect(v.why).toMatch(/claims an age for 401 of the outputs it spends/);
    expect(n.asked.accepted).toEqual([]);
    expect(n.asked.mempool).toEqual([]);
  });

  it('the inputs that claim an age are judged first: the parked shape costs one lookup, wherever its locked input stands', async () => {
    // 60 plain inputs from 60 parents, then the coin locked on an unconfirmed parent (COV-1's shape, put last).
    const plain = Array.from({ length: 60 }, (_, i) => input(2_000 + i));
    const n = counting({}, { 0xf0: tx(input(0xf1)) });
    const v = no(await minability(id(1), tx(...plain, input(0xf0, 100_000_000)), n.reads));
    expect(v.why).toMatch(/input 60 claims an age of 100000000 DAA .* still in the mempool/);
    expect(n.asked.mempool).toEqual([id(0xf0)]);
    expect(n.asked.accepted).toEqual([]);
  });

  it('an age claimed for an output the caller does not know is not looked up anywhere: not minable', async () => {
    const n = counting({ '7:0': 999_000n });
    const v = no(await minability(id(1), tx(input(7, 600), input(50, 1)), n.reads));
    expect(v.why).toMatch(/input 1 claims an age of 1 DAA .* can't say when that output was accepted/);
    // Each was asked about once, by its outpoint and nothing else.
    expect(n.asked.accepted).toEqual(['7:0', '50:0']);
  });

  it('the acceptance asked about is counted over the whole check, unconfirmed ancestors included', async () => {
    // Each ancestor claims an age for confirmed outputs the caller knows: honest ones never do, and the count is bounded.
    const accepted: Record<string, bigint> = {};
    const mempool: Record<number, any> = {};
    for (let a = 0; a < 6; a++) {
      accepted[`${500 + a}:0`] = 1n;
      mempool[100 + a] = tx(input(500 + a, 5), ...(a < 5 ? [input(101 + a)] : []));
    }
    const n = counting(accepted, mempool);
    const v = no(await minability(id(1), tx(input(100)), n.reads));
    expect(v.why).toMatch(new RegExp(`more than ${MINABLE_MAX_AGE_ASKS} outputs`));
    expect(n.asked.accepted.length).toBe(MINABLE_MAX_AGE_ASKS);
  });

  it('an honest spend is judged as before: the followed coin\'s age from what the caller knows, and nothing else asked', async () => {
    const n = counting({ '7:0': 999_000n });
    expect(await minability(id(1), tx(input(7, 600), input(30), input(31)), n.reads)).toEqual({ minable: true });
    expect(n.asked.accepted).toEqual(['7:0']);
    expect(no(await minability(id(2), tx(input(7, 5_000), input(30)), n.reads)).why).toMatch(/no block takes it before DAA/);
  });
});

describe('R12-WW-3: a client keeps its verdicts between looks', () => {
  it('a transaction found parked is not judged again while it keeps being looked at; one found minable is asked again after a few seconds', async () => {
    let now = 1_000_000;
    const memory = new VerdictMemory(8, () => now);
    const n = counting({}, { 0xf0: tx(input(0xf1)) });
    const parked = tx(input(7), input(0xf0, 50));
    expect((await memory.judge(id(1), parked, n.reads)).minable).toBe(false);
    const asked = n.asked.mempool.length;
    for (let look = 0; look < 50; look++) { now += 8_000; expect((await memory.judge(id(1), parked, n.reads)).minable).toBe(false); }
    expect(n.asked.mempool.length).toBe(asked);
    // Not looked at for ten minutes: it left the mempool, and is forgotten.
    now += UNMINABLE_KEPT_MS + 1;
    expect(memory.get(id(1))).toBeUndefined();

    const honest = tx(input(7), input(30));
    expect((await memory.judge(id(2), honest, n.reads)).minable).toBe(true);
    const before = n.asked.mempool.length;
    now += MINABLE_KEPT_MS - 1;
    await memory.judge(id(2), honest, n.reads);
    expect(n.asked.mempool.length).toBe(before);
    now += 2;
    await memory.judge(id(2), honest, n.reads);
    expect(n.asked.mempool.length).toBeGreaterThan(before);
  });

  it('a "no" that only says the caller did not know an output is marked so, and is not kept: a look that knows the output passes it, at once', async () => {
    const memory = new VerdictMemory(8);
    const sale = tx(input(7, 600), input(30));
    // The pool coin's acceptance is not among what this look found (a look at the wallet's own tokens).
    const blind = counting();
    const v = no(await memory.judge(id(1), sale, blind.reads));
    expect(v.unknown).toBe(true);
    // Nothing was asked beyond the one input that claims an age: its other inputs are not looked up for a verdict that is not kept.
    expect(blind.asked.mempool).toEqual([id(7)]);
    // The look at the pool, a moment later, knows the coin.
    expect((await memory.judge(id(1), sale, counting({ '7:0': 999_000n }).reads)).minable).toBe(true);
    // An age that cannot be vouched for does not hide one that is shown to fail: that verdict is the one given, and kept.
    const parked = tx(input(8, 1), input(7, 600), input(0xf0, 50));
    const n = counting({ '7:0': 999_000n }, { 0xf0: tx(input(0xf1)) });
    const shown = no(await memory.judge(id(4), parked, n.reads));
    expect(shown.unknown).toBeUndefined();
    expect(shown.why).toMatch(/input 2 claims an age of 50 DAA .* still in the mempool/);
    expect(memory.get(id(4))).toEqual(shown);
    // A proven "no" carries no such mark, and neither does one inherited from a parked ancestor.
    expect(no(await minability(id(2), tx(input(7, 5_000)), counting({ '7:0': 999_000n }).reads)).unknown).toBeUndefined();
    const chained = counting({}, { 10: tx(input(8, 9)) });
    expect(no(await minability(id(3), tx(input(10)), chained.reads)).unknown).toBe(true);
  });

  it('holds a bounded number of verdicts, and none of a check that threw', async () => {
    const memory = new VerdictMemory(4);
    for (let i = 0; i < 20; i++) memory.set(id(i), { minable: false, txid: id(i), why: 'parked' });
    expect([...Array(20).keys()].filter((i) => memory.get(id(i))).length).toBe(4);
    const down: MinableReads = { virtualDaa: async () => 1n, mempoolTransaction: async () => { throw new Error('the Kaspa node closed the connection'); }, acceptedDaa: async () => null };
    await expect(memory.judge(id(99), tx(input(7)), down)).rejects.toThrow(/closed the connection/);
    expect(memory.get(id(99))).toBeUndefined();
  });
});

describe('R12-WW-3: the reads through a node never list an address', () => {
  it('the acceptance of an output is what the caller knows, or unknown: no getUtxosByAddresses, whatever the input names', async () => {
    const calls: string[] = [];
    const call = (async (method: string) => { calls.push(method); if (method === 'getBlockDagInfo') return { virtualDaaScore: '1000000' }; throw new Error(`${method} must not be asked`); }) as any;
    const reads = nodeMinableReads(call, (o) => (o.transactionId === id(7) ? 999_000n : undefined));
    expect(await reads.acceptedDaa({ transactionId: id(7), index: 0 })).toBe(999_000n);
    expect(await reads.acceptedDaa({ transactionId: id(8), index: 0 })).toBeNull();
    // The whole check of a spender whose first input names the attacker's address and claims an age of 1 DAA.
    const v = no(await minability(id(1), tx(input(8, 1), input(7, 600)), { ...reads, mempoolTransaction: async () => null }));
    expect(v.why).toMatch(/input 0 claims an age of 1 DAA/);
    // The pool coin's own claim was still checked, against the DAA score: that is the one call, and no address is listed.
    expect(calls).toEqual(['getBlockDagInfo']);
  });
});
