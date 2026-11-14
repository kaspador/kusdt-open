// Run 21: site requests in the real background provider (background/provider.ts), with a fake chrome. Each block
// below says which Daybreak finding it checks and what was wrong.

import { afterEach, describe, expect, it, vi } from 'vitest';

type Listener = (msg: unknown, sender: unknown, sendResponse: (r: unknown) => void) => boolean;
const h = vi.hoisted(() => {
  const state = {
    listener: null as null | Listener,
    tabRemoved: null as null | ((tabId: number) => void),
    windowRemoved: null as null | ((windowId: number) => void),
    storageChanged: [] as ((changes: Record<string, { oldValue?: unknown; newValue?: unknown }>, area: string) => void)[],
    openWindows: new Set<number>(),
    removedWindows: [] as number[],
    tabs: [] as { id: number; url: string }[],
    sent: [] as { tabId: number; msg: any }[],
    ctxNetworks: [] as string[],
  };
  let nextWindow = 500;
  (globalThis as { chrome?: unknown }).chrome = {
    storage: { onChanged: { addListener(fn: (typeof state.storageChanged)[number]) { state.storageChanged.push(fn); } } },
    runtime: { id: 'wallet-extension-id', lastError: undefined, getURL: (p: string) => `chrome-extension://x/${p}`, onMessage: { addListener(fn: Listener) { state.listener = fn; } } },
    windows: {
      onRemoved: { addListener(fn: (id: number) => void) { state.windowRemoved = fn; } },
      get(id: number, cb: (w?: unknown) => void) { cb(state.openWindows.has(id) ? { id } : undefined); },
      getLastFocused(_o: unknown, cb: (w?: unknown) => void) { cb(undefined); },
      create(_o: unknown, cb: (w?: unknown) => void) { const id = nextWindow++; state.openWindows.add(id); cb({ id }); },
      update() {},
      // Chrome closes the window, then tells windows.onRemoved.
      remove(id: number, cb?: () => void) { state.openWindows.delete(id); state.removedWindows.push(id); cb?.(); state.windowRemoved?.(id); },
    },
    tabs: {
      sendMessage(tabId: number, msg: unknown) { state.sent.push({ tabId, msg }); },
      query(_o: unknown, cb: (t: unknown[]) => void) { cb(state.tabs.map(t => ({ ...t }))); },
      onRemoved: { addListener(fn: (tabId: number) => void) { state.tabRemoved = fn; } },
    },
  };
  return state;
});

// The real openCtx (what is read, and on which network), with the reads of the balances themselves faked.
vi.mock('@/lib/core', () => ({ getCore: async () => ({}) }));
vi.mock('@/wallet/context', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/wallet/context')>()),
  balancesOf: async (ctx: { network: string }) => { h.ctxNetworks.push(ctx.network); return { kas: ctx.network === 'simnet' ? 777n : 1n, kusdt: 0n }; },
}));

import { registerProvider, accountsChangedFor } from '@/background/provider';
import { connectionsKey, REQUEST_KEY, type Connection, type PendingRequest } from '@/provider/protocol';
import { DECLINES_KEY, markSending } from '@/provider/answer';
import { local, session } from '@/lib/storage';
import { OWN_KEY, SESSION_KEY } from '@/keys/session';
import { loadSettings, saveSettings, SETTINGS_KEY } from '@/config/settings';
import { acceptTerms } from '@/config/terms';

type Answer = { result?: any; error?: { code: number; message: string }; pending?: boolean };
const SITE = 'https://bridge.example', OTHER = 'https://other.example';
const ADDRESS = 'kaspatest:qqkqkzjvr7zwxxmjxjkmxxdwju9kjs6e9u82uh59z07vgaks6gg62v8707g73';
const REDEEM = { chain: 'ethereum', address: '0x90F79bf6EB2c4f870365E785982E1f101E93b906', amount: '1000000' };
const HOUR = 3_600_000;

let seq = 0;
const sender = (origin: string, tab: { id: number; windowId: number; active: boolean }) => ({ id: 'wallet-extension-id', origin, url: `${origin}/page`, tab, frameId: 0 });
function ask(origin: string, method: string, params: unknown = {}, tab = { id: 7, windowId: 1, active: true }): Promise<Answer> {
  return new Promise((resolve) => { h.listener!({ kind: 'kusdt-provider', id: `run21-${String(++seq).padStart(6, '0')}`, method, params }, sender(origin, tab), resolve as (r: unknown) => void); });
}

