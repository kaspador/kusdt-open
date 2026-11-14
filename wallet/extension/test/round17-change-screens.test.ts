// Round 17, R17-CL-1, on the Swap screen: Max says it keeps 0.3 KAS for the network fee, and now the fee row says so
// too (up to that much goes to the network when what it leaves is too small to come back as change), and the swap is
// sent with that fee. Another amount that would give change to the network is not sent, and the screen names the fee.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { button, cleanup, click, elements, field, mount, typeIn, until } from './fake-dom';
import { fixture, noNetwork, resetStores } from './screen-fixture';
import { COVENANT, POOL } from './helpers';
import { p2shAddressOf, scriptOf, reserveStateOf, poolValue } from '@/kusdt/verify';
import { POOL_WAIT } from '@/kusdt/pool';
import { NavContext, type Nav } from '@/popup/nav';
import { Swap } from '@/screens/Swap';
import type { PoolState } from '@/kusdt/types';

const h = vi.hoisted(() => ({ wallet: null as unknown }));
vi.mock('@/popup/state', () => ({ useWallet: () => h.wallet }));

POOL_WAIT.ms = 0;
POOL_WAIT.perDaaMs = 0;
const KAS = 100_000_000n;
const base: PoolState = { tokenCovid: COVENANT, kasReserve: 200n * KAS, tokenReserve: 20_000_000n, totalShares: 200n * KAS, protocolKas: 0n, protocolTokens: 0n, baseValue: KAS, admin: '11'.repeat(32), maxOutBps: 1_000n, windowLen: 36_000n, windowCredit: 0n, windowRef: 200n * KAS, windowOut: 0n, paused: false, guardian: '22'.repeat(32) };

const byTestId = (root: Parameters<typeof elements>[0], id: string) => elements(root).find(e => e.getAttribute('data-testid') === id);

beforeEach(async () => { await resetStores(); vi.stubGlobal('fetch', noNetwork); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

/** The fixture's wallet (one coin of 10 KAS) beside a pool, on the Swap screen, its node at `feerate`. `tag`: two hex digits. */
async function swapScreen(tag: string, feerate = 100) {
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
  const nav: Nav = { tab: 'swap', setTab() {}, push() {}, back() {}, lock() {} };
  const { root } = await mount(createElement(NavContext.Provider, { value: nav }, createElement(Swap)));
  await until('the pool and the fee', () => root.textContent.includes('1 kUSDT =') && !!byTestId(root, 'pool-fee')?.textContent?.includes('about'));
  return { fx, root };
}

describe('R17-CL-1: the Swap screen', () => {
  it('Max: the fee row says up to what Max keeps for the fee, and the swap is sent', async () => {
    const { fx, root } = await swapScreen('b1');
    await click(button(root, 'Max'));
    expect(field(root, 'You pay').value).toBe('8.2');
    expect(byTestId(root, 'pool-fee')!.textContent).toBe('up to 0.3 KAS (Max keeps it for the fee)');
    await until('the swap button', () => !button(root, 'Swap KAS for kUSDT').disabled);
    await click(button(root, 'Swap KAS for kUSDT'));
    await until('the answer', () => root.textContent.includes('Swap sent') || root.textContent.includes('Swapped') || root.textContent.includes('Nothing was sent'));
    expect(fx.node.submitted).toHaveLength(1);
  });

  it('a little less than Max, whose change would go to the network: nothing is sent, and the fee is named', async () => {
    // At 200 sompi a gram the core keeps change only from about 0.4 KAS: 8.15 KAS leaves 0.35.
    const { fx, root } = await swapScreen('b2', 200);
    await typeIn(field(root, 'You pay'), '8.15');
    expect(byTestId(root, 'pool-fee')!.textContent).toBe('about 0.16 KAS');
    await until('the swap button', () => !button(root, 'Swap KAS for kUSDT').disabled);
    await click(button(root, 'Swap KAS for kUSDT'));
    await until('the answer', () => root.textContent.includes('Nothing was sent') || root.textContent.includes('Swap sent') || root.textContent.includes('Swapped'));
    expect(root.textContent).toMatch(/This would pay 0\.35 KAS to the network, not the about 0\.16 KAS shown: 0\.2\d* KAS of it is change too small for the network to keep\./);
    expect(fx.node.submitted).toHaveLength(0);
  });
});
