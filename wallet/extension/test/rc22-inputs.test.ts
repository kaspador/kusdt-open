// rc.22's input rule (bridge_mint.ag require_settled_inputs; SPEC §15, "Parked spends"): a pool transaction has at most
// 8 inputs, its funding coins are plain Schnorr P2PK coins, and a coin still in the mempool goes in only if the
// transaction that made the pool coin made it too. The core's builders refuse anything else in words; the wallet
// chooses by the same rule and says what to do: a wallet whose KAS is in too many small coins is told to merge them
// (it used to build a transaction the core refused, with the core's words), a coin it found only in the mempool is
// handed to the core with the node's mark for it (UNACCEPTED_DAA_SCORE), and one that is not the pool coin's sibling
// is not mixed in.

import { describe, expect, it } from 'vitest';
import { FakeNode, COVENANT, POOL, devKey, fakeApi, testCtx, signerFor, kasCoin, core, lastBuilt } from './helpers';
import { p2shAddressOf, scriptOf, reserveStateOf, poolValue } from '@/kusdt/verify';
import { POOL_WAIT, addLiquidity, quoteAdd, quoteBuy, quoteRemove, removeLiquidity, swap, trimToShares } from '@/kusdt/pool';
import { kasCoins } from '@/kusdt/build';
import { COVENANT_INPUTS, MAX_TX_INPUTS, MergeCoinsFirst, NotInBlockYet, UNACCEPTED_DAA_SCORE, daaForCore, fundingCap, isMergeCoinsFirst, isSchnorrP2pk } from '@/kusdt/inputs';
import { claimFor } from '@kusdt/protocol';
import { plainState } from '@/kusdt/owner';
import type { NodeUtxo } from '@/kaspa/node';
import type { PoolState } from '@/kusdt/types';

const alice = devKey('alice');
POOL_WAIT.ms = 0;
POOL_WAIT.perDaaMs = 0;
const KAS = 100_000_000n;
const base: PoolState = { tokenCovid: COVENANT, kasReserve: 200n * KAS, tokenReserve: 20_000_000n, totalShares: 200n * KAS, protocolKas: 0n, protocolTokens: 0n, baseValue: KAS, admin: '11'.repeat(32), maxOutBps: 1_000n, windowLen: 36_000n, windowCredit: 0n, windowRef: 0n, windowOut: 0n, paused: false, guardian: '22'.repeat(32) };

let no = 0;
const uniq = (c: string) => (++no).toString(16).padStart(64, c);

/** The pool at `txid` (pool 0, reserve 1): in the UTXO set, or as outputs of a transaction still in the mempool. */
function placePool(node: FakeNode, ctx: ReturnType<typeof testCtx>, txid: string, pool: PoolState, where: 'utxo' | 'mempool') {
  const reserve = reserveStateOf(POOL, pool);
  const pspk = scriptOf(ctx, 'Pool', pool), rspk = scriptOf(ctx, 'KCC20', reserve);
  const p = { address: p2shAddressOf(pspk, 'kaspasim'), transactionId: txid, index: 0, amount: poolValue(pool), scriptPublicKey: pspk, covenantId: POOL };
  const r = { address: p2shAddressOf(rspk, 'kaspasim'), transactionId: txid, index: 1, amount: 150_000_000n, scriptPublicKey: rspk, covenantId: COVENANT };
  if (where === 'utxo') node.utxoSet.push({ ...p, blockDaaScore: 999_000n, isCoinbase: false }, { ...r, blockDaaScore: 999_000n, isCoinbase: false });
  else node.mempool.push(p, r);
  return { pool: { utxo: { transactionId: txid, index: 0 }, state: pool }, reserve: { utxo: { transactionId: txid, index: 1 }, state: reserve } };
}

/** Alice's liquidity position at txid:index, in the UTXO set or only in the mempool, as GET /positions lists it. */
function placePosition(node: FakeNode, ctx: ReturnType<typeof testCtx>, txid: string, index: number, shares: bigint, where: 'utxo' | 'mempool') {
  const state = { tokenCovid: COVENANT, shares, owner: alice.xonly };
  const spk = scriptOf(ctx, 'Position', state);
  const o = { address: p2shAddressOf(spk, 'kaspasim'), transactionId: txid, index, amount: BigInt(ctx.config.positionValue), scriptPublicKey: spk, covenantId: POOL };
  if (where === 'utxo') node.utxoSet.push({ ...o, blockDaaScore: 999_000n, isCoinbase: false });
  else node.mempool.push(o);
  return { utxo: { transactionId: txid, index, amount: o.amount.toString() }, state: { ...state, shares: shares.toString() } };
}

