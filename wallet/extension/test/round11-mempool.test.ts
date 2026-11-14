// Round 11 (2026-11-11, on rc.16), COV-1: the wallet and a pool spend no block can take.
//
// The wallet finds the pool on its node, in the UTXO set or among the outputs of transactions still in the mempool,
// and counts an output spent in the mempool as gone. A node admits a spend of an unconfirmed output without checking
// its relative lock, so a spend of the pool that no block will take can sit in ordinary nodes' mempools for a day: the
// wallet either built behind it (a transaction that never confirms) or took the pool for gone, and said nothing useful.
// The node behaviour was read in rusty-kaspa v2.1.0 and not run on a node.

import { afterEach, describe, expect, it } from 'vitest';
// @ts-ignore: ws ships no types, and the test needs only its server.
import { WebSocketServer } from 'ws';
import { FakeNode, COVENANT, POOL, devKey, fakeApi, testCtx, signerFor, kasCoin } from './helpers';
import { p2shAddressOf, scriptOf, reserveStateOf, poolValue, verifyPool } from '@/kusdt/verify';
import { POOL_WAIT, PoolHeld, quoteBuy, swap } from '@/kusdt/pool';
import { KaspaNodeClient, type MempoolJudged } from '@/kaspa/node';
import type { PoolState } from '@/kusdt/types';

const alice = devKey('alice');
POOL_WAIT.ms = 0;
POOL_WAIT.perDaaMs = 0;
const KAS = 100_000_000n;
const base: PoolState = { tokenCovid: COVENANT, kasReserve: 200n * KAS, tokenReserve: 20_000_000n, totalShares: 200n * KAS, protocolKas: 0n, protocolTokens: 0n, baseValue: KAS, admin: '11'.repeat(32), maxOutBps: 1_000n, windowLen: 36_000n, windowCredit: 0n, windowRef: 0n, windowOut: 0n, paused: false, guardian: '22'.repeat(32) };
const id = (n: number) => n.toString(16).padStart(64, '0');
const CONFIRMED = id(0xa1), PENDING = id(0xb2), PARKED = id(0xc3);

/** A fake node that also says which mempool transactions no block can take. */
class JudgingNode extends FakeNode {
  judged: MempoolJudged | Error = { heldBy: new Map(), unminable: new Map() };
  asked: { addresses: string[]; wanted: { txid: string; index: number }[]; accepted?: Map<string, bigint> }[] = [];
  async mempoolJudged(addresses: string[], wanted: { txid: string; index: number }[], accepted?: Map<string, bigint>) {
    this.asked.push({ addresses, wanted, accepted });
    if (this.judged instanceof Error) throw this.judged;
    return this.judged;
  }
}

/** The pool at `txid` (pool at index 0, reserve at 1): in the UTXO set, or as outputs of a mempool transaction. */
function place(node: JudgingNode, ctx: ReturnType<typeof testCtx>, txid: string, pool: PoolState, where: 'utxo' | 'mempool') {
  const reserve = reserveStateOf(POOL, pool);
  const pspk = scriptOf(ctx, 'Pool', pool), rspk = scriptOf(ctx, 'KCC20', reserve);
  const p = { address: p2shAddressOf(pspk, 'kaspasim'), transactionId: txid, index: 0, amount: poolValue(pool), scriptPublicKey: pspk, covenantId: POOL };
  const r = { address: p2shAddressOf(rspk, 'kaspasim'), transactionId: txid, index: 1, amount: 150_000_000n, scriptPublicKey: rspk, covenantId: COVENANT };
  if (where === 'utxo') node.utxoSet.push({ ...p, blockDaaScore: 999_000n, isCoinbase: false }, { ...r, blockDaaScore: 999_000n, isCoinbase: false });
  else node.mempool.push(p, r);
  return { pool: { utxo: { transactionId: txid, index: 0 }, state: pool }, reserve: { utxo: { transactionId: txid, index: 1 }, state: reserve } };
}

const moved: PoolState = { ...base, kasReserve: base.kasReserve + KAS, tokenReserve: base.tokenReserve - 90_000n };

