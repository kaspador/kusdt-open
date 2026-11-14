// Run 21, R21-POOL-1 (extends D6-2 and Daybreak [45]). The pool's kUSDT reserve sits at an address that follows from
// its amount alone (tokenReserve + protocolTokens). Once someone has filled that address past what a node's answer
// holds, anyone can trade the reserve back to that amount after every move of the operators: a buy lowers it by the
// tokens bought, a sell raises it by the tokens sold (bridge/kaspa/tests/r21_pool.rs runs the trades in the covenant
// engine, chained on the operators' unconfirmed move). The wallet checked the reserve by listing that address, so it
// refused every swap and every deposit or withdrawal of liquidity for as long as the trader kept it up.
//
// Here the transactions are the core's own, so their ids are real: the operator's small buy moves the reserve, a
// trader's sale of exactly those units puts it back at the filled address, and the coordinator names, with the reserve,
// the transaction that made it (`reserve.made`), whose body it serves at GET /pool/made/:txid. The wallet proves the
// reserve from that body and the pool coin, and builds on the pool again. A body that does not prove it changes
// nothing: the wallet then lists the address as before, and says it could not.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { freshPool, quoteBuy, quoteSell, swap, POOL_WAIT } from '@/kusdt/pool';
import { NotInBlockYet } from '@/kusdt/inputs';
import { ApiError } from '@/kusdt/api';
import { PoolUnreadable, p2shAddressOf, parsePoolState, poolValue, reserveStateOf, scriptOf } from '@/kusdt/verify';
import { plainState } from '@/kusdt/owner';
import { local, session } from '@/lib/storage';
import type { NodeUtxo } from '@/kaspa/node';
import type { PoolState } from '@/kusdt/types';
import { COVENANT, NET, POOL, core, devKey, kasCoin, signerFor } from './helpers';
import { holder } from './flooded';

POOL_WAIT.ms = 0;
POOL_WAIT.perDaaMs = 0;

beforeEach(async () => {
  for (const k of ['kusdt.pending.simnet', 'kusdt.unreadable.simnet', `kusdt.poolHint.simnet.${POOL}`]) await session.remove(k);
  await local.remove('kusdt.positions.simnet');
});
afterEach(() => { vi.restoreAllMocks(); });

const KAS = 100_000_000n;
const TOKEN_VALUE = 150_000_000n;
const T0 = 1_000_000_000n;
const P1: PoolState = { tokenCovid: COVENANT, kasReserve: 10_000n * KAS, tokenReserve: T0, totalShares: 10_000n * KAS, protocolKas: 0n, protocolTokens: 0n, baseValue: KAS, admin: '11'.repeat(32), maxOutBps: 1_000n, windowLen: 36_000n, windowCredit: 0n, windowRef: 10_000n * KAS, windowOut: 0n, paused: false, guardian: '22'.repeat(32) };
/** The fake node's virtual DAA (helpers.ts) less the clients' margin: the breaker's clock the builds claim to. */
const NOW_DAA = 1_000_000n - 10n;

const operator = devKey('r21-operator');
const trader = devKey('r21-trader');

/** A built transaction's body as the coordinator serves it with the reserve it made: what its id commits to, no signature scripts. */
function madeOf(built: any): any {
  const tx = structuredClone(built.transaction);
  return { ...tx, inputs: tx.inputs.map(({ signatureScript: _, ...rest }: any) => rest) };
}

/** A covenant output the core built, as the node holds it once its transaction is accepted. */
function outputOf(built: any, index: number, daa = 2n): NodeUtxo {
  const o = built.outputs[index];
  return { address: p2shAddressOf(o.scriptPublicKey, NET.prefix), transactionId: built.txid, index, amount: BigInt(o.value), scriptPublicKey: o.scriptPublicKey, blockDaaScore: daa, isCoinbase: false, covenantId: o.kind === 'pool' ? POOL : COVENANT };
}

const coreUtxo = (u: NodeUtxo) => ({ transactionId: u.transactionId, index: u.index, amount: u.amount, scriptPublicKey: u.scriptPublicKey, blockDaaScore: u.blockDaaScore, isCoinbase: false, covenantId: u.covenantId });
/** A KAS coin of `k`'s to fund a transaction built by hand (`tag`: hex, unique per coin). */
const funding = (k: ReturnType<typeof devKey>, tag: string) => [{ utxo: coreUtxo(kasCoin(k, tag.padEnd(64, 'f'), 1_000n * KAS)), secretKey: k.secret }];

