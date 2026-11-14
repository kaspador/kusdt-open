// The approval window opens focused at a spot a page can compute, so a page can
// keep the user clicking there. Approve answers only about a second after the
// window is visible and focused with the request on screen; losing focus, the
// pointer coming in, or a press during the wait start the wait again.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createElement, useState } from 'react';
import { button, cleanup, fakeDocument, fakeWindow, fire, flush, mount, type FakeElement, until } from './fake-dom';
import { A, fixture, noNetwork, resetStores, type Fixture } from './screen-fixture';
import { session } from '@/lib/storage';
import { ERR, REQUEST_KEY, type PendingRequest } from '@/provider/protocol';
import { Approve, ARM_MS, useArmed } from '@/screens/Approve';

const h = vi.hoisted(() => ({ wallet: null as unknown }));
vi.mock('@/popup/state', () => ({ useWallet: () => h.wallet }));

const answers: { body: { error?: { code: number } } }[] = [];
const advance = async (ms: number) => { vi.advanceTimersByTime(ms); await flush(); };

beforeEach(async () => {
  await resetStores();
  vi.stubGlobal('fetch', noNetwork);
  answers.length = 0;
  vi.stubGlobal('chrome', { tabs: { sendMessage: (_t: number, msg: (typeof answers)[number], cb?: () => void) => { answers.push(msg); cb?.(); } }, runtime: {} });
  fakeDocument.focused = true;
  fakeDocument.visibilityState = 'visible';
  // Only the two timers the delay uses: React's own turns and the tests' waiting stay real.
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
});
afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); });

async function windowFor(fx: Fixture, params: PendingRequest['params'], label = 'Approve') {
  h.wallet = fx.wallet;
  const id = 'window-1234';
  const pending = { id, method: params.method, params, origin: 'https://page.example', tabId: 7, at: 1, network: 'simnet' } as PendingRequest;
  await session.set({ [REQUEST_KEY]: pending });
  fakeWindow.location.hash = `#request=${id}`;
  const { root } = await mount(createElement(Approve));
  await until(label, () => button(root, label));
  await flush();
  return { root, approve: () => button(root, label) };
}

const CONNECT: PendingRequest['params'] = { method: 'kaspa_requestAccounts' };
const BURN: PendingRequest['params'] = { method: 'kusdt_redeem', chain: 'ethereum', address: A, amount: '20000000' };
/** Mounted with the request on screen and the wait over. */
async function armed(fx: Fixture) {
  const w = await windowFor(fx, CONNECT, 'Connect');
  await until('the request', () => w.root.textContent.includes('Account'));
  await flush();
  await advance(ARM_MS);
  expect(w.approve().disabled).toBe(false);
  return w;
}

