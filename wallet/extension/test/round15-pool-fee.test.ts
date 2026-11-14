// Round 15, R15-CL-3: a pool request showed no network fee. A node naming a
// feerate of 2000 (the wallet's clamp) had a swap or a deposit pay about 1.3 KAS
// unseen, more than a small swap is worth. Now about what it pays is shown
// before it is approved (poolFeeAbout), a build at a feerate above half as much
// again as the one shown is not sent, and a fee that is a large share of the
// KAS moved is warned about.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { FakeNode, COVENANT, POOL, devKey, fakeApi, testCtx, signerFor, kasCoin, lastBuilt } from './helpers';
import { cleanup, fakeWindow, mount, until } from './fake-dom';
import { fixture, noNetwork, resetStores } from './screen-fixture';
import { p2shAddressOf, scriptOf, reserveStateOf, poolValue } from '@/kusdt/verify';
import { POOL_FEE_MASS, POOL_WAIT, PoolFeeAboveShown, addLiquidity, feerateCap, poolFeeAbout, poolFeeShareText, quoteAdd, quoteBuy, quoteSell, swap, trimToShares } from '@/kusdt/pool';
import { plainState } from '@/kusdt/owner';
import { session } from '@/lib/storage';
import { REQUEST_KEY, type PendingRequest } from '@/provider/protocol';
import { Approve } from '@/screens/Approve';
import type { PoolState } from '@/kusdt/types';

const h = vi.hoisted(() => ({ wallet: null as unknown }));
vi.mock('@/popup/state', () => ({ useWallet: () => h.wallet }));

const alice = devKey('alice');
POOL_WAIT.ms = 0;
POOL_WAIT.perDaaMs = 0;
const KAS = 100_000_000n;
const base: PoolState = { tokenCovid: COVENANT, kasReserve: 200n * KAS, tokenReserve: 20_000_000n, totalShares: 200n * KAS, protocolKas: 0n, protocolTokens: 0n, baseValue: KAS, admin: '11'.repeat(32), maxOutBps: 1_000n, windowLen: 36_000n, windowCredit: 0n, windowRef: 200n * KAS, windowOut: 0n, paused: false, guardian: '22'.repeat(32) };

function placePool(node: FakeNode, ctx: ReturnType<typeof testCtx>, txid: string, pool: PoolState) {
  const pspk = scriptOf(ctx, 'Pool', pool);
  node.utxoSet.push({ address: p2shAddressOf(pspk, 'kaspasim'), transactionId: txid, index: 0, amount: poolValue(pool), scriptPublicKey: pspk, blockDaaScore: 999_990n, isCoinbase: false, covenantId: POOL });
  const reserve = reserveStateOf(POOL, pool);
  const rspk = scriptOf(ctx, 'KCC20', reserve);
  node.utxoSet.push({ address: p2shAddressOf(rspk, 'kaspasim'), transactionId: txid, index: 1, amount: 150_000_000n, scriptPublicKey: rspk, blockDaaScore: 1n, isCoinbase: false, covenantId: COVENANT });
  return { pool: { utxo: { transactionId: txid, index: 0 }, state: pool }, reserve: { utxo: { transactionId: txid, index: 1 }, state: reserve } };
}

let n = 0;
const uniq = (c: string) => (++n).toString(16).padStart(64, c);
/** A pool, two coins of 1 000 KAS and a kUSDT state of 3 kUSDT for alice; `feerates` is what the node names, in turn (the last one after). */
function scenario(feerates: number[] = [100]) {
  const node = new FakeNode();
  const listed: any[] = [];
  let answer: any = null;
  const ctx = testCtx(node, fakeApi({ pool: async () => answer, tokens: async () => ({ states: listed }) }));
  answer = placePool(node, ctx, uniq('1'), base);
  node.utxoSet.push(kasCoin(alice, uniq('e'), 1_000n * KAS), kasCoin(alice, uniq('e'), 1_000n * KAS));
  const state = plainState({ ownerScheme: 0, owner: alice.xonly }, 3_000_000n);
  const spk = scriptOf(ctx, 'KCC20', state);
  const txid = uniq('d');
  node.utxoSet.push({ address: p2shAddressOf(spk, 'kaspasim'), transactionId: txid, index: 0, amount: 150_000_000n, scriptPublicKey: spk, blockDaaScore: 5n, isCoinbase: false, covenantId: COVENANT });
  listed.push({ utxo: { transactionId: txid, index: 0 }, state: { ...state, amount: '3000000' } });
  let i = 0;
  node.feerate = async () => feerates[Math.min(i++, feerates.length - 1)];
  return { node, ctx };
}

