// Reviewer rv-w, run 21: what the body of the transaction that made the pool's kUSDT reserve proves (R21-POOL-1's fix).
//
// The body proves what an outpoint holds IF that transaction exists; that it exists and is unspent follows only when
// the reserve was made with the pool coin the node shows (the reserve is spent only with the pool coin). So a reserve
// made before the pool coin (the pool has ticked or been paused since) is listed on the node as before, and its body is
// taken only when that list cannot be read (its address filled: R21-POOL-1). Here the coordinator lies:
//   V1  an OLD reserve (spent since) at the same amount, with its real body, beside the current pool coin;
//   V2  a reserve in a transaction that never existed (a body the coordinator wrote), beside the current pool coin;
//   V3  a body whose pool coin is another pool's (must not prove);
//   V4  the coordinator down (nothing is built, as before).
// Up to 97e5280's first form the wallet took V1 and V2 on the body alone and signed a buy spending them (the node then
// refused it); before it, and now, they are refused before anything is built.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { idBodyOf, transactionIdOf } from '@kusdt/kaspa';
import { freshPool, quoteBuy, quoteSell, swap, POOL_WAIT } from '@/kusdt/pool';
import { ApiError } from '@/kusdt/api';
import { VerifyError, p2shAddressOf, parsePoolState, poolValue, reserveStateOf, scriptOf } from '@/kusdt/verify';
import { plainState } from '@/kusdt/owner';
import { session, local } from '@/lib/storage';
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
const NOW_DAA = 1_000_000n - 10n;
const operator = devKey('rvw-operator');
const trader = devKey('rvw-trader');

const madeOf = (built: any): any => {
  const tx = structuredClone(built.transaction);
  return { ...tx, inputs: tx.inputs.map(({ signatureScript: _, ...rest }: any) => rest) };
};
const outputOf = (built: any, index: number, daa = 2n): NodeUtxo => {
  const o = built.outputs[index];
  return { address: p2shAddressOf(o.scriptPublicKey, NET.prefix), transactionId: built.txid, index, amount: BigInt(o.value), scriptPublicKey: o.scriptPublicKey, blockDaaScore: daa, isCoinbase: false, covenantId: o.kind === 'pool' ? POOL : COVENANT };
};
const coreUtxo = (u: NodeUtxo) => ({ transactionId: u.transactionId, index: u.index, amount: u.amount, scriptPublicKey: u.scriptPublicKey, blockDaaScore: u.blockDaaScore, isCoinbase: false, covenantId: u.covenantId });
const funding = (k: ReturnType<typeof devKey>, tag: string) => [{ utxo: coreUtxo(kasCoin(k, tag.padEnd(64, 'f'), 1_000n * KAS)), secretKey: k.secret }];

