// Round 12 (2026-11-11, on rc.17), R12-WW-3: judging a mempool spend of the pool, the wallet listed every coin at an
// address that the judged transaction named (the address of its first locked input's script). An outsider fills an
// address of their own and puts one such input in front of a parked pool spend: every look of every wallet then pulled
// that list through its node, and past 64 MB the look failed and the wallet no longer said what held the pool.
//
// Now the wallet's check lists no address at all. When an output was accepted is known only for the coins the wallet
// found itself, at addresses it asked for itself; a verdict is kept between looks.
// The node behaviour was read in rusty-kaspa v2.1.0 and not run on a node.

import { afterEach, describe, expect, it } from 'vitest';
// @ts-ignore: ws ships no types, and the test needs only its server.
import { WebSocketServer } from 'ws';
import { bytesToHex, scriptForAddress } from '@kusdt/kaspa';
import { FakeNode, COVENANT, POOL, testCtx } from './helpers';
import { p2shAddressOf, scriptOf, reserveStateOf, poolValue, verifyPool } from '@/kusdt/verify';
import { KaspaNodeClient, type MempoolJudged } from '@/kaspa/node';
import type { PoolState } from '@/kusdt/types';

const KAS = 100_000_000n;
const id = (n: number) => n.toString(16).padStart(64, '0');
// One push of a 40-byte redeem script: rc.17 took the address to list from it.
const NAMES_AN_ADDRESS = '28' + Array.from({ length: 40 }, (_, i) => i.toString(16).padStart(2, '0')).join('');