/**
 * The scene: the pool at a made-up outpoint whose reserve address has been filled; the operator's small buy (built by
 * hand, as the runbook says); the trader's sale of exactly the units bought, which puts the reserve's amount back at
 * T0 and so at the filled address. `tag`: hex, unique per test (the coins' ids are made of it).
 */
function scene(tag: string) {
  let answer: any = null;
  // The bodies the coordinator holds, by the transactions' ids (GET /pool/made/:txid), and every id the wallet asked for.
  const bodies = new Map<string, unknown>(), asked: string[] = [];
  const poolMade = async (txid: string) => {
    asked.push(txid);
    if (!bodies.has(txid)) throw new ApiError('not the transaction that made the pool reserve this coordinator follows now', 404);
    return bodies.get(txid);
  };
  const h = holder(tag, [], { api: { pool: async () => answer, poolMade } });
  const node = h.node;
  const pspk = scriptOf(h.ctx, 'Pool', P1), r1 = reserveStateOf(POOL, P1), rspk = scriptOf(h.ctx, 'KCC20', r1);
  const p1: NodeUtxo = { address: p2shAddressOf(pspk, NET.prefix), transactionId: `${tag}a1`.padEnd(64, '0'), index: 0, amount: poolValue(P1), scriptPublicKey: pspk, blockDaaScore: 1n, isCoinbase: false, covenantId: POOL };
  const reserve1: NodeUtxo = { address: p2shAddressOf(rspk, NET.prefix), transactionId: p1.transactionId, index: 1, amount: TOKEN_VALUE, scriptPublicKey: rspk, blockDaaScore: 1n, isCoinbase: false, covenantId: COVENANT };
  node.utxoSet.push(p1, reserve1);
  const filled = reserve1.address;
  node.full.add(filled);
  answer = { pool: { utxo: { transactionId: p1.transactionId, index: 0 }, state: P1 }, reserve: { utxo: { transactionId: p1.transactionId, index: 1 }, state: r1 } };

  // The operator's small buy, sent by hand on the coordinator's view (the runbook's way off a filled address).
  const kasIn = 5_317n, bought = quoteBuy(h.ctx, P1, kasIn);
  const buy = core.call('pool-buy', {
    network: 'simnet', feerate: 100, changeAddress: operator.address, funding: funding(operator, `${tag}0`),
    pool: { utxo: coreUtxo(p1), state: P1 }, reserve: { utxo: coreUtxo(reserve1), state: r1 },
    kasIn, tokensOut: bought, buyer: operator.xonly, tokenValue: TOKEN_VALUE, nowDaa: NOW_DAA,
  }).value as any;
  const P2 = parsePoolState(buy.outputs[0].pool);
  const [p2, reserve2] = [outputOf(buy, 0), outputOf(buy, 1)];

  // The trader's sale of exactly the units bought, chained on the operator's buy: the reserve's amount is T0 again.
  const held = plainState({ ownerScheme: 0, owner: trader.xonly }, bought);
  const heldSpk = scriptOf(h.ctx, 'KCC20', held);
  const heldUtxo: NodeUtxo = { address: p2shAddressOf(heldSpk, NET.prefix), transactionId: `${tag}a9`.padEnd(64, '0'), index: 0, amount: TOKEN_VALUE, scriptPublicKey: heldSpk, blockDaaScore: 1n, isCoinbase: false, covenantId: COVENANT };
  const kasOut = quoteSell(h.ctx, P2, bought);
  const sell = core.call('pool-sell', {
    network: 'simnet', feerate: 100, changeAddress: trader.address, funding: funding(trader, `${tag}1`),
    pool: { utxo: coreUtxo(p2), state: P2 }, reserve: { utxo: coreUtxo(reserve2), state: reserveStateOf(POOL, P2) },
    payer: { utxo: coreUtxo(heldUtxo), state: held, secretKey: trader.secret },
    tokensIn: bought, kasOut, tokenValue: TOKEN_VALUE, nowDaa: NOW_DAA,
  }).value as any;
  const P3 = parsePoolState(sell.outputs[0].pool);
  const [p3, reserve3] = [outputOf(sell, 0, 3n), outputOf(sell, 1, 3n)];

  /** The node after both: the pool and its reserve where the sale left them, and KAS for the wallet to trade with. */
  const landed = () => {
    node.utxoSet = node.utxoSet.filter(u => u !== p1 && u !== reserve1);
    node.utxoSet.push(p3, reserve3, kasCoin(h.alice, `${tag}e`.padEnd(64, 'e'), 1_000n * KAS));
  };
  /** The coordinator's /pool after the sale, the reserve at `reserveIndex`, naming the sale whose body `made` it holds (absent: none). */
  const serve = (made: unknown, over: { reserveIndex?: number } = {}) => {
    bodies.clear();
    if (made !== undefined) bodies.set(sell.txid, made);
    answer = {
      pool: { utxo: { transactionId: sell.txid, index: 0 }, state: P3 },
      reserve: { utxo: { transactionId: sell.txid, index: over.reserveIndex ?? 1 }, state: reserveStateOf(POOL, P3), ...(made !== undefined && { made: sell.txid }) },
    };
  };
  return { h, node, filled, buy, sell, P3, p3, reserve2, reserve3, landed, serve, bodies, asked };
}

