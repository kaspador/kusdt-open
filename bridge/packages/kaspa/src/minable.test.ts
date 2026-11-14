// Whether a block can take a mempool transaction (round 11, COV-1). The node rule these tests stand on was read in
// rusty-kaspa v2.1.0 and not run on a node: an input that spends an output of another mempool transaction passes the
// node's relative-lock test whatever its sequence says, and a block applies the real rule.

import { describe, expect, it } from 'vitest';
import {
  MINABLE_MAX_DEPTH, SEQUENCE_LOCK_DISABLED, feerateCeiling, isNodeRefusal, mempoolSpendersOf, minability, nodeMinableReads,
  receivingIn, relativeLock, sendingIn, spendsOutpoint, type MinableReads, type Minability,
} from './minable';
import { RpcError, RpcTooLargeError } from './rpc';

const id = (n: number) => n.toString(16).padStart(64, '0');
const input = (parent: number, sequence: unknown = 0, index = 0, signatureScript = '') => ({ previousOutpoint: { transactionId: id(parent), index }, sequence, signatureScript });
const tx = (...inputs: any[]) => ({ inputs });

/** A node as the check reads it: `mempool` by txid, `accepted` DAA by "txid:index", the virtual DAA. Counts what was asked. */
function node(opts: { mempool?: Record<number, any>; accepted?: Record<string, bigint>; virtual?: bigint } = {}) {
  const asked = { mempool: [] as string[], accepted: [] as string[], virtual: 0 };
  const byId = new Map(Object.entries(opts.mempool ?? {}).map(([n, body]) => [id(Number(n)), body]));
  const reads: MinableReads = {
    virtualDaa: async () => { asked.virtual++; return opts.virtual ?? 1_000_000n; },
    mempoolTransaction: async (txid) => { asked.mempool.push(txid); return byId.get(txid) ?? null; },
    acceptedDaa: async (o) => { asked.accepted.push(`${o.transactionId}:${o.index}`); return opts.accepted?.[`${Number.parseInt(o.transactionId, 16)}:${o.index}`] ?? null; },
  };
  return { reads, asked };
}

const no = (v: Minability) => { if (v.minable) throw new Error('expected a transaction no block can take'); return v; };

describe('the relative lock a sequence asks', () => {
  it('is its low 32 bits, and nothing with the disable bit set', () => {
    expect(relativeLock(0)).toBe(0n);
    expect(relativeLock(50)).toBe(50n);
    expect(relativeLock('100000000')).toBe(100_000_000n);
    expect(relativeLock(0xffff_ffffn)).toBe(0xffff_ffffn);
    // Above the mask only the low 32 bits count (rusty-kaspa SEQUENCE_LOCK_TIME_MASK).
    expect(relativeLock((1n << 40n) + 7n)).toBe(7n);
    expect(relativeLock(SEQUENCE_LOCK_DISABLED + 72_000n)).toBe(0n);
    // A sequence with bit 63 set is over 2^53: the exact JSON reader hands it over as a string.
    expect(relativeLock((SEQUENCE_LOCK_DISABLED + 72_000n).toString())).toBe(0n);
    expect(relativeLock('18446744073709551615')).toBe(0n);
  });

  it('is unknown for anything that is not a 64-bit number: nothing is assumed', () => {
    for (const bad of [undefined, null, '', '-1', '1.5', 1.5, -1, '18446744073709551616', {}, '0x10', Number.MAX_SAFE_INTEGER + 2]) expect(relativeLock(bad)).toBeNull();
  });
});