describe('the Approve button', () => {
  it('comes on about a second after the request is on screen, not the moment it is', async () => {
    const { root, approve } = await windowFor(fixture('f1'), CONNECT, 'Connect');
    await until('the request', () => root.textContent.includes('Account'));
    await flush();
    expect(approve().disabled).toBe(true);
    await advance(ARM_MS - 1);
    expect(approve().disabled).toBe(true);
    await advance(1);
    expect(approve().disabled).toBe(false);
  });

  it('counts from the moment the plan arrives, however long the window has been open', async () => {
    const fx = fixture('f2');
    const open = fx.holdPlanning();
    const { root, approve } = await windowFor(fx, BURN);
    await advance(5 * ARM_MS);
    expect(approve().disabled).toBe(true);
    open();
    await until('the plan', () => root.textContent.includes('Release fee'));
    await flush();
    expect(approve().disabled).toBe(true);
    await advance(ARM_MS - 1);
    expect(approve().disabled).toBe(true);
    await advance(1);
    expect(approve().disabled).toBe(false);
  });

  it('goes off when the window loses focus, and needs the full wait once focused again', async () => {
    const { approve } = await armed(fixture('f3'));
    fakeDocument.focused = false;
    fire(fakeWindow, 'blur');
    await flush();
    expect(approve().disabled).toBe(true);
    await advance(10 * ARM_MS);
    expect(approve().disabled).toBe(true);
    fakeDocument.focused = true;
    fire(fakeWindow, 'focus');
    await flush();
    expect(approve().disabled).toBe(true);
    await advance(ARM_MS - 1);
    expect(approve().disabled).toBe(true);
    await advance(1);
    expect(approve().disabled).toBe(false);
  });

  it('starts the wait again when the pointer comes into the window', async () => {
    const { approve } = await armed(fixture('f4'));
    fire(fakeDocument.documentElement, 'pointerenter', { bubbles: false });
    await flush();
    expect(approve().disabled).toBe(true);
    await advance(ARM_MS - 1);
    expect(approve().disabled).toBe(true);
    await advance(1);
    expect(approve().disabled).toBe(false);
  });

  it('starts the wait again on a press during it, so a stream of clicks never gets through', async () => {
    const { root, approve } = await windowFor(fixture('f5'), CONNECT, 'Connect');
    await until('the request', () => root.textContent.includes('Account'));
    await flush();
    // A click every half second, for ten seconds, at Approve's spot.
    for (let i = 0; i < 20; i++) {
      await advance(ARM_MS / 2);
      expect(approve().disabled).toBe(true);
      fire(approve(), 'pointerdown');
      fire(approve(), 'click');
      await flush();
    }
    expect(answers).toEqual([]);
    await advance(ARM_MS);
    expect(approve().disabled).toBe(false);
  });

  it('is not started while the window is hidden, and stops when it is hidden', async () => {
    fakeDocument.visibilityState = 'hidden';
    const { root, approve } = await windowFor(fixture('f6'), CONNECT, 'Connect');
    await until('the request', () => root.textContent.includes('Account'));
    await flush();
    await advance(5 * ARM_MS);
    expect(approve().disabled).toBe(true);
    fakeDocument.visibilityState = 'visible';
    fire(fakeDocument, 'visibilitychange', { bubbles: false });
    await flush();
    await advance(ARM_MS);
    expect(approve().disabled).toBe(false);
    fakeDocument.visibilityState = 'hidden';
    fire(fakeDocument, 'visibilitychange', { bubbles: false });
    await flush();
    expect(approve().disabled).toBe(true);
  });

  it('waits for focus in a window that opened without it', async () => {
    fakeDocument.focused = false;
    const { root, approve } = await windowFor(fixture('f7'), CONNECT, 'Connect');
    await until('the request', () => root.textContent.includes('Account'));
    await flush();
    await advance(5 * ARM_MS);
    expect(approve().disabled).toBe(true);
    fakeDocument.focused = true;
    fire(fakeWindow, 'focus');
    await flush();
    await advance(ARM_MS);
    expect(approve().disabled).toBe(false);
  });

  it('never holds back Reject', async () => {
    const { root } = await windowFor(fixture('f8'), CONNECT, 'Connect');
    await until('the request', () => root.textContent.includes('Account'));
    await flush();
    expect(button(root, 'Reject').disabled).toBe(false);
    fire(button(root, 'Reject'), 'click');
    await flush();
    await until('the answer to the page', () => answers.length > 0);
    expect(answers[0].body.error?.code).toBe(ERR.rejected);
  });
});

describe('useArmed', () => {
  function Probe({ onReady }: { onReady: (show: (v: object) => void) => void }) {
    const [shown, setShown] = useState<object>(() => ({}));
    onReady(setShown);
    return createElement('button', { 'aria-label': 'state' }, useArmed(shown) ? 'on' : 'off');
  }

  it('starts over the moment what is shown changes: new numbers never arrive armed', async () => {
    let show = (_: object) => {};
    const { root } = await mount(createElement(Probe, { onReady: s => { show = s; } }));
    const state = () => (button(root, 'state') as FakeElement).textContent;
    await flush();
    expect(state()).toBe('off');
    await advance(ARM_MS);
    expect(state()).toBe('on');
    show({});
    await flush();
    expect(state()).toBe('off');
    await advance(ARM_MS - 1);
    expect(state()).toBe('off');
    await advance(1);
    expect(state()).toBe('on');
  });
});
