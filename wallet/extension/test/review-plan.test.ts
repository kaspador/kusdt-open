// What the Review screen shows, what Done says and what Activity records is
// the transaction Confirm submits: the plan, never the live form. And the form
// can't change while the plan is being prepared.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { button, checkbox, cleanup, click, field, forceClick, mount, toggle, typeIn, until } from './fake-dom';
import { A, B, BOB, CAROL, SCRIPT_ADDRESS, fixture, noNetwork, resetStores, type Fixture } from './screen-fixture';
import { evmHex, redeemPayload } from '@/kusdt/tokens';
import { listActivity } from '@/activity/history';
import { NavContext, type Nav } from '@/popup/nav';
import { Bridge } from '@/screens/Bridge';
import { Send } from '@/screens/Send';

const h = vi.hoisted(() => ({ wallet: null as unknown }));
vi.mock('@/popup/state', () => ({ useWallet: () => h.wallet }));

const ETH = 'Ethereum (local)', BSC = 'BNB Chain (local)';
const nav: Nav = { tab: 'bridge', setTab() {}, push() {}, back() {}, lock() {} };

beforeEach(async () => { await resetStores(); vi.stubGlobal('fetch', noNetwork); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const show = (fx: Fixture) => { h.wallet = fx.wallet; };

/** The Redeem form, filled in with 20 kUSDT to address A on Ethereum, the checks done. */
async function redeemForm(fx: Fixture) {
  show(fx);
  const { root } = await mount(createElement(NavContext.Provider, { value: nav }, createElement(Bridge)));
  await until('the Bridge screen', () => root.textContent.includes('Bridge'));
  await click(button(root, /→ USDT$/));
  await until('the Redeem form', () => root.textContent.includes('Paid') || root.textContent.includes('Your account'));
  await click(button(root, 'Pay another address'));
  await typeIn(field(root, /Pay USDT to/), A);
  await typeIn(field(root, 'kUSDT to redeem'), '20');
  await until('the checks', () => !button(root, 'Review').disabled);
  return root;
}

describe('Redeem', () => {
  it('freezes the form while the plan is prepared', async () => {
    const fx = fixture('a1');
    const root = await redeemForm(fx);
    const open = fx.holdPlanning();
    await click(button(root, 'Review'));
    await until('Preparing', () => root.textContent.includes('Preparing'));
    expect(field(root, 'kUSDT to redeem').disabled).toBe(true);
    expect(field(root, /Pay USDT to/).disabled).toBe(true);
    expect(button(root, 'Max').disabled).toBe(true);
    expect(button(root, ETH).disabled).toBe(true);
    expect(button(root, BSC).disabled).toBe(true);
    expect(button(root, 'Mine').disabled).toBe(true);
    open();
    await until('the Review', () => root.textContent.includes('You burn'));
  });

  it('is enabled again when the plan fails', async () => {
    const fx = fixture('a2', { api: { tokens: async () => { throw new Error('no tokens'); } } });
    const root = await redeemForm(fx);
    await click(button(root, 'Review'));
    await until('the failure', () => root.textContent.includes('no tokens'));
    expect(field(root, 'kUSDT to redeem').disabled).toBe(false);
    expect(field(root, /Pay USDT to/).disabled).toBe(false);
  });

  it('shows, says and records the planned chain, address and amount, whatever the form became', async () => {
    const fx = fixture('a3');
    const root = await redeemForm(fx);
    const open = fx.holdPlanning();
    await click(button(root, 'Review'));
    await until('Preparing', () => root.textContent.includes('Preparing'));
    // As if the freeze had been got past: another address, amount and chain in the form.
    await typeIn(field(root, /Pay USDT to/), B);
    await typeIn(field(root, 'kUSDT to redeem'), '15');
    await forceClick(button(root, BSC));
    open();
    await until('the Review', () => root.textContent.includes('You burn'));

    const review = root.textContent;
    expect(review).toContain(`Paid to, on ${ETH}`);
    expect(review).toContain(A);
    expect(review).not.toContain(B);
    expect(review).toContain(`On${ETH}`);
    expect(review).toContain(`can only go to the address above on ${ETH}`);
    expect(review).toContain('You burn20 kUSDT');
    expect(review).not.toContain(BSC);

    await toggle(checkbox(root));
    await until('Redeem to be enabled', () => !button(root, 'Redeem').disabled);
    await click(button(root, 'Redeem'));
    await until('Done', () => root.textContent.includes('Redemption sent'));
    expect(root.textContent).toContain(`USDT is paid on ${ETH}`);
    expect(root.textContent).not.toContain(BSC);

    // The burn the node received is the one shown.
    const sent = JSON.parse(fx.node.submitted[0]) as { payload: string };
    expect(sent.payload).toBe(redeemPayload([{ outputIndex: 0, chain: 1, address: evmHex(A) }]));
    const [a] = await listActivity('simnet');
    expect(a).toMatchObject({ kind: 'redeem', chain: 'ethereum', address: A, kusdt: '20000000' });
  });
});

/** The Send form, filled in and the checks done. */
async function sendForm(fx: Fixture, asset: 'kUSDT' | 'KAS', to: string, amount: string) {
  show(fx);
  const { root } = await mount(createElement(Send, { onBack() {} }));
  await until('the Send screen', () => root.textContent.includes('Send'));
  if (asset === 'KAS') await click(button(root, /^KAS/));
  await typeIn(field(root, 'kaspasim:…'), to);
  await typeIn(field(root, 'Amount'), amount);
  await until('Review to be enabled', () => !button(root, 'Review').disabled);
  return root;
}

describe('Send', () => {
  it('freezes the asset, the address and the amount while the plan is prepared', async () => {
    const fx = fixture('b1');
    const root = await sendForm(fx, 'kUSDT', BOB, '5');
    const open = fx.holdPlanning();
    await click(button(root, 'Review'));
    await until('Preparing', () => root.textContent.includes('Preparing'));
    expect(button(root, /^kUSDT/).disabled).toBe(true);
    expect(button(root, /^KAS/).disabled).toBe(true);
    expect(field(root, 'kaspasim:…').disabled).toBe(true);
    expect(field(root, 'Amount').disabled).toBe(true);
    expect(button(root, 'Max').disabled).toBe(true);
    open();
    await until('the Review', () => root.textContent.includes('You send'));
  });

  it('reviews and records the planned kUSDT recipient, whatever the form became', async () => {
    const fx = fixture('b2');
    const root = await sendForm(fx, 'kUSDT', BOB, '5');
    const open = fx.holdPlanning();
    await click(button(root, 'Review'));
    await until('Preparing', () => root.textContent.includes('Preparing'));
    await typeIn(field(root, 'kaspasim:…'), CAROL);
    open();
    await until('the Review', () => root.textContent.includes('You send'));
    expect(root.textContent).toContain(BOB);
    expect(root.textContent).not.toContain(CAROL);
    await click(button(root, 'Confirm and send'));
    await until('Done', () => root.textContent.includes('It shows in Activity'));
    const [a] = await listActivity('simnet');
    expect(a).toMatchObject({ kind: 'kusdt-send', counterparty: BOB, kusdt: '5000000' });
  });

  it('warns about the planned recipient, not the one now in the form', async () => {
    const fx = fixture('b3');
    const root = await sendForm(fx, 'kUSDT', SCRIPT_ADDRESS, '5');
    expect(root.textContent).toContain('This is a script address');
    const open = fx.holdPlanning();
    await click(button(root, 'Review'));
    await until('Preparing', () => root.textContent.includes('Preparing'));
    await typeIn(field(root, 'kaspasim:…'), BOB);
    await until('the form to follow', () => !root.textContent.includes('This is a script address'));
    open();
    await until('the Review', () => root.textContent.includes('You send'));
    expect(root.textContent).toContain(SCRIPT_ADDRESS);
    expect(root.textContent).toContain('This is a script address');
  });

  it('reviews the planned KAS recipient, whatever the form became', async () => {
    const fx = fixture('b4');
    const root = await sendForm(fx, 'KAS', BOB, '5');
    const open = fx.holdKasPlanning();
    await click(button(root, 'Review'));
    await until('Preparing', () => root.textContent.includes('Preparing'));
    expect(field(root, 'kaspasim:…').disabled).toBe(true);
    await typeIn(field(root, 'kaspasim:…'), CAROL);
    open();
    await until('the Review', () => root.textContent.includes('You send'));
    expect(root.textContent).toContain(BOB);
    expect(root.textContent).not.toContain(CAROL);
  });
});
