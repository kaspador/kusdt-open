// Run 21 round 2, R21-W2-2: the window a wallet is created in (the setup window, which stays open as the wallet once
// it exists) kept the 24 words in its own React state (popup/App.tsx `phrase`, set to show Create and never cleared).
// Locking cleared the session's phrase and the HD key and showed Unlock, and the words were still held by that window,
// readable with the browser's developer tools by whoever sat at the computer. Settings says "Locking forgets the
// unlocked phrase". The words now live only in Create and the session's draft: the window lets them go once the wallet
// exists, and again when it locks or the wallet is removed.
// Rendered: the real App, the real Create flow (screens/Onboard.tsx) and the real Lock (nav.lock); Home is replaced by
// a Lock button so nothing else of the wallet runs. (Adapted from the round-2 reviewer's reproduction.)

import { afterEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { button, checkbox, cleanup, elements, fakeDocument, fakeWindow, flush, mount, toggle, typeIn, until, click, FakeElement } from './fake-dom';
import './helpers';

vi.mock('@/screens/Home', async () => {
  const { useNav } = await import('@/popup/nav');
  return {
    Home: () => { const nav = useNav(); return createElement('button', { type: 'button', 'aria-label': 'Lock', onClick: nav.lock }, 'Lock'); },
    Receive: () => null,
  };
});

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
// The Unlock screen focuses its password field; the fake DOM has no focus() of its own.
(FakeElement.prototype as unknown as { focus: () => void }).focus = function (this: FakeElement) { fakeDocument.activeElement = this; };

/** Every hook value held by the fibers of `type` under the root container `el` (current and alternate trees). */
function hookValues(el: FakeElement, type: unknown): unknown[] {
  const key = Object.keys(el).find(k => k.startsWith('__reactContainer$'))!;
  const out: unknown[] = [];
  const seen = new Set<object>();
  const walk = (f: any) => {
    for (let n = f; n && !seen.has(n); n = n.sibling) {
      seen.add(n);
      if (n.type === type) for (const g of [n, n.alternate]) for (let h = g?.memoizedState; h; h = h.next) out.push(h.memoizedState);
      if (n.child) walk(n.child);
    }
  };
  const host = (el as any)[key];
  walk(host); if (host?.alternate) walk(host.alternate);
  return out;
}

describe('R21-W2-2: the setup window lets the recovery phrase go', () => {
  it('once the wallet exists, and it is not there after the wallet locks either', async () => {
    vi.stubGlobal('fetch', async () => { throw new Error('no network in the tests'); });
    vi.stubGlobal('chrome', { runtime: { connect: () => ({}), getManifest: () => ({ version: 'test' }) }, extension: { getViews: () => [] } });
    fakeWindow.location.hash = '#setup=create';
    const { App } = await import('@/popup/App');
    const { session } = await import('@/lib/storage');
    const { SESSION_KEY } = await import('@/keys/session');
    const { acceptTerms } = await import('@/config/terms');
    await acceptTerms();
    const { root } = await mount(createElement(App));
    // Step 1: the words.
    await until('the words', () => root.textContent.includes('Your recovery phrase'));
    const words = elements(root).filter(e => e.nodeName === 'SPAN' && /^[a-z]+$/.test(e.textContent) && e.getAttribute('class') === 'text-pearl-200' && /\binset\b/.test((e.parentNode as FakeElement)?.getAttribute?.('class') ?? '')).map(e => e.textContent);
    expect(words).toHaveLength(24);
    const phrase = words.join(' ');
    // While it is being created the window shows it: Create has it from App.
    expect(hookValues(root, App)).toContain(phrase);
    await toggle(checkbox(root));
    await click(button(root, 'Continue'));
    // Step 2: the three words asked for.
    await until('the check', () => root.textContent.includes('Check your phrase'));
    for (const label of elements(root).filter(e => e.nodeName === 'LABEL' && /^Word \d+/.test(e.textContent))) {
      const n = Number(/^Word (\d+)/.exec(label.textContent)![1]);
      const input = elements(label).find(e => e.nodeName === 'INPUT')!;
      await typeIn(input, words[n - 1]);
    }
    await click(button(root, 'Continue'));
    // Step 3: the password.
    await until('the password', () => root.textContent.includes('Set a password'));
    for (const input of elements(root).filter(e => e.nodeName === 'INPUT' && e.type === 'password')) await typeIn(input, 'a long password');
    await click(button(root, 'Create wallet'));
    await until('the wallet', () => !!elements(root).find(e => e.nodeName === 'BUTTON' && e.getAttribute('aria-label') === 'Lock'), 60_000);
    expect(await session.get(SESSION_KEY)).toBe(phrase);
    await flush();
    expect(hookValues(root, App).filter(v => v === phrase)).toEqual([]);
    // Lock, in this window, as the header's Lock does.
    await click(button(root, 'Lock'));
    await until('the unlock screen', () => root.textContent.includes('Welcome back'));
    await flush();
    expect(await session.get(SESSION_KEY)).toBeUndefined();
    expect(hookValues(root, App).filter(v => v === phrase)).toEqual([]);
  }, 120_000);
});
