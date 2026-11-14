// Run 21, R21-WALLET-2: a site's kusdt_swap buy was approved in a window showing Pay, the quote, the site's minimum and
// the network fee. The transaction signed then takes Pay, the network fee and the KAS the bought kUSDT carries (the
// deployment's tokenValue, 1.5 KAS), which stays the user's but goes with that kUSDT when it is sent on. The wallet's
// own Swap screen shows it ("Kept in your token"); the window did not. Now it does, as the Swap screen says it.
// The real approval window, over the real core and the screens' fixture (a fake node and coordinator).

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { button, cleanup, click, fakeWindow, mount, until } from './fake-dom';
import { fixture, noNetwork, resetStores } from './screen-fixture';
import { COVENANT, POOL } from './helpers';
import { p2shAddressOf, scriptOf, reserveStateOf, poolValue } from '@/kusdt/verify';
import { POOL_WAIT } from '@/kusdt/pool';
import { session } from '@/lib/storage';
import { REQUEST_KEY, type PendingRequest } from '@/provider/protocol';
import { Approve, ARM_MS } from '@/screens/Approve';
import type { PoolState } from '@/kusdt/types';

const h = vi.hoisted(() => ({ wallet: null as unknown }));
vi.mock('@/popup/state', () => ({ useWallet: () => h.wallet }));

POOL_WAIT.ms = 0;
POOL_WAIT.perDaaMs = 0;
const KAS = 100_000_000n;
const base: PoolState = { tokenCovid: COVENANT, kasReserve: 200n * KAS, tokenReserve: 20_000_000n, totalShares: 200n * KAS, protocolKas: 0n, protocolTokens: 0n, baseValue: KAS, admin: '11'.repeat(32), maxOutBps: 1_000n, windowLen: 36_000n, windowCredit: 0n, windowRef: 200n * KAS, windowOut: 0n, paused: false, guardian: '22'.repeat(32) };

beforeEach(async () => {
  await resetStores(); vi.stubGlobal('fetch', noNetwork);
  vi.stubGlobal('chrome', { tabs: { sendMessage: (_t: number, _m: unknown, cb?: () => void) => cb?.() }, runtime: {} });
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe('R21-WALLET-2: a site\'s buy shows the KAS the bought kUSDT carries', () => {
  it('the window shows "Kept in your token" with the deployment\'s 1.5 KAS, and the buy it signs carries exactly that', async () => {
    let answer: any = null;
    const fx = fixture('b1', { tokens: [3_000_000n], api: { pool: async () => answer } });
    const pspk = scriptOf(fx.ctx, 'Pool', base), reserve = reserveStateOf(POOL, base), rspk = scriptOf(fx.ctx, 'KCC20', reserve);
    const ptx = 'b1f'.padEnd(64, '0');
    fx.node.utxoSet.push(
      { address: p2shAddressOf(pspk, 'kaspasim'), transactionId: ptx, index: 0, amount: poolValue(base), scriptPublicKey: pspk, blockDaaScore: 999_000n, isCoinbase: false, covenantId: POOL },
      { address: p2shAddressOf(rspk, 'kaspasim'), transactionId: ptx, index: 1, amount: 150_000_000n, scriptPublicKey: rspk, blockDaaScore: 999_000n, isCoinbase: false, covenantId: COVENANT },
    );
    answer = { pool: { utxo: { transactionId: ptx, index: 0 }, state: base }, reserve: { utxo: { transactionId: ptx, index: 1 }, state: reserve } };
    const coin = fx.node.utxoSet.find(u => `${u.transactionId}:${u.index}` === fx.kasOutpoint)!;
    fx.node.utxoSet.push({ ...coin, transactionId: 'b1a'.padEnd(64, '0'), amount: 100n * KAS });
    h.wallet = fx.wallet;
    const id = 'window-run21-buy-b1';
    const params = { method: 'kusdt_swap', side: 'buy', amountIn: (10n * KAS).toString(), minOut: '1' } as PendingRequest['params'];
    await session.set({ [REQUEST_KEY]: { id, method: params.method, params, origin: 'https://page.example', tabId: 7, at: 1, network: 'simnet' } as PendingRequest });
    fakeWindow.location.hash = `#request=${id}`;
    const { root } = await mount(createElement(Approve));
    await until('Approve', () => button(root, 'Approve'));
    await until('Approve to arm', () => !button(root, 'Approve').disabled, ARM_MS + 3_000).catch((e) => { throw new Error(`${e.message}. Shown: ${root.textContent}`); });
    const shown = root.textContent as string;
    expect(fx.ctx.config.tokenValue).toBe('150000000');
    expect(shown).toContain('Pay10 KAS');
    expect(shown).toContain('Kept in your token1.5 KAS');
    await click(button(root, 'Approve'));
    await until('the buy', () => fx.node.submitted.length > 0);
    // The bought kUSDT's state is output 2: it carries the 1.5 KAS shown.
    expect(BigInt(JSON.parse(fx.node.submitted[0]).outputs[2].value)).toBe(150_000_000n);
  });

  it('a sale shows no new token\'s row: what it keeps is its change token\'s (run 21 round 2, R21-W2-3)', async () => {
    let answer: any = null;
    const fx = fixture('b2', { tokens: [3_000_000n], api: { pool: async () => answer } });
    const pspk = scriptOf(fx.ctx, 'Pool', base), reserve = reserveStateOf(POOL, base), rspk = scriptOf(fx.ctx, 'KCC20', reserve);
    const ptx = 'b2f'.padEnd(64, '0');
    fx.node.utxoSet.push(
      { address: p2shAddressOf(pspk, 'kaspasim'), transactionId: ptx, index: 0, amount: poolValue(base), scriptPublicKey: pspk, blockDaaScore: 999_000n, isCoinbase: false, covenantId: POOL },
      { address: p2shAddressOf(rspk, 'kaspasim'), transactionId: ptx, index: 1, amount: 150_000_000n, scriptPublicKey: rspk, blockDaaScore: 999_000n, isCoinbase: false, covenantId: COVENANT },
    );
    answer = { pool: { utxo: { transactionId: ptx, index: 0 }, state: base }, reserve: { utxo: { transactionId: ptx, index: 1 }, state: reserve } };
    h.wallet = fx.wallet;
    const id = 'window-run21-sell-b2';
    const params = { method: 'kusdt_swap', side: 'sell', amountIn: '1000000', minOut: '1' } as PendingRequest['params'];
    await session.set({ [REQUEST_KEY]: { id, method: params.method, params, origin: 'https://page.example', tabId: 7, at: 1, network: 'simnet' } as PendingRequest });
    fakeWindow.location.hash = `#request=${id}`;
    const { root } = await mount(createElement(Approve));
    await until('Approve', () => button(root, 'Approve'));
    expect(root.textContent).not.toContain('Kept in your token1.5 KAS');
    expect(root.textContent).toContain('Kept in your token (change)1.5 KAS');
  });
});