describe('COV-1: the wallet believes the mempool only as far as a block can take what it shows', () => {
  it('a pool spent in the mempool by an honest transaction is gone, as before', async () => {
    const node = new JudgingNode();
    const ctx = testCtx(node);
    const answer = place(node, ctx, CONFIRMED, base, 'utxo');
    node.spent.add(`${CONFIRMED}:0`);
    await expect(verifyPool(ctx, answer)).rejects.toThrow(/could not be found/);
  });

  it('a pool spent in the mempool by a transaction no block can take is still the pool, and is marked as held', async () => {
    const node = new JudgingNode();
    const ctx = testCtx(node);
    const answer = place(node, ctx, CONFIRMED, base, 'utxo');
    node.spent.add(`${CONFIRMED}:0`);
    node.spent.add(`${CONFIRMED}:1`);
    node.judged = { heldBy: new Map([[`${CONFIRMED}:0`, { txid: PARKED, why: 'a lock on an unconfirmed coin' }], [`${CONFIRMED}:1`, { txid: PARKED, why: 'a lock on an unconfirmed coin' }]]), unminable: new Map() };
    const vp = await verifyPool(ctx, answer);
    expect(vp.pool.utxo.heldBy).toBe(PARKED);
    expect(vp.pool.utxo.confirmed).toBe(true);
    expect(vp.pool.state.kasReserve).toBe(base.kasReserve);
    // Asked once, for the two outputs it wants, with the acceptance of what it found in the UTXO set.
    expect(node.asked).toHaveLength(1);
    expect(node.asked[0].wanted).toEqual([{ txid: CONFIRMED, index: 0 }, { txid: CONFIRMED, index: 1 }]);
    expect(node.asked[0].accepted?.get(`${CONFIRMED}:0`)).toBe(999_000n);
  });

  it('a trade on a held pool is not built: the wallet says what holds the pool and that nothing was sent', async () => {
    const node = new JudgingNode();
    const answer = { current: null as any };
    const ctx = testCtx(node, fakeApi({ pool: async () => answer.current }));
    answer.current = place(node, ctx, CONFIRMED, base, 'utxo');
    node.utxoSet.push(kasCoin(alice, id(0xd4), 50n * KAS));
    node.spent.add(`${CONFIRMED}:0`);
    node.judged = { heldBy: new Map([[`${CONFIRMED}:0`, { txid: PARKED, why: 'a lock on an unconfirmed coin' }]]), unminable: new Map() };
    const kasIn = 10n * KAS;
    const quoted = quoteBuy(ctx, base, kasIn);
    const failed = await swap(ctx, signerFor(alice), [alice.address], { side: 'buy', amountIn: kasIn, minOut: 1n, quoted }).catch(e => e);
    expect(failed).toBeInstanceOf(PoolHeld);
    expect(failed.txid).toBe(PARKED);
    expect(failed.message).toMatch(/no block can take/);
    expect(failed.message).toMatch(/Nothing was sent, and your funds are where they were/);
    expect(failed.message).toMatch(/set another Kaspa node in Settings/);
    expect(failed.message).not.toMatch(/—/);
    expect(node.submitted).toHaveLength(0);
  });

  it('a pool that is only an output of a mempool transaction is built on when a block can take that transaction, as before', async () => {
    const node = new JudgingNode();
    const ctx = testCtx(node);
    const answer = place(node, ctx, PENDING, moved, 'mempool');
    const vp = await verifyPool(ctx, answer);
    expect(vp.pool.utxo.confirmed).toBe(false);
    expect(vp.pool.utxo.heldBy).toBeUndefined();
  });

  it('and is not built on when no block can take it: the wallet does not chain behind a parked spend', async () => {
    const node = new JudgingNode();
    const ctx = testCtx(node);
    const answer = place(node, ctx, PENDING, moved, 'mempool');
    node.judged = { heldBy: new Map(), unminable: new Map([[PENDING, 'input 1 claims an age of 100000000 DAA']]) };
    await expect(verifyPool(ctx, answer)).rejects.toThrow(/could not be found/);
  });

  it('when the node cannot be asked, nothing the mempool shows is built on, and a spent output stays gone', async () => {
    const node = new JudgingNode();
    const ctx = testCtx(node);
    node.judged = new Error('the Kaspa node closed the connection');
    await expect(verifyPool(ctx, place(node, ctx, PENDING, moved, 'mempool'))).rejects.toThrow(/could not be found/);
    const other = new JudgingNode();
    const ctx2 = testCtx(other);
    other.judged = new Error('the Kaspa node closed the connection');
    const answer = place(other, ctx2, CONFIRMED, base, 'utxo');
    other.spent.add(`${CONFIRMED}:0`);
    await expect(verifyPool(ctx2, answer)).rejects.toThrow(/could not be found/);
  });

  it('a pool in the UTXO set that nothing spends asks the node nothing more', async () => {
    const node = new JudgingNode();
    const ctx = testCtx(node);
    const vp = await verifyPool(ctx, place(node, ctx, CONFIRMED, base, 'utxo'));
    expect(vp.pool.utxo.confirmed).toBe(true);
    expect(node.asked).toHaveLength(0);
  });
});