describe('the network fee a pool transaction is shown with', () => {
  it('is counted at a mass every swap and deposit fits under', async () => {
    const masses: string[] = [];
    for (const run of [
      async (ctx: ReturnType<typeof testCtx>) => swap(ctx, signerFor(alice), [alice.address], { side: 'buy', amountIn: KAS, minOut: 1n, quoted: quoteBuy(ctx, base, KAS) }),
      async (ctx: ReturnType<typeof testCtx>) => swap(ctx, signerFor(alice), [alice.address], { side: 'sell', amountIn: 1_000_000n, minOut: 20_000_000n, quoted: quoteSell(ctx, base, 1_000_000n) }),
      async (ctx: ReturnType<typeof testCtx>) => {
        const used = trimToShares(base, KAS, 100_000n);
        const shares = quoteAdd(ctx, base, used.kasIn, used.tokensIn);
        return addLiquidity(ctx, signerFor(alice), [alice.address], { kasIn: KAS, tokensIn: 100_000n, minShares: shares, quoted: shares });
      },
    ]) {
      const { ctx } = scenario();
      const r = await run(ctx);
      masses.push(`${lastBuilt.command} ${r.built.mass.feeMass} compute ${r.built.mass.compute} storage ${r.built.mass.storage} inputs ${(r.built.transaction as any).inputs?.length}`);
      if (r.built.mass.feeMass > POOL_FEE_MASS) throw new Error(masses.join('; '));
      expect(r.built.fee).toBeLessThanOrEqual(poolFeeAbout(100));
    }
    // 80 000 grams at 100 sompi a gram: 0.08 KAS. At the clamp of 2000: 1.6 KAS.
    expect(poolFeeAbout(100)).toBe(8_000_000n);
    expect(poolFeeAbout(2_000)).toBe(160_000_000n);
    expect(feerateCap(100)).toBe(150);
    expect(feerateCap(101)).toBe(152);
  });

  it('binds: a node naming a feerate at the build above half as much again as the one shown sends nothing', async () => {
    // Shown at 100; the build reads 2000 (each try of withFreshPool reads the feerate again).
    const buy = scenario([2_000]);
    const quoted = quoteBuy(buy.ctx, base, KAS);
    await expect(swap(buy.ctx, signerFor(alice), [alice.address], { side: 'buy', amountIn: KAS, minOut: 1n, quoted, shownFeerate: 100 }))
      .rejects.toBeInstanceOf(PoolFeeAboveShown);
    expect(buy.node.submitted).toHaveLength(0);
    const add = scenario([2_000]);
    const used = trimToShares(base, KAS, 100_000n);
    const shares = quoteAdd(add.ctx, base, used.kasIn, used.tokensIn);
    await expect(addLiquidity(add.ctx, signerFor(alice), [alice.address], { kasIn: KAS, tokensIn: 100_000n, minShares: shares, quoted: shares, shownFeerate: 100 }))
      .rejects.toThrow(/now asks 2000 sompi a gram .* the 100 shown \(about 1\.6 KAS now\), so nothing was sent/);
    expect(add.node.submitted).toHaveLength(0);
    // At half as much again as the feerate shown, it goes.
    const ok = scenario([150]);
    const r = await swap(ok.ctx, signerFor(alice), [alice.address], { side: 'buy', amountIn: KAS, minOut: 1n, quoted, shownFeerate: 100 });
    expect(r.txid).toBe(lastBuilt.txid);
  });

  it('is warned about when it is more than a tenth of the KAS moved', () => {
    expect(poolFeeShareText(poolFeeAbout(100), KAS)).toBeNull();
    expect(poolFeeShareText(poolFeeAbout(2_000), KAS)).toMatch(/about 1\.6 KAS, more than a tenth of the 1 KAS/);
    expect(poolFeeShareText(poolFeeAbout(2_000), KAS)).not.toMatch(new RegExp(String.fromCharCode(0x2014)));
  });
});

describe('a site asks for a swap', () => {
  beforeEach(async () => {
    await resetStores();
    vi.stubGlobal('fetch', noNetwork);
    vi.stubGlobal('chrome', { tabs: { sendMessage: (_t: number, _m: unknown, cb?: () => void) => cb?.() }, runtime: {} });
  });
  afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

  async function windowFor(feerate: number, params: PendingRequest['params'], tag: string) {
    let answer: any = null;
    const fx = fixture(tag, { api: { pool: async () => answer } });
    answer = placePool(fx.node, fx.ctx, uniq('7'), base);
    fx.node.feerate = async () => feerate;
    h.wallet = fx.wallet;
    const id = `window-r15cl3-${tag}`;
    await session.set({ [REQUEST_KEY]: { id, method: params.method, params, origin: 'https://page.example', tabId: 7, at: 1, network: 'simnet' } as PendingRequest });
    fakeWindow.location.hash = `#request=${id}`;
    const { root } = await mount(createElement(Approve));
    await until('the request to be prepared', () => root.textContent.includes('Minimum the site set') || root.textContent.includes('Shares'));
    return root;
  }

  it('shows about what it pays the network, and warns when that is a large share', async () => {
    const swapReq = { method: 'kusdt_swap', side: 'buy', amountIn: KAS.toString(), minOut: '1' } as PendingRequest['params'];
    const calm = await windowFor(100, swapReq, 'f1');
    expect(calm.textContent).toContain('Network fee');
    expect(calm.textContent).toContain('about 0.08 KAS');
    expect(calm.textContent).not.toContain('more than a tenth');
    cleanup();
    const busy = await windowFor(2_000, swapReq, 'f2');
    expect(busy.textContent).toContain('about 1.6 KAS');
    expect(busy.textContent).toContain('more than a tenth of the 1 KAS');
  });

  it('to add liquidity shows it too', async () => {
    const root = await windowFor(100, { method: 'kusdt_addLiquidity', kasIn: KAS.toString(), tokensIn: '100000' } as PendingRequest['params'], 'f3');
    expect(root.textContent).toContain('about 0.08 KAS');
  });
});