describe('R12-WW-3: the wallet\'s node client lists no address a judged transaction names', () => {
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
    transaction: { verboseData: { transactionId: id(txid), computeMass: 1_000 }, inputs: inputs.map(i => ({ previousOutpoint: { transactionId: id(i.parent), index: i.index ?? 0 }, sequence: i.sequence ?? 0, signatureScript: NAMES_AN_ADDRESS })), outputs: [] },
  });
  const ADDRESS = 'kaspatest:qzuv4u0sp5tee8e09kl3h9r2yq6rpxvahvudxx0smfuyv064fx5s69ydr0acz';
  const script = scriptForAddress(ADDRESS, 'kaspatest');
  const SPK = script.version.toString(16).padStart(4, '0') + bytesToHex(script.script);

  /** A testnet-10 node: its mempool lists `sending` for the address asked and holds `others`; its UTXO set holds `coins` at the address asked. */
  async function nodeWith(sending: ReturnType<typeof tx>[], others: ReturnType<typeof tx>[] = [], coins: { txid: number; daa: number }[] = []) {
    const wss: Server = new WebSocketServer({ port: 0, host: '127.0.0.1' });
    servers.push(wss);
    await new Promise<void>((ok) => wss.once('listening', () => ok()));
    const calls: { method: string; params: any }[] = [];
    const byId = new Map([...sending, ...others].map(e => [e.transaction.verboseData.transactionId, e]));
    wss.on('connection', (ws: ServerSocket) => {
      sockets.push(ws);
      ws.on('message', (data: unknown) => {
        const msg = JSON.parse(String(data));
        calls.push({ method: msg.method, params: msg.params });
        const answer = (params: unknown) => ws.send(JSON.stringify({ id: msg.id, method: msg.method, params }));
        if (msg.method === 'getServerInfo') return answer({ networkId: 'testnet-10', hasUtxoIndex: true, isSynced: true });
        if (msg.method === 'getMempoolEntriesByAddresses') return answer({ entries: [{ address: msg.params.addresses[0], sending, receiving: [] }] });
        if (msg.method === 'getBlockDagInfo') return answer({ virtualDaaScore: '1000000' });
        if (msg.method === 'getUtxosByAddresses') return answer({ entries: coins.map(c => ({ address: msg.params.addresses[0], outpoint: { transactionId: id(c.txid), index: 0 }, utxoEntry: { amount: 1, scriptPublicKey: SPK, blockDaaScore: c.daa, isCoinbase: false } })) });
        if (msg.method === 'getMempoolEntry') {
          const e = byId.get(msg.params.transactionId);
          if (e) return answer({ mempoolEntry: e });
          return ws.send(JSON.stringify({ id: msg.id, method: msg.method, error: { message: `Transaction ${msg.params.transactionId} not found` } }));
        }
        ws.send(JSON.stringify({ id: msg.id, method: msg.method, error: { message: 'unexpected' } }));
      });
    });
    return { url: `ws://127.0.0.1:${(wss.address() as { port: number }).port}`, calls, methods: () => calls.map(c => c.method) };
  }

  it('the finding\'s spend (a coin of the attacker\'s address at sequence 1, then the pool, then the parked coin) holds the pool, and no address is listed for it, at any look', async () => {
    const parked = tx(8, [{ parent: 0x60, sequence: 1 }, { parent: 7, sequence: 600 }, { parent: 0xf0, sequence: 100_000_000 }]);
    const n = await nodeWith([parked], [tx(0xf0, [{ parent: 0xf1 }])]);
    const client = new KaspaNodeClient('testnet-10', n.url, 2_000);
    const accepted = new Map([[`${id(7)}:0`, 999_000n]]);
    for (let look = 0; look < 5; look++) {
      const judged = await client.mempoolJudged([ADDRESS], [{ txid: id(7), index: 0 }], accepted);
      expect(judged.heldBy.get(`${id(7)}:0`)?.txid).toBe(id(8));
    }
    expect(n.methods()).not.toContain('getUtxosByAddresses');
    // Judged once: the four looks after the first ask only for the mempool's list.
    expect(n.methods().filter(m => m === 'getMempoolEntry').length).toBeLessThanOrEqual(3);
    expect(n.methods().filter(m => m === 'getMempoolEntriesByAddresses')).toHaveLength(5);
    client.close();
  });

  it('a spend that claims an age for a coin the wallet found itself is judged from that: the coin\'s acceptance is remembered from the wallet\'s own read', async () => {
    // The wallet read the pool's address (its own choice) and found the pool coin, accepted at DAA 999 000.
    const sale = tx(8, [{ parent: 7, sequence: 600 }, { parent: 0x20 }]);
    const n = await nodeWith([sale], [], [{ txid: 7, daa: 999_000 }]);
    const client = new KaspaNodeClient('testnet-10', n.url, 2_000);
    expect((await client.utxos([ADDRESS])).map(u => u.blockDaaScore)).toEqual([999_000n]);
    // A later look that was handed no acceptance (the wallet is looking at its own tokens, which the sale also spends).
    const judged = await client.mempoolJudged([ADDRESS], [{ txid: id(7), index: 0 }]);
    expect(judged.heldBy.size).toBe(0);
    expect(n.methods().filter(m => m === 'getUtxosByAddresses')).toHaveLength(1);
    client.close();
  });

  it('a spend that claims an age for a coin the wallet never found is not built on, and nothing is listed to find out', async () => {
    const sale = tx(8, [{ parent: 7, sequence: 600 }, { parent: 0x20 }]);
    const n = await nodeWith([sale]);
    const client = new KaspaNodeClient('testnet-10', n.url, 2_000);
    const judged = await client.mempoolJudged([ADDRESS], [{ txid: id(7), index: 0 }]);
    expect(judged.heldBy.get(`${id(7)}:0`)?.why).toMatch(/can't say when that output was accepted/);
    expect(n.methods()).not.toContain('getUtxosByAddresses');
    client.close();
  });
});