/** A kUSDT state of alice's, on the node and in the coordinator's list. */
function tokenOf(ctx: ReturnType<typeof testCtx>, amount: bigint) {
  const state = plainState({ ownerScheme: 0, owner: alice.xonly }, amount);
  const spk = scriptOf(ctx, 'KCC20', state);
  const txid = uniq('d');
  return {
    utxo: { address: p2shAddressOf(spk, 'kaspasim'), transactionId: txid, index: 0, amount: 150_000_000n, scriptPublicKey: spk, blockDaaScore: 5n, isCoinbase: false, covenantId: COVENANT } as NodeUtxo,
    listed: { utxo: { transactionId: txid, index: 0 }, state: { ...state, amount: amount.toString() } },
  };
}

/**
 * A pool (where `where` says), alice's KAS in coins of `coins` sompi each, a 3 kUSDT state, and `positions`. Every
 * request the core is given is kept in `asked`.
 */
function scenario(coins: bigint[], opts: { where?: 'utxo' | 'mempool'; pool?: PoolState; positions?: (ctx: ReturnType<typeof testCtx>, node: FakeNode, poolTx: string) => any[] } = {}) {
  const node = new FakeNode();
  const listed: any[] = [];
  let pool: any = null, positions: any[] = [];
  const ctx = testCtx(node, fakeApi({ pool: async () => pool, tokens: async () => ({ states: listed }), positions: async () => ({ positions }) }));
  const asked: { command: string; request: any }[] = [];
  ctx.core = { ...ctx.core, call: ((command: string, request: any) => { asked.push({ command, request }); return core.call(command, request); }) as typeof core.call };
  const poolTx = uniq('1');
  pool = placePool(node, ctx, poolTx, opts.pool ?? base, opts.where ?? 'utxo');
  for (const amount of coins) node.utxoSet.push(kasCoin(alice, uniq('e'), amount));
  const t = tokenOf(ctx, 3_000_000n);
  node.utxoSet.push(t.utxo);
  listed.push(t.listed);
  positions = opts.positions?.(ctx, node, poolTx) ?? [];
  const built = (command: string) => asked.filter(a => a.command === command).at(-1)?.request;
  return { node, ctx, poolTx, built };
}

const inputsOfLast = (): { sequence: unknown; previousOutpoint: { transactionId: string } }[] => lastBuilt.value.transaction.inputs;

describe('the rule as the wallet holds it', () => {
  it('is the protocol\'s: 8 inputs in all, the node\'s mark for a mempool output, and the covenant coins of each command', () => {
    expect(MAX_TX_INPUTS).toBe(8);
    expect(UNACCEPTED_DAA_SCORE).toBe(2n ** 64n - 1n);
    expect(COVENANT_INPUTS).toEqual({ 'pool-buy': 2, 'pool-init': 2, 'pool-sell': 3, 'pool-add': 3, 'pool-remove': 3 });
    // As the developers' page says: a buy leaves room for 6 funding coins; a sale, a deposit or a withdrawal for 5.
    expect([fundingCap('pool-buy'), fundingCap('pool-sell'), fundingCap('pool-add'), fundingCap('pool-remove'), fundingCap('pool-init')]).toEqual([6, 5, 5, 5, 6]);
    expect(fundingCap('transfer')).toBeNull();
    expect(isSchnorrP2pk(`000020${alice.xonly}ac`)).toBe(true);
    expect(isSchnorrP2pk(`000021${'02' + alice.xonly}ab`)).toBe(false);
    expect(isSchnorrP2pk(`0000aa20${alice.xonly}87`)).toBe(false);
  });

  it('a coin found only in the mempool goes to the core with the node\'s mark, which claims no age, as before', () => {
    expect(daaForCore({ transactionId: 'a', blockDaaScore: 123n, confirmed: false })).toBe(UNACCEPTED_DAA_SCORE);
    expect(daaForCore({ transactionId: 'a', blockDaaScore: 123n, confirmed: true })).toBe(123n);
    expect(daaForCore({ transactionId: 'a', blockDaaScore: 0n })).toBe(0n);
    // The age a public entry claims on such a coin is 0, as on one the wallet gave no score (bridge/packages/protocol claimFor).
    expect(claimFor(base, 1_000_000n, UNACCEPTED_DAA_SCORE)).toBe(0n);
    expect(claimFor(base, 1_000_000n, 0n)).toBe(0n);
    expect(claimFor({ ...base, windowRef: 200n * KAS, windowOut: 15n * KAS }, 1_000_000n, UNACCEPTED_DAA_SCORE)).toBeNull();
  });
});

