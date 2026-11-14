// Outside review of rc.22 (run 20), PUB20-1: a site's add-liquidity, and the wallet's own Pool screen, showed the
// amounts trimmed to the pool's ratio, but on Approve passed the untrimmed amounts, trimmed again on the newest pool.
// A pool that moved in between then took more of one side than was shown, for the same shares, without asking again.
// Now the shown amounts are what is passed: a moved pool gives fewer shares for them, and the wallet asks again
// (QuoteChanged); nothing above what was shown goes in.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { button, cleanup, click, elements, fakeWindow, field, mount, typeIn, until } from './fake-dom';
import { fixture, noNetwork, resetStores, type Fixture } from './screen-fixture';
import { COVENANT, POOL } from './helpers';
import { p2shAddressOf, scriptOf, reserveStateOf, poolValue } from '@/kusdt/verify';
import { POOL_WAIT, quoteBuy } from '@/kusdt/pool';
import { session } from '@/lib/storage';
import { REQUEST_KEY, type PendingRequest } from '@/provider/protocol';
import { NavContext, type Nav } from '@/popup/nav';
import { Approve, ARM_MS } from '@/screens/Approve';
import { PoolTab } from '@/screens/Pool';
import type { PoolState } from '@/kusdt/types';

const h = vi.hoisted(() => ({ wallet: null as unknown }));
vi.mock('@/popup/state', () => ({ useWallet: () => h.wallet }));

POOL_WAIT.ms = 0;
POOL_WAIT.perDaaMs = 0;
const KAS = 100_000_000n;
// The reviewer's pool: 200 KAS / 20 kUSDT.
const base: PoolState = { tokenCovid: COVENANT, kasReserve: 200n * KAS, tokenReserve: 20_000_000n, totalShares: 200n * KAS, protocolKas: 0n, protocolTokens: 0n, baseValue: KAS, admin: '11'.repeat(32), maxOutBps: 1_000n, windowLen: 36_000n, windowCredit: 0n, windowRef: 200n * KAS, windowOut: 0n, paused: false, guardian: '22'.repeat(32) };