describe('R12-WW-3: the wallet learns the confirmed pool\'s age from an address of its own choosing', () => {
  const base: PoolState = { tokenCovid: COVENANT, kasReserve: 200n * KAS, tokenReserve: 20_000_000n, totalShares: 200n * KAS, protocolKas: 0n, protocolTokens: 0n, baseValue: KAS, admin: '11'.repeat(32), maxOutBps: 1_000n, windowLen: 36_000n, windowCredit: 0n, windowRef: 200n * KAS, windowOut: 0n, paused: false, guardian: '22'.repeat(32) };
  const moved: PoolState = { ...base, kasReserve: base.kasReserve - KAS, tokenReserve: base.tokenReserve + 100_000n };
  const CONFIRMED = id(0xa1), PENDING = id(0xb2);

  class JudgingNode extends FakeNode {
    asked: { addresses: string[]; wanted: { txid: string; index: number }[]; accepted?: Map<string, bigint> }[] = [];
    read: string[][] = [];
    async utxos(addresses: string[]) { this.read.push(addresses); return super.utxos(addresses); }
    async mempoolJudged(addresses: string[], wanted: { txid: string; index: number }[], accepted?: Map<string, bigint>): Promise<MempoolJudged> {
      this.asked.push({ addresses, wanted, accepted });
      // As the real client judges a sale that claims the confirmed pool's age: on its way only if that age is known.
      const known = accepted?.has(`${CONFIRMED}:0`);
      return { heldBy: new Map(), unminable: known ? new Map() : new Map([[PENDING, 'input 0 claims an age of 600 DAA, and the node can\'t say when that output was accepted']]) };
    }
  }

  function placed(node: JudgingNode, ctx: ReturnType<typeof testCtx>) {
    const at = (txid: string, pool: PoolState) => {
      const reserve = reserveStateOf(POOL, pool);
      const pspk = scriptOf(ctx, 'Pool', pool), rspk = scriptOf(ctx, 'KCC20', reserve);
      return {
        p: { address: p2shAddressOf(pspk, 'kaspasim'), transactionId: txid, index: 0, amount: poolValue(pool), scriptPublicKey: pspk, covenantId: POOL },
        r: { address: p2shAddressOf(rspk, 'kaspasim'), transactionId: txid, index: 1, amount: 150_000_000n, scriptPublicKey: rspk, covenantId: COVENANT },
        answer: { pool: { utxo: { transactionId: txid, index: 0 }, state: pool }, reserve: { utxo: { transactionId: txid, index: 1 }, state: reserve } },
      };
    };
    const confirmed = at(CONFIRMED, base), pending = at(PENDING, moved);
    // The confirmed pool is in the UTXO set, spent in the mempool by a sale that claims its age; the newest pool is that sale's output.
    node.utxoSet.push({ ...confirmed.p, blockDaaScore: 999_000n, isCoinbase: false });
    node.mempool.push(pending.p, pending.r);
    return { confirmed, pending };
  }

  it('the newest pool is the output of a sale that claims the confirmed pool\'s age: with the coordinator\'s confirmed pool named, the wallet reads that pool\'s own address in the same one read, and builds on the sale', async () => {
    const node = new JudgingNode();
    const ctx = testCtx(node);
    const { confirmed, pending } = placed(node, ctx);
    const vp = await verifyPool(ctx, { ...pending.answer, confirmed: confirmed.answer });
    expect(vp.pool.utxo.transactionId).toBe(PENDING);
    expect(vp.pool.utxo.confirmed).toBe(false);
    // One read of the UTXO set, for three addresses the wallet worked out itself: the newest pool's, its reserve's, the confirmed pool's.
    expect(node.read).toHaveLength(1);
    expect(node.read[0]).toHaveLength(3);
    expect(node.read[0]).toContain(confirmed.p.address);
    expect(node.asked[0].accepted?.get(`${CONFIRMED}:0`)).toBe(999_000n);
    // What it wants is still the two outputs of the newest pool.
    expect(node.asked[0].wanted).toEqual([{ txid: PENDING, index: 0 }, { txid: PENDING, index: 1 }]);
  });

  it('without it (an answer that names no confirmed pool) the sale\'s output is not built on: nothing is read to find out, and the wallet asks again', async () => {
    const node = new JudgingNode();
    const ctx = testCtx(node);
    const { pending } = placed(node, ctx);
    await expect(verifyPool(ctx, pending.answer)).rejects.toThrow(/could not be found/);
    expect(node.read).toHaveLength(1);
    expect(node.read[0]).toHaveLength(2);
  });

  it('a confirmed pool the coordinator names wrongly costs nothing but itself: it is left out, and the pool is verified as before', async () => {
    const node = new JudgingNode();
    const ctx = testCtx(node);
    const { confirmed } = placed(node, ctx);
    const reserve = reserveStateOf(POOL, base);
    const rspk = scriptOf(ctx, 'KCC20', reserve);
    node.utxoSet.push({ address: p2shAddressOf(rspk, 'kaspasim'), transactionId: CONFIRMED, index: 1, amount: 150_000_000n, scriptPublicKey: rspk, covenantId: COVENANT, blockDaaScore: 999_000n, isCoinbase: false });
    node.mempool.length = 0;
    const vp = await verifyPool(ctx, { ...confirmed.answer, confirmed: { pool: { utxo: { transactionId: 'not a txid', index: 0 }, state: { nonsense: true } } } } as any);
    expect(vp.pool.utxo.transactionId).toBe(CONFIRMED);
    expect(node.read[0]).toHaveLength(2);
  });
});
