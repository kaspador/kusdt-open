// Run 21, reviewer RV-W on ef52bd4 (R21-W2-4): a locked wallet answered a connected site's kaspa_requestAccounts and
// kusdt_getBalances 4100, which a page could not tell from "not connected". The web app forgot its connection at every
// auto-lock, and its Connect only said "connect first" until the user unlocked from the toolbar and clicked again.
// Still no site is told its account or balances while the wallet is locked, and now:
//   - a connected site's kaspa_requestAccounts opens the wallet's window, which asks for the password and then answers
//     the account the site already has (screens/Approve.tsx; test/run21-locked-connect-window.test.ts);
//   - kusdt_getBalances is refused 4100 with `data: { locked: true }`, which reaches the page through window.kusdt, so a
//     page keeps its connection and says the wallet is locked;
//   - at unlock each connected site's tab hears its account again (accountsChanged), so a page picks it up with no click.
// On the real background provider (background/provider.ts) and the real page script (provider/inpage.ts).

import { afterEach, describe, expect, it, vi } from 'vitest';

type Listener = (msg: unknown, sender: unknown, sendResponse: (r: unknown) => void) => boolean;
const h = vi.hoisted(() => {
  const state = {
    listener: null as null | Listener,
    storageChanged: [] as ((changes: Record<string, { oldValue?: unknown; newValue?: unknown }>, area: string) => void)[],
    openWindows: new Set<number>(),
    tabs: [] as { id: number; url: string }[],
    sent: [] as { tabId: number; msg: any }[],
    reads: 0,
  };
  let nextWindow = 700;
  (globalThis as { chrome?: unknown }).chrome = {
    storage: { onChanged: { addListener(fn: (typeof state.storageChanged)[number]) { state.storageChanged.push(fn); } } },
    runtime: { id: 'wallet-extension-id', lastError: undefined, getURL: (p: string) => `chrome-extension://x/${p}`, onMessage: { addListener(fn: Listener) { state.listener = fn; } } },
    windows: {
      onRemoved: { addListener() {} },
      get(id: number, cb: (w?: unknown) => void) { cb(state.openWindows.has(id) ? { id } : undefined); },
      getLastFocused(_o: unknown, cb: (w?: unknown) => void) { cb(undefined); },
      create(_o: unknown, cb: (w?: unknown) => void) { const id = nextWindow++; state.openWindows.add(id); cb({ id }); },
      update() {},
      remove(id: number, cb?: () => void) { state.openWindows.delete(id); cb?.(); },
    },
    tabs: {
      sendMessage(tabId: number, msg: unknown) { state.sent.push({ tabId, msg }); },
      query(_o: unknown, cb: (t: unknown[]) => void) { cb(state.tabs.map(t => ({ ...t }))); },
      onRemoved: { addListener() {} },
    },
  };
  return state;
});

vi.mock('@/wallet/context', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/wallet/context')>()),
  balancesOf: async () => { h.reads++; return { kas: 1n, kusdt: 0n }; },
}));
vi.mock('@/lib/core', () => ({ getCore: async () => ({}) }));

import { registerProvider } from '@/background/provider';
import { connectionsKey, REQUEST_KEY, type Connection, type PendingRequest } from '@/provider/protocol';
import { DECLINES_KEY } from '@/provider/answer';
import { local, session } from '@/lib/storage';
import { OWN_KEY, SESSION_KEY } from '@/keys/session';
import { loadSettings } from '@/config/settings';
import { acceptTerms, TERMS_KEY } from '@/config/terms';

type Answer = { result?: any; error?: { code: number; message: string; data?: unknown }; pending?: boolean };
const SITE = 'https://bridge.example', OTHER = 'https://other.example';
const ADDRESS = 'kaspatest:qqkqkzjvr7zwxxmjxjkmxxdwju9kjs6e9u82uh59z07vgaks6gg62v8707g73';

let seq = 0;
function ask(origin: string, method: string, tab = { id: 7, windowId: 1, active: true }): Promise<Answer> {
  const sender = { id: 'wallet-extension-id', origin, url: `${origin}/page`, tab, frameId: 0 };
  return new Promise((resolve) => { h.listener!({ kind: 'kusdt-provider', id: `locked-${String(++seq).padStart(6, '0')}`, method, params: {} }, sender, resolve as (r: unknown) => void); });
}

/** SITE connected on the wallet's network; the wallet locked (its addresses stay in the session, its phrase does not). */
async function connectedAndLocked(): Promise<string> {
  const { network } = await loadSettings();
  const own = { address: ADDRESS, ownerHex: 'ab'.repeat(32), kasAddresses: [ADDRESS] };
  await session.set({ [OWN_KEY]: { [network]: own } });
  await session.remove(SESSION_KEY);
  await local.set({ [connectionsKey(network)]: { [SITE]: { origin: SITE, ...own, at: 1 } as Connection } });
  await acceptTerms();
  return network;
}

