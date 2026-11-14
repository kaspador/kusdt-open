// Round 18, R18-CL-2 (info; an incomplete carry-over of R17-CL-1). The web app's Swap page computes Max as the wallet's
// own Swap screen does, keeping 0.3 KAS (FEE_KEEP) for the network fee, but the approval window passed no fee to the
// swap: with the feerate between about 125 and 300 sompi a gram, the change such a buy leaves is too small for the
// network to keep, and the build was refused at every try (PoolFeeTakesChange). The window now works out from the
// wallet's own coins whether a site's buy is a Max buy, says "up to 0.3 KAS (Max keeps it for the fee)", and lets it
// pay that. Any other amount is held to the fee shown, as before.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { button, cleanup, click, elements, fakeWindow, mount, until } from './fake-dom';
import { fixture, noNetwork, resetStores } from './screen-fixture';
import { COVENANT, POOL } from './helpers';
import { p2shAddressOf, scriptOf, reserveStateOf, poolValue } from '@/kusdt/verify';
import { FEE_KEEP, POOL_WAIT, maxBuyAcceptedFee, maxKasIn } from '@/kusdt/pool';
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
  await resetStores();
  vi.stubGlobal('fetch', noNetwork);
  vi.stubGlobal('chrome', { tabs: { sendMessage: (_t: number, _m: unknown, cb?: () => void) => cb?.() }, runtime: {} });
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

/** The fixture's wallet (one coin of 10 KAS) beside a pool, its node at `feerate`, and a site's buy of `amountIn` in the window. */
async function windowFor(tag: string, amountIn: bigint, feerate: number) {
  let answer: any = null;
  const fx = fixture(tag, { api: { pool: async () => answer } });
  fx.node.feerate = async () => feerate;
  const pspk = scriptOf(fx.ctx, 'Pool', base), reserve = reserveStateOf(POOL, base), rspk = scriptOf(fx.ctx, 'KCC20', reserve);
  const txid = `${tag}f`.padEnd(64, '0');
  fx.node.utxoSet.push(
    { address: p2shAddressOf(pspk, 'kaspasim'), transactionId: txid, index: 0, amount: poolValue(base), scriptPublicKey: pspk, blockDaaScore: 999_000n, isCoinbase: false, covenantId: POOL },
    { address: p2shAddressOf(rspk, 'kaspasim'), transactionId: txid, index: 1, amount: 150_000_000n, scriptPublicKey: rspk, blockDaaScore: 999_000n, isCoinbase: false, covenantId: COVENANT },
  );
  answer = { pool: { utxo: { transactionId: txid, index: 0 }, state: base }, reserve: { utxo: { transactionId: txid, index: 1 }, state: reserve } };
  h.wallet = fx.wallet;
  const id = `window-r18cl2-${tag}`;
  const params = { method: 'kusdt_swap', side: 'buy', amountIn: amountIn.toString(), minOut: '1' } as PendingRequest['params'];
  await session.set({ [REQUEST_KEY]: { id, method: params.method, params, origin: 'https://page.example', tabId: 7, at: 1, network: 'simnet' } as PendingRequest });
  fakeWindow.location.hash = `#request=${id}`;
  const { root } = await mount(createElement(Approve));
  await until('Approve', () => button(root, 'Approve'));
  await until('Approve to arm', () => !button(root, 'Approve').disabled, ARM_MS + 3_000);
  return { fx, root };
}
const feeRow = (root: Awaited<ReturnType<typeof mount>>['root']) => elements(root).map(e => e.textContent ?? '').find(t => t.startsWith('Network fee') && t.length < 80);

describe('R18-CL-2: a site\'s Max buy through the approval window', () => {
  it('the rule: a buy of the Max or more may pay FEE_KEEP; less, a sell or an unknown balance may not', () => {
    const cfg = { config: { tokenValue: '150000000', positionValue: '200000000' } } as any;
    const spendable = 10n * KAS, max = maxKasIn(cfg, 'buy', spendable);
    expect(max).toBe(820_000_000n);
    expect(maxBuyAcceptedFee(cfg, 'buy', max, spendable)).toBe(FEE_KEEP);
    expect(maxBuyAcceptedFee(cfg, 'buy', max + 1n, spendable)).toBe(FEE_KEEP);
    expect(maxBuyAcceptedFee(cfg, 'buy', max - 1n, spendable)).toBeUndefined();
    expect(maxBuyAcceptedFee(cfg, 'sell', max, spendable)).toBeUndefined();
    expect(maxBuyAcceptedFee(cfg, 'buy', max, null)).toBeUndefined();
    expect(maxBuyAcceptedFee(cfg, 'buy', 0n, FEE_KEEP)).toBeUndefined();
  });

  it('at 200 sompi a gram, the site\'s Max (8.2 of 10 KAS): the window says up to 0.3 KAS, and the swap is sent', async () => {
    const { fx, root } = await windowFor('c1', 820_000_000n, 200);
    expect(feeRow(root)).toContain('up to 0.3 KAS (Max keeps it for the fee)');
    await click(button(root, 'Approve'));
    await until('the answer', () => fx.node.submitted.length > 0 || root.textContent.includes('Nothing was sent') || root.textContent.includes('Done'));
    expect(fx.node.submitted).toHaveLength(1);
  });

  it('a little less than Max, whose change would go to the network: still held to the fee shown, nothing is sent', async () => {
    const { fx, root } = await windowFor('c2', 815_000_000n, 200);
    expect(feeRow(root)).toContain('about 0.16 KAS');
    await click(button(root, 'Approve'));
    await until('the answer', () => fx.node.submitted.length > 0 || root.textContent.includes('Nothing was sent') || root.textContent.includes('Done'));
    expect(fx.node.submitted).toHaveLength(0);
    expect(root.textContent).toMatch(/change too small for the network to keep/);
  });
});
