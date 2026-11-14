// Run 21, reviewer RV-W on ef52bd4: a connected site's kaspa_requestAccounts while the wallet is locked opens the wallet's
// window (background/provider.ts), which asks for the password first (popup/App.tsx). Once unlocked, the window answers
// the account the site already has, as the wallet does at once while unlocked: nothing new is approved, and only for a
// site already connected with this wallet's own address on the request's network. Any other site is asked as before.
// The real Approve window, rendered with the screens' fixture.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { button, cleanup, fakeWindow, mount, until } from './fake-dom';
import { fixture, noNetwork, resetStores, type Fixture } from './screen-fixture';
import { local, session } from '@/lib/storage';
import { connectionsKey, REQUEST_KEY, type Connection, type PendingRequest } from '@/provider/protocol';
import { Approve } from '@/screens/Approve';

const h = vi.hoisted(() => ({ wallet: null as unknown }));
vi.mock('@/popup/state', () => ({ useWallet: () => h.wallet }));

const SITE = 'https://bridge.example';
const answers: any[] = [];

beforeEach(async () => {
  await resetStores();
  vi.stubGlobal('fetch', noNetwork);
  answers.length = 0;
  vi.stubGlobal('chrome', { tabs: { sendMessage: (_tab: number, msg: unknown, cb?: () => void) => { answers.push(msg); cb?.(); } }, runtime: {} });
});
afterEach(async () => { cleanup(); vi.unstubAllGlobals(); await local.remove(connectionsKey('simnet')); });

/** The window for SITE's kaspa_requestAccounts, with SITE's connection on simnet naming `address` (or none). */
async function windowFor(fx: Fixture, address: string | null, id: string) {
  h.wallet = fx.wallet;
  if (address) {
    const k = fx.wallet.keys;
    await local.set({ [connectionsKey('simnet')]: { [SITE]: { origin: SITE, address, ownerHex: k.ownerHex, kasAddresses: fx.wallet.kasAddresses, at: 1 } as Connection } });
  }
  const now = Date.now();
  await session.set({ [REQUEST_KEY]: { id, method: 'kaspa_requestAccounts', params: { method: 'kaspa_requestAccounts' }, origin: SITE, tabId: 7, at: now, expires: now + 60_000, network: 'simnet' } as PendingRequest });
  fakeWindow.location.hash = `#request=${id}`;
  return (await mount(createElement(Approve))).root;
}

describe('a connected site\'s Connect, opened while the wallet was locked', () => {
  it('is answered its account as soon as the window shows, with no new approval', async () => {
    const fx = fixture('f2a');
    const root = await windowFor(fx, fx.wallet.keys.main.address, 'window-run21-locked-1');
    await until('the answer to the page', () => answers.length > 0);
    expect(answers).toEqual([{ kind: 'kusdt-provider-answer', id: 'window-run21-locked-1', body: { result: [fx.wallet.keys.main.address] } }]);
    expect(await session.get(REQUEST_KEY)).toBeUndefined();
    await until('the window to say so', () => /already connected/i.test(root.textContent));
  });

  it('a site not connected, or connected with another address, is asked as before', async () => {
    const fx = fixture('f2b');
    const fresh = await windowFor(fx, null, 'window-run21-locked-2');
    await until('the approval', () => button(fresh, 'Connect'));
    cleanup();
    const other = await windowFor(fx, 'kaspasim:qr0lr4ml9fn3chekrqmjdkergxl93l4wrk3dankcgvjq776s9wn9jvmp6n4m3', 'window-run21-locked-3');
    await until('the approval', () => button(other, 'Connect'));
    await new Promise(r => setTimeout(r, 50));
    expect(answers).toEqual([]);
  });
});
