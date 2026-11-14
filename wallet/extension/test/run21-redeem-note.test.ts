// Run 21: the popup's redemption review said "The fee and the vault's limits are from the coordinator's /status; the
// recipient is checked with it again just before the burn." Neither half held any more: the fee and the limits are the
// vault's own, read over its RPCs (round 12), and right before the burn, after any merges, the wallet now asks the
// coordinator and the token itself about the address, and the vault its fee (Daybreak [2], [19], [24]). The note says
// what is checked again.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { button, cleanup, click, elements, field, mount, typeIn, until } from './fake-dom';
import { A, fixture, noNetwork, resetStores } from './screen-fixture';
import { NavContext, type Nav } from '@/popup/nav';
import { Bridge } from '@/screens/Bridge';

const h = vi.hoisted(() => ({ wallet: null as unknown }));
vi.mock('@/popup/state', () => ({ useWallet: () => h.wallet }));

const nav: Nav = { tab: 'bridge', setTab() {}, push() {}, back() {}, lock() {} };
beforeEach(async () => { await resetStores(); vi.stubGlobal('fetch', noNetwork); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe('the redemption review says what is checked again right before the burn', () => {
  it('the vault\'s own fee and limits; then the coordinator and the token about the address, and the vault\'s fee, after any merges', async () => {
    h.wallet = fixture('e1').wallet;
    const { root } = await mount(createElement(NavContext.Provider, { value: nav }, createElement(Bridge)));
    await until('the Bridge screen', () => root.textContent.includes('Bridge'));
    await click(button(root, /→ USDT$/));
    await until('the Redeem form', () => root.textContent.includes('Paid') || root.textContent.includes('Your account'));
    await click(button(root, 'Pay another address'));
    await typeIn(field(root, /Pay USDT to/), A);
    await typeIn(field(root, 'kUSDT to redeem'), '10');
    await until('the checks', () => !button(root, 'Review').disabled);
    await click(button(root, 'Review'));
    await until('the Review', () => root.textContent.includes('You burn'));
    const note = elements(root).find(e => e.getAttribute('data-testid') === 'redeem-rechecks')?.textContent ?? root.textContent;
    expect(note).not.toMatch(/from the coordinator's \/status/);
    expect(note).toMatch(/the Ethereum \(local\) vault's own, read over its RPCs/);
    expect(note).toMatch(/Just before the burn, after any merges, the wallet asks again: the bridge server, and the USDT token where it keeps a blocklist, that this address can be paid, and the vault that its fee is not above the one shown/);
  });
});