describe('COV-1: the wallet\'s node client judges the mempool transactions around the outputs it is asked about', () => {
  type ServerSocket = { send(s: string): void; terminate(): void; on(e: string, f: (d: unknown) => void): void };
  type Server = { once(e: string, f: () => void): void; on(e: string, f: (ws: ServerSocket) => void): void; close(f: () => void): void; address(): unknown };
  const servers: Server[] = [];
  const sockets: ServerSocket[] = [];
  afterEach(async () => {
    for (const c of sockets.splice(0)) c.terminate();
    for (const s of servers.splice(0)) await new Promise<void>((ok) => s.close(() => ok()));
  });

  const tx = (txid: number, inputs: { parent: number; index?: number; sequence?: unknown }[]) => ({
    fee: 1_000, isOrphan: false,
    transaction: { verboseData: { transactionId: id(txid), computeMass: 1_000 }, inputs: inputs.map(i => ({ previousOutpoint: { transactionId: id(i.parent), index: i.index ?? 0 }, sequence: i.sequence ?? 0, signatureScript: '' })), outputs: [] },
  });

  /** A testnet-10 node whose mempool lists `sending` and `receiving` for the address asked, and holds `others` besides. */
  async function nodeWith(sending: ReturnType<typeof tx>[], receiving: ReturnType<typeof tx>[], others: ReturnType<typeof tx>[] = []) {
    const wss: Server = new WebSocketServer({ port: 0, host: '127.0.0.1' });
    servers.push(wss);
    await new Promise<void>((ok) => wss.once('listening', () => ok()));
    const methods: string[] = [];
    const byId = new Map([...sending, ...receiving, ...others].map(e => [e.transaction.verboseData.transactionId, e]));
    wss.on('connection', (ws: ServerSocket) => {
      sockets.push(ws);
      ws.on('message', (data: unknown) => {
        const msg = JSON.parse(String(data));
        methods.push(msg.method);
        const answer = (params: unknown) => ws.send(JSON.stringify({ id: msg.id, method: msg.method, params }));
        if (msg.method === 'getServerInfo') return answer({ networkId: 'testnet-10', hasUtxoIndex: true, isSynced: true });
        if (msg.method === 'getMempoolEntriesByAddresses') return answer({ entries: [{ address: msg.params.addresses[0], sending, receiving }] });
        if (msg.method === 'getBlockDagInfo') return answer({ virtualDaaScore: '1000000' });
        if (msg.method === 'getMempoolEntry') {
          const e = byId.get(msg.params.transactionId);
          if (e) return answer({ mempoolEntry: e });
          return ws.send(JSON.stringify({ id: msg.id, method: msg.method, error: { message: `Transaction ${msg.params.transactionId} not found` } }));
        }
        ws.send(JSON.stringify({ id: msg.id, method: msg.method, error: { message: 'unexpected' } }));
      });
    });
    return { url: `ws://127.0.0.1:${(wss.address() as { port: number }).port}`, methods };
  }

  const ADDRESS = 'kaspatest:qzuv4u0sp5tee8e09kl3h9r2yq6rpxvahvudxx0smfuyv064fx5s69ydr0acz';

  it('a dust buy paid with a coin locked on an unconfirmed parent holds the pool; an honest spend does not', async () => {
    // 8 spends the pool (7:0) and a coin of f0 at sequence 100 000 000; f0 is a plain self-send still in the mempool.
    const n = await nodeWith([tx(8, [{ parent: 7 }, { parent: 0xf0, sequence: 100_000_000 }])], [], [tx(0xf0, [{ parent: 0xf1 }])]);
    const client = new KaspaNodeClient('testnet-10', n.url, 2_000);
    const judged = await client.mempoolJudged([ADDRESS], [{ txid: id(7), index: 0 }]);
    expect([...judged.heldBy.keys()]).toEqual([`${id(7)}:0`]);
    expect(judged.heldBy.get(`${id(7)}:0`)!.txid).toBe(id(8));
    expect(judged.heldBy.get(`${id(7)}:0`)!.why).toMatch(/unconfirmed output has no age/);
    // One read of the mempool, by address: never the whole of it.
    expect(n.methods.filter(m => m === 'getMempoolEntriesByAddresses')).toHaveLength(1);
    expect(n.methods).not.toContain('getMempoolEntries');
    client.close();

    const honest = await nodeWith([tx(8, [{ parent: 7 }, { parent: 0x20 }])], []);
    const c2 = new KaspaNodeClient('testnet-10', honest.url, 2_000);
    expect((await c2.mempoolJudged([ADDRESS], [{ txid: id(7), index: 0 }])).heldBy.size).toBe(0);
    c2.close();
  });

  it('a spend claiming the pool\'s real age is on its way: the acceptance the caller found is what it is checked against', async () => {
    const n = await nodeWith([tx(8, [{ parent: 7, sequence: 600 }, { parent: 0x20 }])], []);
    const client = new KaspaNodeClient('testnet-10', n.url, 2_000);
    expect((await client.mempoolJudged([ADDRESS], [{ txid: id(7), index: 0 }], new Map([[`${id(7)}:0`, 999_000n]]))).heldBy.size).toBe(0);
    // Claiming two hours of a coin accepted a hundred seconds ago, it is not.
    const early = await nodeWith([tx(8, [{ parent: 7, sequence: 72_000 }, { parent: 0x20 }])], []);
    const c2 = new KaspaNodeClient('testnet-10', early.url, 2_000);
    expect((await c2.mempoolJudged([ADDRESS], [{ txid: id(7), index: 0 }], new Map([[`${id(7)}:0`, 999_000n]]))).heldBy.size).toBe(1);
    client.close(); c2.close();
  });

  it('a wanted output made by a transaction no block can take is named; transactions that touch nothing wanted are not even judged', async () => {
    // 9 makes the wanted output and is a tick claiming 72 000 DAA on the unconfirmed output of 8. 0x50 only pays the address.
    const n = await nodeWith([], [tx(9, [{ parent: 8, sequence: 72_000 }]), tx(0x50, [{ parent: 0x51, sequence: 5 }])], [tx(8, [{ parent: 7 }])]);
    const client = new KaspaNodeClient('testnet-10', n.url, 2_000);
    const judged = await client.mempoolJudged([ADDRESS], [{ txid: id(9), index: 0 }]);
    expect([...judged.unminable.keys()]).toEqual([id(9)]);
    // Only the parent of 9 was asked about: 0x50 and its parent never.
    expect(n.methods.filter(m => m === 'getMempoolEntry')).toHaveLength(1);
    client.close();
  });

  it('with nothing wanted, the node is not asked', async () => {
    const n = await nodeWith([], []);
    const client = new KaspaNodeClient('testnet-10', n.url, 2_000);
    expect(await client.mempoolJudged([ADDRESS], [])).toEqual({ heldBy: new Map(), unminable: new Map() });
    expect(n.methods).toEqual([]);
    client.close();
  });
});
