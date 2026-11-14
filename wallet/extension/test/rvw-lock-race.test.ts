// Run 21, reviewer RV-W (adapted from its rvw-lock-race.test.ts): Daybreak [15]'s fix ends a page's unlock at every lock,
// and a signer refuses once that count has moved. currentHd() restores the key from the session across an await: a
// lock that landed during it (the auto-lock alarm, the close check, Lock in another window) was counted, and the
// restore then set the key all the same. Every later currentHd() returned a working key with the session empty, a
// signer made from it counted from after the lock and signed, and App's check() showed the wallet open. Now a restore
// a lock overtakes sets no key, a signer counts from the unlock its key was made under, and App shows Unlock.

import { afterEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => {
  (globalThis as { chrome?: unknown }).chrome = { runtime: { getManifest: () => ({ version: 'test' }) }, storage: { onChanged: { addListener() {}, removeListener() {} } } };
  return { lockInTerms: false };
});
// App's check() reads the terms after the key: the last test has a lock land right there.
vi.mock('@/config/terms', async (orig) => ({
  ...(await orig<typeof import('@/config/terms')>()),
  termsAccepted: async () => {
    if (h.lockInTerms) { h.lockInTerms = false; const { lock } = await import('@/keys/session'); await lock(); }
    return true;
  },
}));
vi.mock('@/popup/state', () => ({ WalletProvider: ({ children }: { children: unknown }) => children, useWallet: () => { throw new Error('no wallet in this test'); } }));
vi.mock('@/screens/Home', () => ({ Home: () => 'HOME SCREEN', Receive: () => null }));

import { createElement } from 'react';
import { cleanup, fakeDocument, fakeWindow, mount, until, FakeElement } from './fake-dom';
import { currentHd, forgetInMemory, lock, unlockWith, SESSION_KEY } from '@/keys/session';
import { createVault } from '@/keys/vault';
import { session } from '@/lib/storage';
import { keysFor, signerOf } from '@/wallet/context';

const PHRASE = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
afterEach(async () => { cleanup(); vi.unstubAllGlobals(); await lock(); });
// The Unlock screen focuses its password field; the fake DOM has no focus() of its own.
(FakeElement.prototype as unknown as { focus: () => void }).focus = function (this: FakeElement) { fakeDocument.activeElement = this; };

describe('rv-w: a lock while a page restores the key', () => {
  it('ends the restore: currentHd() answers no key, then or later, and the session holds none', async () => {
    await unlockWith(PHRASE);
    // A page that has not restored the key yet (a window opened since the unlock): the phrase is in the session only.
    forgetInMemory();
    const restoring = currentHd();
    await lock();
    expect(await restoring).toBeNull();
    expect(await session.get(SESSION_KEY)).toBeUndefined();
    expect(await currentHd()).toBeNull();
  });

  it('a signer made after the lock, from a key unlocked before it, refuses', async () => {
    await unlockWith(PHRASE);
    const hd = (await currentHd())!;
    await lock();
    // A window that has not heard of the lock yet still holds the key and makes a signer from it.
    const signer = signerOf(hd, keysFor(hd, 'simnet'));
    expect(() => signer.secretFor(signer.address)).toThrow(/locked/i);
    // A new unlock's key signs.
    await unlockWith(PHRASE);
    const fresh = (await currentHd())!;
    const again = signerOf(fresh, keysFor(fresh, 'simnet'));
    expect(again.secretFor(again.address)).toMatch(/^[0-9a-f]{64}$/);
  });

  it('App shows Unlock, not the wallet, when a lock lands while it opens', async () => {
    vi.stubGlobal('fetch', async () => { throw new Error('no network in the tests'); });
    fakeWindow.location.hash = '';
    await createVault(PHRASE, 'a long password');
    await unlockWith(PHRASE);
    h.lockInTerms = true;
    const { App } = await import('@/popup/App');
    const { root } = await mount(createElement(App));
    await until('a screen', () => /Welcome back|HOME SCREEN/.test(root.textContent));
    expect(root.textContent).toContain('Welcome back');
    expect(root.textContent).not.toContain('HOME SCREEN');
  }, 60_000);
});
