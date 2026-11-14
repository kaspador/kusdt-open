// Run 21 round 2, R21-W2-1 (keyjacking), after reviewer "wallet2"'s test of the same name. The approval window's click
// guard (screens/Approve.tsx useArmed) restarted its 1 s wait on a pointer press, the pointer entering the window, focus
// and visibility; nothing listened for keys. A page that keeps its visitor pressing keys (a game, "press Tab and Enter")
// while it sends a request got no restart, and once the wait was over Tab reached Approve (Reject, then Approve: the
// window opens focused) and Enter or Space clicked it, with no pointer at all: the reviewer's run sent all 20 kUSDT to
// the site. Now a key pressed during the wait starts it again, as a pointer press does; and a click the keyboard makes
// (a click with `detail` 0) counts only once Approve has held the focus for ARM_MS with no key pressed since but the one
// that clicks. A keyboard user who brings the focus to Approve and reads for a second still approves with Enter.
// The real Approve window, the real core and a fake node (the fixtures of approve-arming.test.ts).

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { button, cleanup, click, fakeDocument, fakeWindow, fire, flush, mount, until, type FakeElement } from './fake-dom';
import { BOB, fixture, noNetwork, resetStores, type Fixture } from './screen-fixture';
import { session } from '@/lib/storage';
import { REQUEST_KEY, type PendingRequest } from '@/provider/protocol';
import { Approve, ARM_MS } from '@/screens/Approve';

const h = vi.hoisted(() => ({ wallet: null as unknown }));
vi.mock('@/popup/state', () => ({ useWallet: () => h.wallet }));

const answers: { body: { result?: any; error?: { code: number } } }[] = [];

beforeEach(async () => {
  await resetStores();
  vi.stubGlobal('fetch', noNetwork);
  answers.length = 0;
  vi.stubGlobal('chrome', { tabs: { sendMessage: (_t: number, msg: (typeof answers)[number], cb?: () => void) => { answers.push(msg); cb?.(); } }, runtime: {} });
  fakeDocument.focused = true;
  fakeDocument.visibilityState = 'visible';
  fakeDocument.activeElement = fakeDocument.body;
});
afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); });

/** The evil site's request: all 20 kUSDT of the fixture wallet to the attacker (BOB). */
const STEAL: PendingRequest['params'] = { method: 'kusdt_send', to: BOB, amount: '20000000' };

async function windowFor(fx: Fixture, id: string) {
  h.wallet = fx.wallet;
  await session.set({ [REQUEST_KEY]: { id, method: STEAL.method, params: STEAL, origin: 'https://evil.example', tabId: 7, at: 1, network: 'simnet' } as PendingRequest });
  fakeWindow.location.hash = `#request=${id}`;
  const { root } = await mount(createElement(Approve));
  await until('the plan', () => root.textContent.includes('Network fee'));
  await flush();
  return { root, approve: () => button(root, 'Approve') };
}

/** A key as the browser delivers it to the focused element: keydown, then keyup. No pointer event. */
function key(target: FakeElement | typeof fakeDocument.body, k: string) {
  fire(target, 'keydown', { key: k, code: k });
  fire(target, 'keyup', { key: k, code: k });
}
/** Tab bringing the focus to `el`: the key, then the focus moving there. */
function tabTo(el: FakeElement) {
  fire(fakeDocument.activeElement, 'keydown', { key: 'Tab', code: 'Tab' });
  fakeDocument.activeElement = el;
  fire(el, 'focusin');
  fire(el, 'keyup', { key: 'Tab', code: 'Tab' });
}
/** Enter on the focused button: the browser fires `click` on it with `detail` 0, no pointer event. */
async function enter(el: FakeElement) {
  fire(el, 'keydown', { key: 'Enter', code: 'Enter' });
  fire(el, 'click', { detail: 0 });
  fire(el, 'keyup', { key: 'Enter', code: 'Enter' });
  await flush();
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('R21-W2-1: the approval window\'s guard covers the keyboard as it does the pointer', () => {
  it('a stream of key presses keeps Approve off, as the same stream of pointer presses does', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const w = await windowFor(fixture('c1'), 'window-keys-1');
    for (let t = 0; t < 3 * ARM_MS; t += 100) {
      for (const k of ['Tab', 'Shift', 'a', 'Enter', ' ']) key(fakeDocument.body, k);
      vi.advanceTimersByTime(100);
      await flush();
      expect(w.approve().disabled).toBe(true);
    }
    // Once the keys stop, the wait runs out and Approve arms as before.
    vi.advanceTimersByTime(ARM_MS);
    await flush();
    expect(w.approve().disabled).toBe(false);
  });

  it('Tab, Tab, Enter the moment Approve arms: the click the keyboard made is not taken, and nothing is sent', async () => {
    const fx = fixture('c2');
    const w = await windowFor(fx, 'window-keys-2');
    await until('Approve to arm', () => !w.approve().disabled, ARM_MS + 3_000);
    tabTo(button(w.root, 'Reject'));
    tabTo(w.approve());
    await enter(w.approve());
    await sleep(300);
    await flush();
    expect(fx.node.submitted).toEqual([]);
    expect(answers).toEqual([]);
    expect(w.approve().disabled).toBe(false); // still open, for the user to approve or reject
  });

  it('Enter pressed again and again on the focused Approve never counts', async () => {
    const fx = fixture('c3');
    const w = await windowFor(fx, 'window-keys-3');
    await until('Approve to arm', () => !w.approve().disabled, ARM_MS + 3_000);
    tabTo(w.approve());
    for (let i = 0; i < 12; i++) { await enter(w.approve()); await sleep(ARM_MS / 5); }
    expect(fx.node.submitted).toEqual([]);
    expect(answers).toEqual([]);
  });

  it('a keyboard user who brings the focus to Approve and waits ARM_MS approves with Enter', async () => {
    const fx = fixture('c4');
    const w = await windowFor(fx, 'window-keys-4');
    await until('Approve to arm', () => !w.approve().disabled, ARM_MS + 3_000);
    tabTo(w.approve());
    await sleep(ARM_MS + 100);
    await enter(w.approve());
    await until('the send', () => fx.node.submitted.length > 0, 10_000);
    await until('the answer to the tab', () => answers.length > 0, 10_000);
    expect(typeof answers[0].body.result?.txid).toBe('string');
  });

  it('a pointer click on the armed Approve approves as before', async () => {
    const fx = fixture('c5');
    const w = await windowFor(fx, 'window-keys-5');
    await until('Approve to arm', () => !w.approve().disabled, ARM_MS + 3_000);
    await click(w.approve());
    await until('the send', () => fx.node.submitted.length > 0, 10_000);
    expect(fx.node.submitted).toHaveLength(1);
  });
});