async function connect(origin: string, network?: string): Promise<string> {
  const net = network ?? (await loadSettings()).network;
  const own = { address: ADDRESS, ownerHex: 'ab'.repeat(32), kasAddresses: [ADDRESS] };
  // An unlocked wallet's: a locked one answers no site its account or balances (R21-W2-4).
  await session.set({ [OWN_KEY]: { ...((await session.get<Record<string, unknown>>(OWN_KEY)) ?? {}), [net]: own }, [SESSION_KEY]: 'the unlocked phrase' });
  const all = (await local.get<Record<string, Connection>>(connectionsKey(net))) ?? {};
  await local.set({ [connectionsKey(net)]: { ...all, [origin]: { origin, ...own, at: 1 } } });
  await acceptTerms();
  return net;
}

/** Waits (a little, in real time) for what the background does after a listener returns. */
async function settle(done: () => boolean | Promise<boolean>): Promise<void> {
  for (let i = 0; i < 200 && !(await done()); i++) await new Promise(r => setTimeout(r, 5));
}
const pendingNow = () => session.get<PendingRequest>(REQUEST_KEY);
const answersTo = (tabId: number) => h.sent.filter(s => s.tabId === tabId && s.msg?.kind === 'kusdt-provider-answer').map(s => s.msg);

registerProvider();

afterEach(async () => {
  vi.useRealTimers();
  h.openWindows.clear(); h.removedWindows.length = 0; h.sent.length = 0;
  await session.remove(REQUEST_KEY, DECLINES_KEY);
});

// Daybreak [28]: the request the approval window was open for outlived the page that asked. Its tab closed or its page
// navigated away, and the window could still act for it, while every other site was told the wallet was busy, for as
// long as nobody closed the window. Such a request is now let go (the window closed, the site told it was rejected),
// one older than the wallet's bound no longer holds other sites, and the window takes a request only while it is
// still the open one.
describe('Daybreak [28]: a request whose page is gone is let go', () => {
  it('when its tab closes: the window is closed, the site told, and the next site is not held', async () => {
    await connect(SITE);
    expect(await ask(SITE, 'kusdt_redeem', REDEEM)).toEqual({ pending: true });
    const open = (await pendingNow())!;
    expect(h.openWindows.has(open.windowId!)).toBe(true);
    h.tabRemoved!(7);
    await settle(async () => !(await pendingNow()));
    expect(await pendingNow()).toBeUndefined();
    expect(h.removedWindows).toEqual([open.windowId]);
    expect(answersTo(7)).toEqual([{ kind: 'kusdt-provider-answer', id: open.id, body: { error: { code: 4001, message: expect.any(String) } } }]);
    await connect(OTHER);
    expect(await ask(OTHER, 'kusdt_send', { to: ADDRESS, amount: '1' }, { id: 9, windowId: 2, active: true })).toEqual({ pending: true });
  });

  it('when its page navigates away (the content script says so at pagehide); only that page can say it', async () => {
    await connect(SITE);
    expect(await ask(SITE, 'kusdt_redeem', REDEEM)).toEqual({ pending: true });
    const open = (await pendingNow())!;
    const gone = (origin: string, tab: number, ids: unknown) => h.listener!({ kind: 'kusdt-provider-gone', ids }, sender(origin, { id: tab, windowId: 1, active: true }), () => {});
    // Another tab, another site or another request's id: nothing is let go.
    gone(SITE, 8, [open.id]);
    gone(OTHER, 7, [open.id]);
    gone(SITE, 7, ['some-other-request']);
    await new Promise(r => setTimeout(r, 30));
    expect((await pendingNow())?.id).toBe(open.id);
    gone(SITE, 7, [open.id]);
    await settle(async () => !(await pendingNow()));
    expect(await pendingNow()).toBeUndefined();
    expect(h.removedWindows).toEqual([open.windowId]);
    expect(answersTo(7).map(a => a.body.error.code)).toEqual([4001]);
  });

  it('once it is older than the bound, another site\'s request takes its place (and it is told it was rejected)', async () => {
    await connect(SITE);
    expect(await ask(SITE, 'kusdt_redeem', REDEEM)).toEqual({ pending: true });
    const open = (await pendingNow())!;
    await connect(OTHER);
    // Within the bound the window is the user's to answer: another site waits its turn.
    expect((await ask(OTHER, 'kusdt_send', { to: ADDRESS, amount: '1' }, { id: 9, windowId: 2, active: true })).error?.code).toBe(-32002);
    vi.useFakeTimers({ now: Date.now() + HOUR, toFake: ['Date'] });
    expect(await ask(OTHER, 'kusdt_send', { to: ADDRESS, amount: '1' }, { id: 9, windowId: 2, active: true })).toEqual({ pending: true });
    expect((await pendingNow())?.origin).toBe(OTHER);
    expect(h.removedWindows).toEqual([open.windowId]);
    expect(answersTo(7)).toEqual([{ kind: 'kusdt-provider-answer', id: open.id, body: { error: { code: 4001, message: expect.any(String) } } }]);
  });

  it('a request already being sent is never let go: its window finishes it', async () => {
    await connect(SITE);
    expect(await ask(SITE, 'kusdt_redeem', REDEEM)).toEqual({ pending: true });
    const open = (await pendingNow())!;
    await markSending(open);
    h.tabRemoved!(7);
    await new Promise(r => setTimeout(r, 30));
    expect((await pendingNow())?.sending).toBe(true);
    expect(h.removedWindows).toEqual([]);
  });
});