/** Two rounds of "operator buys a little, trader sells exactly that back": the reserve at T0 after each (sell1, then sell2). */
function twoRounds(tag: string) {
  let answer: any = null;
  // The bodies the coordinator serves at GET /pool/made/:txid, by the transactions' ids.
  const bodies = new Map<string, unknown>();
  const poolMade = async (txid: string) => {
    if (!bodies.has(txid)) throw new ApiError('not the transaction that made the pool reserve this coordinator follows now', 404);
    return bodies.get(txid);
  };
  const h = holder(tag, [], { api: { pool: async () => answer, poolMade } });
  const node = h.node;
  const pspk = scriptOf(h.ctx, 'Pool', P1), r1 = reserveStateOf(POOL, P1), rspk = scriptOf(h.ctx, 'KCC20', r1);
  const p1: NodeUtxo = { address: p2shAddressOf(pspk, NET.prefix), transactionId: `${tag}a1`.padEnd(64, '0'), index: 0, amount: poolValue(P1), scriptPublicKey: pspk, blockDaaScore: 1n, isCoinbase: false, covenantId: POOL };
  const reserve1: NodeUtxo = { address: p2shAddressOf(rspk, NET.prefix), transactionId: p1.transactionId, index: 1, amount: TOKEN_VALUE, scriptPublicKey: rspk, blockDaaScore: 1n, isCoinbase: false, covenantId: COVENANT };
  const round = (pool: NodeUtxo, P: PoolState, reserve: NodeUtxo, n: string) => {
    const kasIn = 5_317n, bought = quoteBuy(h.ctx, P, kasIn);
    const buy = core.call('pool-buy', {
      network: 'simnet', feerate: 100, changeAddress: operator.address, funding: funding(operator, `${tag}${n}0`),
      pool: { utxo: coreUtxo(pool), state: P }, reserve: { utxo: coreUtxo(reserve), state: reserveStateOf(POOL, P) },
      kasIn, tokensOut: bought, buyer: operator.xonly, tokenValue: TOKEN_VALUE, nowDaa: NOW_DAA,
    }).value as any;
    const P2 = parsePoolState(buy.outputs[0].pool);
    const held = plainState({ ownerScheme: 0, owner: trader.xonly }, bought);
    const heldSpk = scriptOf(h.ctx, 'KCC20', held);
    const heldUtxo: NodeUtxo = { address: p2shAddressOf(heldSpk, NET.prefix), transactionId: `${tag}${n}9`.padEnd(64, '0'), index: 0, amount: TOKEN_VALUE, scriptPublicKey: heldSpk, blockDaaScore: 1n, isCoinbase: false, covenantId: COVENANT };
    const sell = core.call('pool-sell', {
      network: 'simnet', feerate: 100, changeAddress: trader.address, funding: funding(trader, `${tag}${n}1`),
      pool: { utxo: coreUtxo(outputOf(buy, 0)), state: P2 }, reserve: { utxo: coreUtxo(outputOf(buy, 1)), state: reserveStateOf(POOL, P2) },
      payer: { utxo: coreUtxo(heldUtxo), state: held, secretKey: trader.secret },
      tokensIn: bought, kasOut: quoteSell(h.ctx, P2, bought), tokenValue: TOKEN_VALUE, nowDaa: NOW_DAA,
    }).value as any;
    return { buy, sell, P: parsePoolState(sell.outputs[0].pool), pool: outputOf(sell, 0, 3n), reserve: outputOf(sell, 1, 3n) };
  };
  const a = round(p1, P1, reserve1, 'b');
  const b = round(a.pool, a.P, a.reserve, 'c');
  // The node after both rounds: round two's pool and reserve, KAS for the wallet. Round one's reserve is spent.
  node.utxoSet.push(b.pool, b.reserve, kasCoin(h.alice, `${tag}e`.padEnd(64, 'e'), 1_000n * KAS));
  /** The coordinator's /pool: the current pool coin beside the reserve it names, which names its body `made` (absent: none). */
  const serve = (reserve: { txid: string; index: number }, made: unknown) => {
    if (made !== undefined) bodies.set(reserve.txid, made);
    answer = {
      pool: { utxo: { transactionId: b.sell.txid, index: 0 }, state: b.P },
      reserve: { utxo: { transactionId: reserve.txid, index: reserve.index }, state: reserveStateOf(POOL, b.P), ...(made !== undefined && { made: reserve.txid }) },
    };
  };
  return { h, node, a, b, rspk, serve };
}

/** The wallet's buy on whatever freshPool proves; the outpoints its transaction spends. */
async function buyOn(s: ReturnType<typeof twoRounds>) {
  const signer = signerFor(s.h.alice);
  const kasIn = 10n * KAS, quoted = quoteBuy(s.h.ctx, s.b.P, kasIn);
  const res = await swap(s.h.ctx, signer, [s.h.alice.address], { side: 'buy', amountIn: kasIn, minOut: quoted, quoted });
  const sent = JSON.parse(s.node.submitted.at(-1)!);
  return { res, inputs: sent.inputs.map((i: any) => `${i.previousOutpoint.transactionId}:${i.previousOutpoint.index}`) as string[] };
}

