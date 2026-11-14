// rc.22's input cap on the wallet's screens: a swap that finds the KAS in more coins than a pool transaction takes
// says so, and offers the merge the wallet already has (Send, as a send of all the KAS to the wallet's own address,
// reviewed before anything is signed).

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { button, cleanup, click, field, mount, typeIn, until } from './fake-dom';
import { fixture, noNetwork, resetStores } from './screen-fixture';
import { COVENANT, POOL } from './helpers';
import { p2shAddressOf, scriptOf, reserveStateOf, poolValue } from '@/kusdt/verify';
import { POOL_WAIT } from '@/kusdt/pool';
import { NavContext, type Nav } from '@/popup/nav';
import { Swap } from '@/screens/Swap';
import { MERGE_NOTE, Send } from '@/screens/Send';
import type { PoolState } from '@/kusdt/types';

const h = vi.hoisted(() => ({ wallet: null as unknown }));
vi.mock('@/popup/state', () => ({ useWallet: () => h.wallet }));

POOL_WAIT.ms = 0;
POOL_WAIT.perDaaMs = 0;
const KAS = 100_000_000n;
const base: PoolState = { tokenCovid: COVENANT, kasReserve: 200n * KAS, tokenReserve: 20_000_000n, totalShares: 200n * KAS, protocolKas: 0n, protocolTokens: 0n, baseValue: KAS, admin: '11'.repeat(32), maxOutBps: 1_000n, windowLen: 36_000n, windowCredit: 0n, windowRef: 200n * KAS, windowOut: 0n, paused: false, guardian: '22'.repeat(32) };

beforeEach(async () => { await resetStores(); vi.stubGlobal('fetch', noNetwork); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

/** The fixture's wallet with its KAS in twelve coins of 1 KAS, beside a pool. `tag`: two hex digits. */
function smallCoins(tag: string) {
  let answer: any = null;
  const fx = fixture(tag, { api: { pool: async () => answer } });
  const one = fx.node.utxoSet.find(u => u.covenantId === null)!;
  fx.node.utxoSet = fx.node.utxoSet.filter(u => u !== one);
  for (let i = 0; i < 12; i++) fx.node.utxoSet.push({ ...one, transactionId: `${tag}c${i.toString(16)}`.padEnd(64, '0'), amount: KAS });
  fx.wallet.balances = { ...fx.wallet.balances!, kas: 12n * KAS, kasSpendable: 12n * KAS };
  const pspk = scriptOf(fx.ctx, 'Pool', base), reserve = reserveStateOf(POOL, base), rspk = scriptOf(fx.ctx, 'KCC20', reserve);
  const txid = `${tag}f`.padEnd(64, '0');
  fx.node.utxoSet.push(
    { address: p2shAddressOf(pspk, 'kaspasim'), transactionId: txid, index: 0, amount: poolValue(base), scriptPublicKey: pspk, blockDaaScore: 999_000n, isCoinbase: false, covenantId: POOL },
    { address: p2shAddressOf(rspk, 'kaspasim'), transactionId: txid, index: 1, amount: 150_000_000n, scriptPublicKey: rspk, blockDaaScore: 999_000n, isCoinbase: false, covenantId: COVENANT },
  );
  answer = { pool: { utxo: { transactionId: txid, index: 0 }, state: base }, reserve: { utxo: { transactionId: txid, index: 1 }, state: reserve } };
  h.wallet = fx.wallet;
  return fx;
}

describe('a swap with the KAS in too many small coins', () => {
  it('says to merge them, sends nothing, and offers the merge, which opens Send for it', async () => {
    const fx = smallCoins('a1');
    const pushed: string[] = [];
    const nav: Nav = { tab: 'swap', setTab() {}, push: (s) => { pushed.push(s); }, back() {}, lock() {} };
    const { root } = await mount(createElement(NavContext.Provider, { value: nav }, createElement(Swap)));
    await until('the pool', () => root.textContent.includes('1 kUSDT ='));
    await typeIn(field(root, 'You pay'), '5');
    await until('the swap button', () => !button(root, 'Swap KAS for kUSDT').disabled);
    await click(button(root, 'Swap KAS for kUSDT'));
    await until('the answer', () => root.textContent.includes('Merge your KAS first'));
    expect(root.textContent).toContain('Your KAS is in 12 coins, and the 6 largest are not enough for this');
    expect(fx.node.submitted).toHaveLength(0);
    await click(button(root, 'Merge my KAS'));
    expect(pushed).toEqual(['merge']);
  });
});

describe('Send opened to merge', () => {
  it('starts as a send of all the KAS to the wallet\'s own address, and the review shows exactly that', async () => {
    const fx = smallCoins('a2');
    const { root } = await mount(createElement(Send, { onBack() {}, merge: true }));
    await until('the form', () => root.textContent.includes(MERGE_NOTE));
    expect(field(root, 'kaspasim:…').value).toBe(fx.wallet.keys.main.address);
    expect(field(root, 'Amount').value).toBe('12');
    expect(root.textContent).toContain('Everything spendable is sent');
    await click(button(root, 'Review'));
    await until('the Review', () => root.textContent.includes('You send'));
    expect(root.textContent).toContain(fx.wallet.keys.main.address);
    expect(fx.node.submitted).toHaveLength(0);
  });
});