describe('a mempool spender a block can take', () => {
  it('claims no age: sequence 0 on confirmed coins', async () => {
    const n = node();
    expect(await minability(id(1), tx(input(10), input(11)), n.reads)).toEqual({ minable: true });
    // No age to check: the node is asked for no acceptance and no DAA score.
    expect(n.asked.accepted).toEqual([]);
    expect(n.asked.virtual).toBe(0);
  });

  it('has the disable bit set on an unconfirmed coin: that asks no lock at all', async () => {
    const n = node({ mempool: { 10: tx(input(20)) } });
    expect(await minability(id(1), tx(input(10, (SEQUENCE_LOCK_DISABLED + 5_000n).toString())), n.reads)).toEqual({ minable: true });
  });

  it('claims a real age for a confirmed coin: accepted at d, d + lock - 1 below the virtual DAA (the keeper\'s tick, a wallet\'s sale)', async () => {
    const n = node({ accepted: { '10:0': 999_000n }, virtual: 1_000_000n });
    expect(await minability(id(1), tx(input(10, 990), input(11)), n.reads)).toEqual({ minable: true });
    // The node's own boundary (check_sequence_lock): d + lock - 1 >= the DAA it is judged at fails.
    expect((await minability(id(2), tx(input(10, 1_000)), n.reads)).minable).toBe(true);
    expect((await minability(id(3), tx(input(10, 1_001)), n.reads)).minable).toBe(false);
  });

  it('is chained on an unconfirmed spend and claims no age for it, as honest wallets do', async () => {
    // 1 spends an output of 10 (in the mempool, itself on confirmed coins) at sequence 0.
    const n = node({ mempool: { 10: tx(input(20), input(21)) } });
    expect(await minability(id(1), tx(input(10), input(30)), n.reads)).toEqual({ minable: true });
  });
});