describe('Daybreak [28]: the approval window takes only the request that is still open', () => {
  const base = (over: Partial<PendingRequest> = {}) => ({
    id: 'window-run21-28', method: 'kusdt_redeem', params: { method: 'kusdt_redeem', ...REDEEM }, origin: SITE, tabId: 7, at: Date.now(), expires: Date.now() + 60_000, network: 'testnet-10', ...over,
  }) as PendingRequest;

  it('marks it as being sent while it is the open one', async () => {
    await session.set({ [REQUEST_KEY]: base() });
    await markSending(base());
    expect((await pendingNow())?.sending).toBe(true);
  });

  it('refuses one the background let go, or another request in its place: nothing is signed for it', async () => {
    await expect(markSending(base())).rejects.toThrow(/no longer waiting/i);
    await session.set({ [REQUEST_KEY]: base({ id: 'window-someone-else' }) });
    await expect(markSending(base())).rejects.toThrow(/no longer waiting/i);
    expect((await pendingNow())?.sending).toBeUndefined();
  });

  it('refuses one past its time, even with nobody else asking', async () => {
    const old = base({ at: Date.now() - HOUR, expires: Date.now() - 1 });
    await session.set({ [REQUEST_KEY]: old });
    await expect(markSending(old)).rejects.toThrow(/no longer waiting/i);
    expect((await pendingNow())?.sending).toBeUndefined();
  });
});

// Daybreak [52]: a balances request was checked against the connections of one network and read on whichever network
// the wallet had by then: a site connected only on testnet-10 could be answered with simnet's balances.
describe('Daybreak [52]: a request is answered from one look at the settings', () => {
  it('a site connected only on testnet-10 is answered with testnet-10\'s balances, whatever the wallet switches to meanwhile', async () => {
    await saveSettings({ network: 'testnet-10' });
    await connect(SITE, 'testnet-10');
    expect(((await local.get<Record<string, Connection>>(connectionsKey('simnet'))) ?? {})[SITE]).toBeUndefined();
    // The user switches the wallet to simnet right after the request was checked against testnet-10's connections.
    const get = local.get.bind(local);
    let switched = false;
    local.get = (async (key: string) => {
      const v = await get(key);
      if (!switched && key === connectionsKey('testnet-10')) { switched = true; await saveSettings({ network: 'simnet' }); }
      return v;
    }) as typeof local.get;
    try {
      const r = await ask(SITE, 'kusdt_getBalances', {}, { id: 11, windowId: 1, active: true });
      expect(switched).toBe(true);
      expect(h.ctxNetworks.at(-1)).toBe('testnet-10');
      expect(r.result).toEqual({ kas: '1', kusdt: '0' });
    } finally { local.get = get as typeof local.get; await saveSettings({ network: 'testnet-10' }); }
  });
});

// Daybreak [32], the background's half: account events went to a tab by its id only, with nothing in them that names
// the page they were meant for.
describe('Daybreak [32] (background): account and network events name the page they are meant for', () => {
  it('accountsChanged carries the origin it was decided for', async () => {
    const net = (await loadSettings()).network;
    await connect(SITE, net);
    h.tabs = [{ id: 21, url: `${SITE}/page` }];
    const after = (await local.get<Record<string, Connection>>(connectionsKey(net)))!;
    const before = { ...after };
    delete before[SITE];
    await accountsChangedFor(net, before, after);
    expect(h.sent.filter(s => s.msg?.event === 'accountsChanged')).toEqual([{ tabId: 21, msg: { kind: 'kusdt-provider-event', event: 'accountsChanged', data: [ADDRESS], origin: SITE } }]);
  });

  it('a network switch tells each tab its own origin\'s events', async () => {
    await connect(SITE, 'simnet');
    h.tabs = [{ id: 21, url: `${SITE}/page` }, { id: 22, url: `${OTHER}/x` }];
    for (const l of h.storageChanged) l({ [SETTINGS_KEY]: { oldValue: { network: 'testnet-10' }, newValue: { network: 'simnet' } } }, 'local');
    await settle(() => h.sent.filter(s => s.msg?.kind === 'kusdt-provider-event').length >= 4);
    const events = h.sent.filter(s => s.msg?.kind === 'kusdt-provider-event').map(s => [s.tabId, s.msg.event, s.msg.origin]);
    expect(events).toEqual([[21, 'networkChanged', SITE], [21, 'accountsChanged', SITE], [22, 'networkChanged', OTHER], [22, 'accountsChanged', OTHER]]);
  });
});