describe('rv-w: what reserve.made proves, and what it does not', () => {
  it('the scene: both rounds leave the reserve at the same amount, so at one script; round one\'s reserve is spent', () => {
    const s = twoRounds('a1');
    expect(s.a.P.tokenReserve + s.a.P.protocolTokens).toBe(T0);
    expect(s.b.P.tokenReserve + s.b.P.protocolTokens).toBe(T0);
    expect(s.a.reserve.scriptPublicKey).toBe(s.b.reserve.scriptPublicKey);
    expect(s.node.utxoSet.some((u) => u.transactionId === s.a.sell.txid)).toBe(false);
  });

  it('V1: an old, spent reserve with its real body beside the current pool coin is listed, not found, and refused before anything is built', async () => {
    const s = twoRounds('b1');
    s.serve({ txid: s.a.sell.txid, index: 1 }, madeOf(s.a.sell));
    const e = await freshPool(s.h.ctx).catch((x: Error) => x);
    console.log(`RVW-POOL-V1 ${JSON.stringify({ served: `${s.a.sell.txid}:1 (spent)`, current: `${s.b.sell.txid}:1`, outcome: e instanceof Error ? `${e.constructor.name}: ${e.message.slice(0, 80)}` : 'proved' })}`);
    expect(e).toBeInstanceOf(VerifyError);
    await expect(buyOn(s)).rejects.toBeInstanceOf(VerifyError);
    expect(s.node.submitted).toHaveLength(0);
  });

  it('V2: a reserve in a transaction that never existed, beside the current pool coin, is refused before anything is built', async () => {
    const s = twoRounds('c1');
    // The coordinator writes a body: a coin of the pool's, then a kUSDT output at the reserve's script, with whatever KAS.
    const body = {
      version: 1, lockTime: 0, subnetworkId: '00'.repeat(20), gas: 0, payload: '',
      inputs: [{ previousOutpoint: { transactionId: 'ab'.repeat(32), index: 0 }, sequence: 0 }],
      outputs: [
        { value: '100000000', scriptPublicKey: s.b.pool.scriptPublicKey, covenant: { authorizingInput: 0, covenantId: POOL } },
        { value: '777700000000', scriptPublicKey: s.rspk, covenant: { authorizingInput: 0, covenantId: COVENANT } },
      ],
    };
    const txid = transactionIdOf(idBodyOf(body)!);
    s.serve({ txid, index: 1 }, body);
    const e = await freshPool(s.h.ctx).catch((x: Error) => x);
    console.log(`RVW-POOL-V2 ${JSON.stringify({ fabricated: `${txid}:1`, outcome: e instanceof Error ? e.constructor.name : 'proved' })}`);
    expect(e).toBeInstanceOf(VerifyError);
    await expect(buyOn(s)).rejects.toBeInstanceOf(VerifyError);
    expect(s.node.submitted).toHaveLength(0);
  });

  it('V3: a body whose pool coin is another pool\'s does not prove the reserve (the address is listed, as without one)', async () => {
    const s = twoRounds('d1');
    const real = madeOf(s.b.sell);
    const other = { ...real, outputs: real.outputs.map((o: any) => (o.covenant?.covenantId === POOL ? { ...o, covenant: { ...o.covenant, covenantId: 'ee'.repeat(32) } } : o)) };
    const txid = transactionIdOf(idBodyOf(other)!);
    s.serve({ txid, index: 1 }, other);
    const before = s.node.reads.length;
    const e = await freshPool(s.h.ctx).catch((x: Error) => x);
    console.log(`RVW-POOL-V3 ${JSON.stringify({ outcome: e instanceof Error ? e.constructor.name : 'proved', listedReserve: s.node.reads.slice(before).flat().includes(s.b.reserve.address) })}`);
    expect(e).toBeInstanceOf(Error);
    expect(s.node.reads.slice(before).flat()).toContain(s.b.reserve.address);
  });

  it('V4: the coordinator down: no pool, nothing built or signed (as before the fix)', async () => {
    const s = twoRounds('e1');
    s.h.ctx.api!.pool = async () => { throw new ApiError('Could not reach the coordinator.', 0); };
    const e = await freshPool(s.h.ctx).catch((x: Error) => x);
    console.log(`RVW-POOL-V4 ${JSON.stringify({ outcome: (e as Error).constructor.name, message: (e as Error).message, submitted: s.node.submitted.length })}`);
    expect(e).toBeInstanceOf(ApiError);
    expect(s.node.submitted).toHaveLength(0);
  });
});