describe('a mempool spender no block can take (COV-1)', () => {
  it('pays with a coin locked for 100 000 000 DAA whose parent is still in the mempool: the parked dust buy', async () => {
    // F0 (11) is a plain self-send still in the mempool; J spends the pool coin (10, confirmed) and F0's output at sequence 100 000 000.
    const n = node({ mempool: { 11: tx(input(40)) } });
    const v = no(await minability(id(1), tx(input(10), input(11, 100_000_000)), n.reads));
    expect(v.txid).toBe(id(1));
    expect(v.why).toMatch(/input 1 claims an age of 100000000 DAA .* still in the mempool: an unconfirmed output has no age/);
  });

  it('is the same transaction after its parent was mined: the lock is real now, and 115 days long', async () => {
    const n = node({ accepted: { '11:0': 999_990n }, virtual: 1_000_000n });
    // The funding coin is a plain key's: the reads cannot say when it was accepted unless the caller knows.
    const v = no(await minability(id(1), tx(input(10), input(11, 100_000_000)), n.reads));
    expect(v.why).toMatch(/no block takes it before DAA 100999990 \(now 1000000\)/);
  });

  it('is a tick claiming 72 000 DAA on a pool coin that is itself unconfirmed', async () => {
    const n = node({ mempool: { 10: tx(input(20)) } });
    expect(no(await minability(id(1), tx(input(10, 72_000), input(30)), n.reads)).why).toMatch(/claims an age of 72000 DAA/);
  });

  it('is execute_recovery (sequence 2 592 000) behind an unconfirmed minter spend', async () => {
    const n = node({ mempool: { 10: tx(input(20, 600)) }, accepted: { '20:0': 1n } });
    expect(no(await minability(id(1), tx(input(10, 2_592_000), input(31)), n.reads)).txid).toBe(id(1));
  });

  it('claims a lock of 1 on an unconfirmed coin: no age at all is proven there', async () => {
    const n = node({ mempool: { 10: tx(input(20)) } });
    expect((await minability(id(1), tx(input(10, 1)), n.reads)).minable).toBe(false);
  });

  it('claims no age itself but is built on one that no block can take: the fault is named where it is', async () => {
    // 1 (sequence 0) on 10 (sequence 0) on 11, which locks an unconfirmed coin of 12.
    const n = node({ mempool: { 10: tx(input(11)), 11: tx(input(12, 500)), 12: tx(input(50)) } });
    const v = no(await minability(id(1), tx(input(10)), n.reads));
    expect(v.txid).toBe(id(11));
    expect(v.why).toMatch(/claims an age of 500 DAA/);
  });

  it('claims an age for a coin the node cannot say the acceptance of', async () => {
    const n = node();
    expect(no(await minability(id(1), tx(input(10, 50)), n.reads)).why).toMatch(/the node can't say when that output was accepted/);
  });

  it('cannot be read: no inputs, a sequence that is no number, an outpoint that is none', async () => {
    const n = node();
    expect((await minability(id(1), {}, n.reads)).minable).toBe(false);
    expect((await minability(id(2), tx(), n.reads)).minable).toBe(false);
    expect((await minability(id(3), tx(input(10, 'soon')), n.reads)).minable).toBe(false);
    expect((await minability(id(4), tx({ previousOutpoint: { transactionId: 'zz', index: 0 }, sequence: 0 }), n.reads)).minable).toBe(false);
    expect((await minability(id(5), tx({ sequence: 0 }), n.reads)).minable).toBe(false);
  });
});

describe('the bounds of one check', () => {
  it('a chain of unconfirmed ancestors deeper than the bound is not followed, and counts as not minable', async () => {
    const mempool: Record<number, any> = {};
    for (let i = 10; i < 10 + MINABLE_MAX_DEPTH + 5; i++) mempool[i] = tx(input(i + 1));
    const n = node({ mempool });
    expect(no(await minability(id(1), tx(input(10)), n.reads)).why).toMatch(/levels of unconfirmed ancestors/);
    // A chain within the bound passes.
    const short: Record<number, any> = {};
    for (let i = 10; i < 10 + MINABLE_MAX_DEPTH - 2; i++) short[i] = tx(input(i + 1));
    expect((await minability(id(1), tx(input(10)), node({ mempool: short }).reads)).minable).toBe(true);
  });

  it('more parents than one check looks up is not minable, and the node is asked no more than the bound', async () => {
    const n = node();
    const many = tx(...Array.from({ length: 9 }, (_, i) => input(100 + i)));
    expect(no(await minability(id(1), many, n.reads, { maxLookups: 8 })).why).toMatch(/more than 8 inputs or unconfirmed ancestors/);
    expect(n.asked.mempool.length).toBe(8);
    expect((await minability(id(2), many, node().reads, { maxLookups: 9 })).minable).toBe(true);
  });

  it('a parent spent by several inputs is asked for once', async () => {
    const n = node({ mempool: { 10: tx(input(20)) } });
    expect((await minability(id(1), tx(input(10, 0, 0), input(10, 0, 1), input(10, 0, 2)), n.reads)).minable).toBe(true);
    expect(n.asked.mempool).toEqual([id(10), id(20)]);
  });

  it('a node that showed a cycle is not believed', async () => {
    const n = node({ mempool: { 10: tx(input(11)), 11: tx(input(10)) } });
    expect(no(await minability(id(1), tx(input(10)), n.reads)).why).toMatch(/cycle/);
  });
});

describe('what a check keeps and what it does not say', () => {
  it('a caller that walks a chain hop by hop shares the verdicts: each ancestor is judged once', async () => {
    const hop1 = tx(input(10, 60), input(30));
    const hop2 = tx(input(1), input(31));
    const n = node({ mempool: { 1: hop1 }, accepted: { '10:0': 1n } });
    const known = new Map<string, Minability>();
    expect((await minability(id(1), hop1, n.reads, { known })).minable).toBe(true);
    const before = n.asked.mempool.length;
    expect((await minability(id(2), hop2, n.reads, { known })).minable).toBe(true);
    // Hop 2 asked for its two parents, and judged hop 1 from what was kept: none of hop 1's own parents again.
    expect(n.asked.mempool.slice(before)).toEqual([id(1), id(31)]);
    expect(known.get(id(2))).toEqual({ minable: true });
  });

  it('a verdict kept as "no" is answered without asking the node again', async () => {
    const n = node();
    const known = new Map<string, Minability>([[id(1), { minable: false, txid: id(1), why: 'seen parked before' }]]);
    expect(await minability(id(1), tx(input(10)), n.reads, { known })).toEqual({ minable: false, txid: id(1), why: 'seen parked before' });
    expect(n.asked.mempool).toEqual([]);
  });

  it('a node that cannot be asked gives no verdict: the check throws, and keeps nothing', async () => {
    const known = new Map<string, Minability>();
    const down: MinableReads = { virtualDaa: async () => 1n, mempoolTransaction: async () => { throw new Error('the Kaspa node closed the connection'); }, acceptedDaa: async () => null };
    await expect(minability(id(1), tx(input(10)), down, { known })).rejects.toThrow(/closed the connection/);
    expect(known.size).toBe(0);
    const noDaa: MinableReads = { virtualDaa: async () => { throw new Error('getBlockDagInfo: timed out'); }, mempoolTransaction: async () => null, acceptedDaa: async () => 5n };
    await expect(minability(id(1), tx(input(10, 3)), noDaa, { known })).rejects.toThrow(/timed out/);
    expect(known.size).toBe(0);
  });
});

// Round 12: the tests of p2shAddressOfInput ("the address a spending input names") went with the function. Its one use
// was to find the address to list for an input of the judged transaction, and that read was the finding (R12-COV-1).

describe('the reads through a node', () => {
  it('a transaction the node says it does not hold is not in the mempool; any other failure is no answer', async () => {
    const calls: any[] = [];
    const reads = nodeMinableReads((async (method: string, params: any) => {
      calls.push({ method, params });
      if (params.transactionId === id(1)) return { mempoolEntry: { fee: 5, transaction: { inputs: [], verboseData: { transactionId: id(1) } } } };
      if (params.transactionId === id(2)) throw new RpcError('getMempoolEntry', `Transaction ${id(2)} not found`);
      if (params.transactionId === id(3)) throw new RpcError('getMempoolEntry', 'timed out');
      if (params.transactionId === id(4)) throw new Error('the Kaspa node closed the connection');
      if (params.transactionId === id(5)) throw new RpcError('getMempoolEntry', 'method not available');
      throw new RpcTooLargeError('getMempoolEntry', 9, 1);
    }) as any);
    expect(await reads.mempoolTransaction(id(1))).toEqual({ inputs: [], verboseData: { transactionId: id(1) } });
    expect(await reads.mempoolTransaction(id(2))).toBeNull();
    await expect(reads.mempoolTransaction(id(3))).rejects.toThrow(/timed out/);
    await expect(reads.mempoolTransaction(id(4))).rejects.toThrow(/closed/);
    // A refusal in other words is not "it is not there": an unconfirmed parent must never pass as confirmed.
    await expect(reads.mempoolTransaction(id(5))).rejects.toThrow(/not available/);
    await expect(reads.mempoolTransaction(id(6))).rejects.toThrow(RpcTooLargeError);
    expect(calls[0]).toEqual({ method: 'getMempoolEntry', params: { transactionId: id(1), includeOrphanPool: false, filterTransactionPool: false } });
  });

  // Until round 12 this read "what the caller knows first, else the UTXO at the address the input names". That read of
  // an address the judged transaction chose was the finding (R12-COV-1, R12-ST-1, R12-WW-3): the node is asked for no address now.
  it('the acceptance of an output: what the caller knows, and nothing else; the node is never asked for an address', async () => {
    const calls: any[] = [];
    const call = (async (method: string, params: any) => {
      calls.push({ method, params });
      if (method === 'getBlockDagInfo') return { virtualDaaScore: '123456789012345678' };
      return { entries: [{ outpoint: { transactionId: id(7), index: 0 }, utxoEntry: { blockDaaScore: '4242' } }, { outpoint: { transactionId: id(7), index: 1 }, utxoEntry: { blockDaaScore: 99 } }] };
    }) as any;
    const reads = nodeMinableReads(call, (o) => (o.transactionId === id(9) ? 777n : undefined));
    expect(await reads.virtualDaa()).toBe(123456789012345678n);
    expect(await reads.acceptedDaa({ transactionId: id(9), index: 0 })).toBe(777n);
    // An output the caller does not know: unknown, although the node's UTXO set holds it.
    expect(await reads.acceptedDaa({ transactionId: id(7), index: 1 })).toBeNull();
    expect(await reads.acceptedDaa({ transactionId: id(8), index: 0 })).toBeNull();
    expect(calls.filter((c) => c.method === 'getUtxosByAddresses')).toEqual([]);
  });

  it('whether an error is the node\'s own refusal', () => {
    expect(isNodeRefusal(new RpcError('submitTransaction', 'Rejected transaction: double spend'))).toBe(true);
    expect(isNodeRefusal(new RpcError('submitTransaction', 'timed out'))).toBe(false);
    expect(isNodeRefusal(new RpcTooLargeError('getUtxosByAddresses', 9, 1))).toBe(false);
    expect(isNodeRefusal(new Error('the Kaspa node closed the connection'))).toBe(false);
  });
});

describe('the mempool asked by address, never whole (R11-ST-2)', () => {
  const entry = (n: number, inputs: any[], fee: unknown = 1_000, computeMass: unknown = 2_000) => ({ fee, transaction: { inputs, verboseData: { transactionId: id(n), computeMass } }, isOrphan: false });
  const answer = {
    entries: [
      { address: 'kaspatest:a', sending: [entry(1, [input(10)]), entry(2, [input(11)])], receiving: [entry(3, [input(12)])] },
      { address: 'kaspatest:b', sending: [entry(1, [input(10)])], receiving: [] },
    ],
  };

  it('asks getMempoolEntriesByAddresses for one address and keeps the spenders of the outpoint', async () => {
    const calls: any[] = [];
    const found = await mempoolSpendersOf((async (method: string, params: any) => { calls.push({ method, params }); return answer; }) as any, 'kaspatest:a', { transactionId: id(10), index: '0' });
    expect(calls).toEqual([{ method: 'getMempoolEntriesByAddresses', params: { addresses: ['kaspatest:a'], includeOrphanPool: false, filterTransactionPool: false } }]);
    expect(found.map((s) => s.txid)).toEqual([id(1)]);
    expect(found[0].fee).toBe(1_000n);
  });

  it('reads the lists of an answer, each transaction once, and skips what is no transaction', () => {
    expect(sendingIn(answer).map((s) => s.txid)).toEqual([id(1), id(2)]);
    expect(receivingIn(answer).map((s) => s.txid)).toEqual([id(3)]);
    expect(sendingIn(null)).toEqual([]);
    expect(sendingIn({ entries: [{ sending: [{}, { transaction: { verboseData: { transactionId: 'nope' }, inputs: [] } }, { transaction: { verboseData: { transactionId: id(4) } } }] }] })).toEqual([]);
    expect(spendsOutpoint(tx(input(10, 0, 2)), { transactionId: id(10), index: 2 })).toBe(true);
    expect(spendsOutpoint(tx(input(10, 0, 2)), { transactionId: id(10), index: 0 })).toBe(false);
    expect(spendsOutpoint({}, { transactionId: id(10), index: 0 })).toBe(false);
  });

  it('the most a mempool transaction pays per gram is its fee over its compute mass; unknown when the node does not say', () => {
    expect(feerateCeiling({ fee: 1_000_000n, tx: { verboseData: { computeMass: 2_000 } } })).toBe(500);
    expect(feerateCeiling({ fee: '123456789012345678', tx: { verboseData: { computeMass: '1000' } } })).toBeCloseTo(123456789012345.678, 0);
    expect(feerateCeiling({ fee: null, tx: { verboseData: { computeMass: 2_000 } } })).toBeNull();
    expect(feerateCeiling({ fee: 5n, tx: { verboseData: {} } })).toBeNull();
    expect(feerateCeiling({ fee: 5n, tx: { verboseData: { computeMass: 0 } } })).toBeNull();
    expect(feerateCeiling(null)).toBeNull();
  });
});