describe('a wallet whose KAS is in many small coins', () => {
  it('with 12 coins of 1 KAS, a buy that needs more than the 6 largest is told to merge them, and nothing is sent', async () => {
    const { node, ctx } = scenario(Array(12).fill(KAS));
    const kasIn = 5n * KAS; // with the 1.5 KAS its new token holds and the fee: more than 6 KAS
    const quoted = quoteBuy(ctx, base, kasIn);
    const e = await swap(ctx, signerFor(alice), [alice.address], { side: 'buy', amountIn: kasIn, minOut: 1n, quoted }).catch(x => x);
    expect(e).toBeInstanceOf(MergeCoinsFirst);
    expect(isMergeCoinsFirst(e)).toBe(true);
    expect(e).toMatchObject({ cap: 6, coins: 12 });
    expect(e.message).toMatch(/Your KAS is in 12 coins, and the 6 largest are not enough for this: a pool transaction takes at most 8 inputs, 2 of them the pool's own\. Merge your KAS first: send all of it to your own address/);
    expect(e.message).toMatch(/Nothing was sent\.$/);
    expect(e.message).not.toMatch(new RegExp(String.fromCharCode(0x2014)));
    expect(node.submitted).toHaveLength(0);
  });

  it('a deposit takes at most 5 of them, and is told to merge them the same way', async () => {
    const { node, ctx } = scenario(Array(12).fill(KAS));
    const used = trimToShares(base, 5n * KAS, 500_000n);
    const shares = quoteAdd(ctx, base, used.kasIn, used.tokensIn);
    const e = await addLiquidity(ctx, signerFor(alice), [alice.address], { kasIn: 5n * KAS, tokensIn: 500_000n, minShares: shares, quoted: shares }).catch(x => x);
    expect(e).toBeInstanceOf(MergeCoinsFirst);
    expect(e).toMatchObject({ cap: 5, coins: 12 });
    expect(e.message).toMatch(/at most 8 inputs, 3 of them the pool's own/);
    expect(node.submitted).toHaveLength(0);
  });

  it('a buy that the 6 largest pay for builds with 8 inputs in all; fewer coins than that build as before', async () => {
    const { node, ctx } = scenario(Array(12).fill(KAS));
    const kasIn = 4n * KAS; // 5.5 KAS and the fee: 6 coins
    const r = await swap(ctx, signerFor(alice), [alice.address], { side: 'buy', amountIn: kasIn, minOut: 1n, quoted: quoteBuy(ctx, base, kasIn) });
    expect(r.txid).toBe(lastBuilt.txid);
    expect(inputsOfLast()).toHaveLength(MAX_TX_INPUTS);
    expect(node.submitted).toHaveLength(1);
  });

  it('not enough KAS in all is still "not enough KAS", not a merge', async () => {
    const { node, ctx } = scenario(Array(4).fill(KAS));
    const kasIn = 5n * KAS;
    await expect(swap(ctx, signerFor(alice), [alice.address], { side: 'buy', amountIn: kasIn, minOut: 1n, quoted: quoteBuy(ctx, base, kasIn) }))
      .rejects.toThrow(/Not enough KAS for this transaction and its network fee/);
    expect(node.submitted).toHaveLength(0);
  });
});

describe('the honest cases still build', () => {
  for (const [kasIn, coins] of [[KAS, 1], [2n * KAS, 2], [4n * KAS, 3]] as const) {
    it(`a buy of ${kasIn / KAS} KAS funded by ${coins} coin${coins > 1 ? 's' : ''}`, async () => {
      const { node, ctx } = scenario([3n * KAS, 2n * KAS, 2n * KAS]);
      const r = await swap(ctx, signerFor(alice), [alice.address], { side: 'buy', amountIn: kasIn, minOut: 1n, quoted: quoteBuy(ctx, base, kasIn) });
      expect(r.txid).toBe(lastBuilt.txid);
      const inputs = inputsOfLast();
      expect(inputs).toHaveLength(2 + coins);
      // Every input but the pool's (the first) asks no age.
      expect(inputs.slice(1).every(i => BigInt(i.sequence as string | number) === 0n)).toBe(true);
      expect(node.submitted).toHaveLength(1);
    });
  }

  it('a sale funded by a coin builds', async () => {
    // A sell cap of 10 % of 200 KAS, none of it used.
    const { node, ctx } = scenario([3n * KAS], { pool: { ...base, windowRef: 200n * KAS } });
    const r = await swap(ctx, signerFor(alice), [alice.address], { side: 'sell', amountIn: 1_000_000n, minOut: 20_000_000n, quoted: 1n });
    expect(r.txid).toBe(lastBuilt.txid);
    expect(inputsOfLast().length).toBeLessThanOrEqual(MAX_TX_INPUTS);
    expect(node.submitted).toHaveLength(1);
  });
});

describe('a coin only in the mempool', () => {
  it('a buy on a pool only in the mempool (a chain of pool spends at claim 0) hands the pool and its reserve to the core with the node\'s mark, and builds', async () => {
    const { node, ctx, poolTx, built } = scenario([10n * KAS], { where: 'mempool' });
    const kasIn = KAS;
    const r = await swap(ctx, signerFor(alice), [alice.address], { side: 'buy', amountIn: kasIn, minOut: 1n, quoted: quoteBuy(ctx, base, kasIn) });
    expect(r.txid).toBe(lastBuilt.txid);
    const req = built('pool-buy');
    expect(req.pool.utxo.blockDaaScore).toBe(UNACCEPTED_DAA_SCORE);
    expect(req.reserve.utxo.blockDaaScore).toBe(UNACCEPTED_DAA_SCORE);
    expect(req.pool.utxo.transactionId).toBe(poolTx);
    // The funding coin is from the UTXO set, with its own score; the pool's input claims nothing.
    expect(req.funding.every((f: any) => f.utxo.blockDaaScore === 10n)).toBe(true);
    expect(BigInt(inputsOfLast()[0].sequence as string | number)).toBe(0n);
    expect(node.submitted).toHaveLength(1);
  });

  it('a position only in the mempool that the pool coin\'s transaction did not make is not mixed in: the wallet says why, and nothing is sent', async () => {
    const shares = 10n * KAS;
    const { node, ctx } = scenario([3n * KAS], { positions: (ctx, node) => [placePosition(node, ctx, uniq('7'), 1, shares, 'mempool')] });
    const id = `${(await ctx.api!.positions(alice.xonly)).positions[0].utxo.transactionId}:1`;
    const q = quoteRemove(ctx, base, shares);
    const e = await removeLiquidity(ctx, signerFor(alice), [alice.address], { position: id, minKas: q.kasOut, minTokens: q.tokensOut, quoted: q }).catch(x => x);
    expect(e).toBeInstanceOf(NotInBlockYet);
    expect(e.message).toMatch(/The deposit that made this position is not in a block yet.*Nothing was sent; try again in a moment\./);
    expect(node.submitted).toHaveLength(0);
  });

  it('a position only in the mempool made with the pool coin (a deposit just sent, then its withdrawal) builds, marked', async () => {
    const shares = 10n * KAS;
    const { node, ctx, poolTx, built } = scenario([3n * KAS], { where: 'mempool', positions: (ctx, node, poolTx) => [placePosition(node, ctx, poolTx, 2, shares, 'mempool')] });
    const q = quoteRemove(ctx, base, shares);
    const r = await removeLiquidity(ctx, signerFor(alice), [alice.address], { position: `${poolTx}:2`, minKas: q.kasOut, minTokens: q.tokensOut, quoted: q });
    expect(r.txid).toBe(lastBuilt.txid);
    const req = built('pool-remove');
    expect(req.position.utxo.blockDaaScore).toBe(UNACCEPTED_DAA_SCORE);
    expect(req.pool.utxo.blockDaaScore).toBe(UNACCEPTED_DAA_SCORE);
    expect(node.submitted).toHaveLength(1);
  });

  it('a confirmed position on a confirmed pool goes with the scores the node gave them, as before', async () => {
    const shares = 10n * KAS;
    const { node, ctx, built } = scenario([3n * KAS], { positions: (ctx, node) => [placePosition(node, ctx, uniq('8'), 1, shares, 'utxo')] });
    const id = `${(await ctx.api!.positions(alice.xonly)).positions[0].utxo.transactionId}:1`;
    const q = quoteRemove(ctx, base, shares);
    await removeLiquidity(ctx, signerFor(alice), [alice.address], { position: id, minKas: q.kasOut, minTokens: q.tokensOut, quoted: q });
    const req = built('pool-remove');
    expect(req.position.utxo.blockDaaScore).toBe(999_000n);
    expect(req.pool.utxo.blockDaaScore).toBe(999_000n);
    expect(node.submitted).toHaveLength(1);
  });
});

describe('funding coins', () => {
  it('are plain Schnorr P2PK coins only: another kind at the wallet\'s address is never chosen', async () => {
    const node = new FakeNode();
    const ctx = testCtx(node);
    const good = kasCoin(alice, uniq('f'), 2n * KAS);
    const ecdsa = { ...kasCoin(alice, uniq('f'), 5n * KAS), scriptPublicKey: `000021${'02' + alice.xonly}ab` };
    node.utxoSet.push(good, ecdsa);
    const coins = await kasCoins(ctx, [alice.address]);
    expect(coins.map(c => c.utxo.transactionId)).toEqual([good.transactionId]);
  });
});
