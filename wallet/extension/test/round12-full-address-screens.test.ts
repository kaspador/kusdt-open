// Round 12, R12-WW-1, what the user sees: kUSDT at an address the node cannot list is shown apart from the balance,
// with what it means, and the Send screen spends it only when the user ticks the box, saying so again in the review.
// The real screens over a fake node (test/screen-fixture.ts).

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { RpcTooLargeError } from '@kusdt/kaspa';
import { button, checkbox, cleanup, click, field, mount, toggle, typeIn, until } from './fake-dom';
import { BOB, fixture, noNetwork, resetStores, type Fixture } from './screen-fixture';
import { balancesOf } from '@/wallet/context';
import { inputsOf } from '@/kusdt/pending';
import { loadTokens } from '@/kusdt/tokens';
import { session } from '@/lib/storage';
import { NavContext, type Nav } from '@/popup/nav';
import { Home } from '@/screens/Home';
import { Send } from '@/screens/Send';

const h = vi.hoisted(() => ({ wallet: null as unknown }));
vi.mock('@/popup/state', () => ({ useWallet: () => h.wallet }));
vi.mock('@/screens/Activity', () => ({ RecentActivity: () => null }));

const nav: Nav = { tab: 'wallet', setTab() {}, push() {}, back() {}, lock() {} };
const USDT = 1_000_000n;

beforeEach(async () => { await resetStores(); await session.remove('kusdt.unreadable.simnet'); vi.stubGlobal('fetch', noNetwork); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

/**
 * A wallet with 20 and 5 kUSDT that has seen both, after which the address of the 20 was filled: the node refuses any
 * list that names it. Its balances are what the wallet reads then.
 */
async function flooded(tag: string): Promise<Fixture & { big: string }> {
  const fx = fixture(tag, { tokens: [20n * USDT, 5n * USDT] });
  const signer = fx.wallet.signer;
  await loadTokens(fx.ctx, signer);
  const big = fx.node.utxoSet.find(u => u.transactionId === fx.tokenOutpoints[0].split(':')[0])!.address;
  const list = fx.node.utxos.bind(fx.node);
  fx.node.utxos = async (addresses) => {
    if (addresses.includes(big)) throw new RpcTooLargeError('getUtxosByAddresses', 80_000_000, 64_000_000);
    return list(addresses);
  };
  fx.wallet.balances = await balancesOf(fx.ctx, fx.wallet.kasAddresses, fx.wallet.keys.ownerHex, fx.wallet.keys.main.address);
  h.wallet = fx.wallet;
  return Object.assign(fx, { big });
}

describe('kUSDT at an address the node cannot list', () => {
  it('Home shows the rest as the balance and says what could not be checked', async () => {
    const fx = await flooded('f1');
    expect(fx.wallet.balances).toMatchObject({ kusdt: 5n * USDT, unchecked: 1, uncheckedKusdt: 20n * USDT });
    const { root } = await mount(createElement(NavContext.Provider, { value: nav }, createElement(Home)));
    await until('the balance', () => root.textContent.includes('5.00'));
    expect(root.textContent).toMatch(/1 kUSDT coin holding 20 kUSDT by this wallet's record could not be checked on the Kaspa node/);
    expect(root.textContent).toContain('It is not in the balance above.');
    expect(root.textContent).not.toMatch(/25\.00/);
  });

  it('Send does not touch it unless the box is ticked, and then says so in the review before anything is signed', async () => {
    const fx = await flooded('f2');
    const { root } = await mount(createElement(Send, { onBack() {} }));
    await until('the Send screen', () => root.textContent.includes('Send'));
    await typeIn(field(root, 'kaspasim:…'), BOB);
    await typeIn(field(root, 'Amount'), '12');
    // More than the 5 kUSDT the node shows: refused as before.
    expect(root.textContent).toContain('That is more than you have.');
    expect(button(root, 'Review').disabled).toBe(true);

    expect(root.textContent).toMatch(/Also use the 20 kUSDT this wallet could not check/);
    await toggle(checkbox(root));
    await until('Review to be enabled', () => !button(root, 'Review').disabled);
    await click(button(root, 'Review'));
    await until('the Review', () => root.textContent.includes('You send'));
    expect(root.textContent).toMatch(/This spends 20 kUSDT that this wallet could not check on the Kaspa node/);
    expect(root.textContent).toMatch(/the node refuses the transaction and nothing is sent/);
    expect(fx.node.submitted).toEqual([]);

    await click(button(root, 'Confirm and send'));
    await until('Done', () => root.textContent.includes('It shows in Activity'));
    expect(fx.node.submitted).toHaveLength(1);
    expect(inputsOf(fx.node.submitted[0])).toEqual(expect.arrayContaining([fx.tokenOutpoints[0]]));
  });

  it('a send within the checked balance is as it always was: no box ticked, no unchecked kUSDT in it', async () => {
    const fx = await flooded('f3');
    const { root } = await mount(createElement(Send, { onBack() {} }));
    await until('the Send screen', () => root.textContent.includes('Send'));
    await typeIn(field(root, 'kaspasim:…'), BOB);
    await typeIn(field(root, 'Amount'), '4');
    await until('Review to be enabled', () => !button(root, 'Review').disabled);
    expect(checkbox(root).checked).toBe(false);
    await click(button(root, 'Review'));
    await until('the Review', () => root.textContent.includes('You send'));
    expect(root.textContent).not.toMatch(/could not check/);
    await click(button(root, 'Confirm and send'));
    await until('Done', () => root.textContent.includes('It shows in Activity'));
    expect(inputsOf(fx.node.submitted[0])).not.toContain(fx.tokenOutpoints[0]);
  });

  it('Home says when the balance is from the wallet\'s own record because the bridge server did not answer', async () => {
    const fx = fixture('f4', { tokens: [20n * USDT] });
    await loadTokens(fx.ctx, fx.wallet.signer);
    fx.ctx.api!.tokens = async () => { throw new Error('Could not reach the coordinator API.'); };
    fx.wallet.balances = await balancesOf(fx.ctx, fx.wallet.kasAddresses, fx.wallet.keys.ownerHex, fx.wallet.keys.main.address);
    expect(fx.wallet.balances).toMatchObject({ kusdt: 20n * USDT, kusdtFromMemory: true });
    h.wallet = fx.wallet;
    const { root } = await mount(createElement(NavContext.Provider, { value: nav }, createElement(Home)));
    await until('the balance', () => root.textContent.includes('20.00'));
    expect(root.textContent).toMatch(/The bridge server did not answer for this wallet/);
  });
});