beforeEach(async () => { await resetStores(); vi.stubGlobal('fetch', noNetwork); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

/** The fixture's wallet with 3 kUSDT and 110 KAS beside the pool; `move(state)` puts a new pool state in its place. */
function scene(tag: string) {
  let answer: any = null;
  const fx = fixture(tag, { tokens: [3_000_000n], api: { pool: async () => answer } });
  const coin = fx.node.utxoSet.find(u => `${u.transactionId}:${u.index}` === fx.kasOutpoint)!;
  fx.node.utxoSet.push({ ...coin, transactionId: `${tag}a`.padEnd(64, '0'), amount: 100n * KAS });
  fx.wallet.balances = { ...fx.wallet.balances!, kas: 110n * KAS, kasSpendable: 110n * KAS };
  let n = 0;
  const place = (state: PoolState) => {
    const txid = `${tag}f${++n}`.padEnd(64, '0');
    // The pool before is spent by the one after.
    fx.node.utxoSet = fx.node.utxoSet.filter(u => !u.transactionId.startsWith(`${tag}f`));
    const pspk = scriptOf(fx.ctx, 'Pool', state), reserve = reserveStateOf(POOL, state), rspk = scriptOf(fx.ctx, 'KCC20', reserve);
    fx.node.utxoSet.push(
      { address: p2shAddressOf(pspk, 'kaspasim'), transactionId: txid, index: 0, amount: poolValue(state), scriptPublicKey: pspk, blockDaaScore: 999_000n, isCoinbase: false, covenantId: POOL },
      { address: p2shAddressOf(rspk, 'kaspasim'), transactionId: txid, index: 1, amount: 150_000_000n, scriptPublicKey: rspk, blockDaaScore: 999_000n, isCoinbase: false, covenantId: COVENANT },
    );
    answer = { pool: { utxo: { transactionId: txid, index: 0 }, state }, reserve: { utxo: { transactionId: txid, index: 1 }, state: reserve } };
  };
  place(base);
  // What each deposit the wallet builds puts in.
  const built: { kasIn: bigint; tokensIn: bigint; shares: bigint }[] = [];
  const call = fx.ctx.core.call.bind(fx.ctx.core);
  fx.ctx.core = { ...fx.ctx.core, call: ((command: string, request: any) => {
    if (command === 'pool-add') built.push({ kasIn: BigInt(request.kasIn), tokensIn: BigInt(request.tokensIn), shares: BigInt(request.shares) });
    return call(command, request);
  }) as typeof fx.ctx.core.call };
  h.wallet = fx.wallet;
  return { fx, place, built };
}

/** The pool after someone bought kUSDT with `kas` KAS (the protocol's cut left out: it does not change the point). */
function afterBuy(ctx: Fixture['ctx'], kas: bigint): PoolState {
  const out = quoteBuy(ctx, base, kas * KAS);
  return { ...base, kasReserve: base.kasReserve + kas * KAS, tokenReserve: base.tokenReserve - out };
}

type Built = { kasIn: bigint; tokensIn: bigint; shares: bigint }[];
/** Every deposit the wallet built put in at most the 20 KAS + 2 kUSDT shown. */
function noMoreThanShown(built: Built) {
  for (const b of built) {
    expect(b.kasIn).toBeLessThanOrEqual(20n * KAS);
    expect(b.tokensIn).toBeLessThanOrEqual(2_000_000n);
  }
}

async function armed(root: Awaited<ReturnType<typeof mount>>['root']) {
  await until('Approve', () => button(root, 'Approve'));
  await until('Approve to arm', () => !button(root, 'Approve').disabled, ARM_MS + 3_000);
}

describe('PUB20-1: a site asks to add 21 KAS + 2 kUSDT to a 200 KAS / 20 kUSDT pool', () => {
  beforeEach(() => { vi.stubGlobal('chrome', { tabs: { sendMessage: (_t: number, _m: unknown, cb?: () => void) => cb?.() }, runtime: {} }); });

  async function windowFor(tag: string) {
    const s = scene(tag);
    const id = `window-pub20-1-${tag}`;
    const params = { method: 'kusdt_addLiquidity', kasIn: (21n * KAS).toString(), tokensIn: '2000000' } as PendingRequest['params'];
    await session.set({ [REQUEST_KEY]: { id, method: params.method, params, origin: 'https://page.example', tabId: 7, at: 1, network: 'simnet' } as PendingRequest });
    fakeWindow.location.hash = `#request=${id}`;
    const { root } = await mount(createElement(Approve));
    await armed(root);
    // The window shows what the shares need, at the pool's ratio: 20 KAS + 2 kUSDT.
    expect(root.textContent).toContain('Add20 KAS + 2 kUSDT');
    expect(root.textContent).toContain('The site asked21 KAS + 2 kUSDT');
    return { ...s, root };
  }

  it("the reviewer's case, a 10 KAS buy lands before Approve: nothing above what was shown goes in", async () => {
    const { fx, place, built, root } = await windowFor('e0');
    place(afterBuy(fx.ctx, 10n));
    await click(button(root, 'Approve'));
    await until('the answer', () => root.textContent.includes('Nothing was sent') || fx.node.submitted.length > 0);
    // Before the fix: 21 KAS + 1.904762 kUSDT went in for the 2 000 000 000 shares shown, without asking. Now the 20 KAS
    // + 2 kUSDT shown are about 10 % off the moved pool's ratio, past the 5 % the wallet adds at: refused, nothing sent.
    noMoreThanShown(built);
    expect(fx.node.submitted).toHaveLength(0);
    expect(root.textContent).toContain("more than 5 % off the pool's ratio");
  });

  it('a 1 KAS buy lands before Approve: nothing above what was shown goes in, and the wallet asks again', async () => {
    const { fx, place, built, root } = await windowFor('e1');
    place(afterBuy(fx.ctx, 1n));
    await click(button(root, 'Approve'));
    await until('the answer', () => root.textContent.includes('New shares') || root.textContent.includes('Done') || root.textContent.includes('Nothing was sent') || fx.node.submitted.length > 0);
    // Before the fix: about 20.2 KAS + 2 kUSDT went in, for more shares than shown, without asking.
    noMoreThanShown(built);
    expect(fx.node.submitted).toHaveLength(0);
    expect(root.textContent).toContain('New shares');
    expect(root.textContent).toContain('Add at most20 KAS + 2 kUSDT');
    // Approved at the new quote, the deposit is still at most what was shown.
    await armed(root);
    await click(button(root, 'Approve'));
    await until('the deposit', () => fx.node.submitted.length > 0 || root.textContent.includes('Nothing was sent'));
    expect(fx.node.submitted).toHaveLength(1);
    const sent = built[built.length - 1];
    expect(sent.kasIn).toBeLessThanOrEqual(20n * KAS);
    expect(sent.tokensIn).toBeLessThanOrEqual(2_000_000n);
    expect(sent.shares).toBeLessThan(20n * KAS);
  });

  it('the pool did not move: the deposit is the one shown, sent at once, for the shares shown', async () => {
    const { fx, built, root } = await windowFor('e2');
    await click(button(root, 'Approve'));
    await until('the deposit', () => fx.node.submitted.length > 0 || root.textContent.includes('Nothing was sent'));
    expect(fx.node.submitted).toHaveLength(1);
    expect(built[built.length - 1]).toEqual({ kasIn: 20n * KAS, tokensIn: 2_000_000n, shares: 20n * KAS });
    expect(root.textContent).not.toContain('New shares');
  });
});

describe("PUB20-1: the wallet's own Pool screen, 21 KAS + 2 kUSDT typed in", () => {
  async function screen(tag: string) {
    const s = scene(tag);
    const nav: Nav = { tab: 'pool', setTab() {}, push() {}, back() {}, lock() {} };
    const { root } = await mount(createElement(NavContext.Provider, { value: nav }, createElement(PoolTab)));
    await until('the pool', () => root.textContent.includes('KAS reserve'));
    await click(button(root, 'Add liquidity'));
    await typeIn(field(root, 'KAS'), '21');
    await typeIn(field(root, 'kUSDT'), '2');
    const used = () => elements(root).find(e => e.getAttribute('data-testid') === 'add-used')?.textContent;
    await until('the shares', () => used() === '20 KAS + 2 kUSDT' && !button(root, 'Add').disabled);
    return { ...s, root };
  }

  it('a 10 KAS buy lands before Add: nothing above what "Puts in" showed goes in (refused: the pool moved too far)', async () => {
    const { fx, place, built, root } = await screen('e5');
    place(afterBuy(fx.ctx, 10n));
    await click(button(root, 'Add'));
    await until('the answer', () => root.textContent.includes('Nothing was sent') || fx.node.submitted.length > 0);
    noMoreThanShown(built);
    expect(fx.node.submitted).toHaveLength(0);
  });

  it('a 1 KAS buy lands before Add: nothing above what "Puts in" showed goes in, and the screen asks again', async () => {
    const { fx, place, built, root } = await screen('e3');
    place(afterBuy(fx.ctx, 1n));
    await click(button(root, 'Add'));
    await until('the answer', () => root.textContent.includes('Add at the new quote') || fx.node.submitted.length > 0 || root.textContent.includes('Nothing was sent'));
    noMoreThanShown(built);
    expect(fx.node.submitted).toHaveLength(0);
    await click(button(root, 'Add at the new quote'));
    await until('the deposit', () => fx.node.submitted.length > 0 || root.textContent.includes('Nothing was sent'));
    expect(fx.node.submitted).toHaveLength(1);
    const sent = built[built.length - 1];
    expect(sent.kasIn).toBeLessThanOrEqual(20n * KAS);
    expect(sent.tokensIn).toBeLessThanOrEqual(2_000_000n);
  });

  it('the pool did not move: the deposit is what "Puts in" showed, for the shares shown', async () => {
    const { fx, built, root } = await screen('e4');
    await click(button(root, 'Add'));
    await until('the deposit', () => fx.node.submitted.length > 0 || root.textContent.includes('Nothing was sent'));
    expect(fx.node.submitted).toHaveLength(1);
    expect(built[built.length - 1]).toEqual({ kasIn: 20n * KAS, tokensIn: 2_000_000n, shares: 20n * KAS });
  });
});