async function settle(done: () => boolean): Promise<void> {
  for (let i = 0; i < 200 && !done(); i++) await new Promise(r => setTimeout(r, 5));
}

registerProvider();

afterEach(async () => { h.openWindows.clear(); h.sent.length = 0; h.tabs = []; await session.remove(REQUEST_KEY, DECLINES_KEY); });

describe('a connected site while the wallet is locked', () => {
  it('its Connect opens the wallet\'s window (the password first) and is not answered the account here', async () => {
    await connectedAndLocked();
    const r = await ask(SITE, 'kaspa_requestAccounts');
    expect(r).toEqual({ pending: true });
    const open = (await session.get<PendingRequest>(REQUEST_KEY))!;
    expect([open.method, open.origin]).toEqual(['kaspa_requestAccounts', SITE]);
    expect(h.openWindows.has(open.windowId!)).toBe(true);
    expect(JSON.stringify(h.sent)).not.toContain(ADDRESS);
  });

  it('its balances are refused 4100 marked locked, and nothing is read for them', async () => {
    await connectedAndLocked();
    const before = h.reads;
    const r = await ask(SITE, 'kusdt_getBalances');
    expect(r).toEqual({ error: { code: 4100, message: expect.stringMatching(/locked/i), data: { locked: true } } });
    expect(h.reads).toBe(before);
    // Unlocked, it is answered.
    await session.set({ [SESSION_KEY]: 'the unlocked phrase' });
    expect((await ask(SITE, 'kusdt_getBalances')).result).toEqual({ kas: '1', kusdt: '0' });
    expect(await ask(SITE, 'kaspa_requestAccounts')).toEqual({ result: [ADDRESS] });
  });

  it('at unlock, each connected site\'s tab hears its account; another site\'s tab hears nothing', async () => {
    await connectedAndLocked();
    h.tabs = [{ id: 21, url: `${SITE}/swap` }, { id: 22, url: `${OTHER}/x` }];
    for (const l of h.storageChanged) l({ [SESSION_KEY]: { newValue: 'the unlocked phrase' } }, 'session');
    await settle(() => h.sent.length > 0);
    await new Promise(r => setTimeout(r, 20));
    expect(h.sent).toEqual([{ tabId: 21, msg: { kind: 'kusdt-provider-event', event: 'accountsChanged', data: [ADDRESS], origin: SITE } }]);
  });

  it('nothing is named at unlock before the Terms of Service are accepted, nor when the phrase only changes', async () => {
    await connectedAndLocked();
    h.tabs = [{ id: 21, url: `${SITE}/swap` }];
    await local.remove(TERMS_KEY);
    for (const l of h.storageChanged) l({ [SESSION_KEY]: { newValue: 'the unlocked phrase' } }, 'session');
    await acceptTerms();
    for (const l of h.storageChanged) l({ [SESSION_KEY]: { oldValue: 'the unlocked phrase', newValue: 'another' } }, 'session');
    await new Promise(r => setTimeout(r, 40));
    expect(h.sent).toEqual([]);
  });
});

describe('the page hears the mark: window.kusdt rejects a locked wallet\'s 4100 with its data', () => {
  it('the error a page catches carries data.locked', async () => {
    /* eslint-disable @typescript-eslint/no-explicit-any */
    const listeners: ((ev: any) => void)[] = [];
    const posted: any[] = [];
    const page: any = {
      location: { origin: SITE },
      addEventListener: (type: string, fn: (ev: any) => void) => { if (type === 'message') listeners.push(fn); },
      postMessage: (data: unknown) => { posted.push(data); },
      dispatchEvent: () => true,
    };
    const g = globalThis as any;
    const before = g.window;
    g.window = page;
    try {
      vi.resetModules();
      // @ts-expect-error inpage.ts is a script with no exports (built on its own): loaded here for what it does to window.
      await import('@/provider/inpage');
      const asked = page.kusdt.request({ method: 'kusdt_getBalances' });
      const { id } = posted[0];
      for (const fn of listeners) fn({ source: page, origin: SITE, data: { target: 'kusdt-wallet-inpage', id, error: { code: 4100, message: 'kUSDT Wallet is locked. Unlock it, then try again.', data: { locked: true } } } });
      await expect(asked).rejects.toMatchObject({ code: 4100, data: { locked: true } });
    } finally { g.window = before; }
  });
});