describe('R21-POOL-1: the reserve traded back to a filled address', () => {
  it('the scene: the trader\'s sale puts the reserve back at the filled address, on a new pool state and outpoint', () => {
    const s = scene('a0');
    expect(s.reserve2.address).not.toBe(s.filled);
    expect(s.P3.tokenReserve + s.P3.protocolTokens).toBe(T0);
    expect(s.reserve3.address).toBe(s.filled);
    expect(s.p3.transactionId).toBe(s.sell.txid);
  });

  it('with no body for the reserve, the wallet still says it could not check it (the coordinator gave nothing to prove it with)', async () => {
    const s = scene('b0');
    const e = await freshPool(s.h.ctx).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(PoolUnreadable);
    expect((e as PoolUnreadable).which).toBe('reserve');
    s.landed();
    s.serve(undefined);
    const again = await freshPool(s.h.ctx).catch((x: unknown) => x);
    expect(again).toBeInstanceOf(PoolUnreadable);
    expect((again as PoolUnreadable).which).toBe('reserve');
  });

  it('with the body of the transaction that made it, the wallet proves the reserve from the pool coin, never lists the filled address, and trades', async () => {
    const s = scene('c0');
    s.landed();
    s.serve(madeOf(s.sell));
    const readsBefore = s.node.reads.length;
    const vp = await freshPool(s.h.ctx);
    expect(vp.pool.utxo.transactionId).toBe(s.sell.txid);
    expect(vp.reserve).not.toBeNull();
    const r = vp.reserve!;
    expect(`${r.utxo.transactionId}:${r.utxo.index}`).toBe(`${s.sell.txid}:1`);
    expect(r.utxo.amount).toBe(BigInt(s.sell.outputs[1].value));
    expect(r.utxo.scriptPublicKey).toBe(s.reserve3.scriptPublicKey);
    expect(r.utxo.covenantId).toBe(COVENANT);
    expect(r.utxo.confirmed).toBe(true);
    expect(r.state).toEqual(reserveStateOf(POOL, s.P3));
    // The filled address was never asked about; the body was fetched once, by the sale's id.
    expect(s.node.reads.slice(readsBefore).flat()).not.toContain(s.filled);
    expect(s.asked).toEqual([s.sell.txid]);

    // A buy goes out on it: the core builds on the proven reserve and runs the covenant's scripts on it.
    const signer = signerFor(s.h.alice);
    const kasIn = 10n * KAS, quoted = quoteBuy(s.h.ctx, s.P3, kasIn);
    const res = await swap(s.h.ctx, signer, [s.h.alice.address], { side: 'buy', amountIn: kasIn, minOut: quoted, quoted });
    expect(res.amountOut).toBe(quoted);
    const sent = JSON.parse(s.node.submitted.at(-1)!);
    expect(sent.inputs.map((i: any) => `${i.previousOutpoint.transactionId}:${i.previousOutpoint.index}`).slice(0, 2)).toEqual([`${s.sell.txid}:0`, `${s.sell.txid}:1`]);
    expect(s.node.reads.flat()).not.toContain(s.filled);
    // Kept by its id: the buy's own looks at the pool asked for it no more.
    expect(s.asked).toEqual([s.sell.txid]);
    console.log(`R21-POOL-1 wallet: reserve back at the filled address (amount ${T0}), proven from the body of ${s.sell.txid.slice(0, 12)}…; buy ${res.txid.slice(0, 12)}… built on it`);
  });

  it('a body that does not prove the reserve is not believed: the wallet lists the address, as without one', async () => {
    const s = scene('d0');
    s.landed();
    const real = madeOf(s.sell);
    const refused = async (made: unknown, over?: { reserveIndex?: number }) => {
      s.serve(made, over);
      const e = await freshPool(s.h.ctx).catch((x: unknown) => x);
      expect(e).toBeInstanceOf(PoolUnreadable);
      expect((e as PoolUnreadable).which).toBe('reserve');
    };
    // Another KAS amount on the reserve's output: not the body its id commits to.
    await refused({ ...real, outputs: real.outputs.map((o: any, i: number) => (i === 1 ? { ...o, value: String(BigInt(o.value) + 1n) } : o)) });
    // The reserve's output without its kUSDT binding (a plain payment to the same script, as a flood's coins are).
    await refused({ ...real, outputs: real.outputs.map((o: any, i: number) => (i === 1 ? { ...o, covenant: null } : o)) });
    // As a version 0 body: its id would not commit to the bindings at all.
    await refused({ ...real, version: 0 });
    // The body of another transaction: the operator's buy, whose id is not the reserve's.
    await refused(madeOf(s.buy));
    // Not a body at all.
    await refused('the reserve is fine, trust me');
    // The reserve named at another output of its transaction (the sale's KAS change): not the reserve's script.
    await refused(real, { reserveIndex: 2 });
  });

  it('after the pool moved on without moving kUSDT (a tick), the reserve made earlier is listed, and taken from its body once its address cannot be', async () => {
    const s = scene('f0');
    s.landed();
    // A tick on the pool the sale left (it claims at least the 50 DAA a tick takes): a new pool coin, the reserve where it was.
    const tick = core.call('pool-tick', {
      network: 'simnet', feerate: 100, changeAddress: trader.address, funding: funding(trader, 'f02'),
      pool: { utxo: coreUtxo(s.p3), state: s.P3 }, nowDaa: NOW_DAA,
    }).value as any;
    expect(tick.outputs.filter((o: any) => o.kind === 'reserve')).toHaveLength(0);
    const p4 = outputOf(tick, 0, 4n);
    s.node.utxoSet = s.node.utxoSet.filter(u => u !== s.p3);
    s.node.utxoSet.push(p4);
    s.bodies.set(s.sell.txid, madeOf(s.sell));
    const answer = { pool: { utxo: { transactionId: tick.txid, index: 0 }, state: parsePoolState(tick.outputs[0].pool) }, reserve: { utxo: { transactionId: s.sell.txid, index: 1 }, state: reserveStateOf(POOL, s.P3), made: s.sell.txid } };
    s.h.ctx.api!.pool = async () => answer as any;
    const vp = await freshPool(s.h.ctx);
    expect(vp.pool.utxo.transactionId).toBe(tick.txid);
    expect(`${vp.reserve!.utxo.transactionId}:${vp.reserve!.utxo.index}`).toBe(`${s.sell.txid}:1`);
    expect(vp.reserve!.utxo.amount).toBe(BigInt(s.sell.outputs[1].value));
    expect(vp.reserve!.utxo.confirmed).toBe(true);
    // Made before the pool coin, the reserve is listed first, as before: the node cannot list its address (filled), and
    // only then is the body taken. The address is not asked about again for a while (kusdt/unreadable.ts).
    const asked = s.node.reads.flat().filter(a => a === s.filled).length;
    expect(asked).toBeGreaterThan(0);
    expect((await freshPool(s.h.ctx)).reserve!.utxo.transactionId).toBe(s.sell.txid);
    expect(s.node.reads.flat().filter(a => a === s.filled)).toHaveLength(asked);

    // With the tick only in the node's mempool and the sale too, the reserve is not in a block yet: the pool takes it
    // once it is, and the wallet says so instead of building (rc.22 require_settled_inputs).
    s.node.utxoSet = s.node.utxoSet.filter(u => u !== p4 && u !== s.reserve3);
    s.node.mempool.push({ ...p4 }, { ...s.reserve3 });
    const pending = await freshPool(s.h.ctx);
    expect(pending.pool.utxo.confirmed).toBe(false);
    expect(pending.reserve!.utxo.confirmed).toBe(false);
    const signer = signerFor(s.h.alice);
    const kasIn = 10n * KAS, quoted = quoteBuy(s.h.ctx, pending.pool.state, kasIn);
    await expect(swap(s.h.ctx, signer, [s.h.alice.address], { side: 'buy', amountIn: kasIn, minOut: quoted, quoted })).rejects.toBeInstanceOf(NotInBlockYet);
  });
});
