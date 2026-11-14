// Round 14, R14-CL-1: every page's window.kusdt requests waited in one queue, first come first served, with no
// bound. A page that sent thousands of requests (even ones that are refused) held every other site's requests
// behind them: the bridge site's connect, balances and signing requests hung while the backlog drained.
// Now each site has a queue of its own, of at most SITE_QUEUE_MAX requests, a request that waited too long is
// answered busy, only the approval window is shared (the tab the user is looking at first), and the balances a
// connected site reads are shared for a moment rather than read again for every request.

import { afterEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => {
  const state = {
    listener: null as null | ((msg: unknown, sender: unknown, sendResponse: (r: unknown) => void) => boolean),
    tabRemoved: null as null | ((tabId: number) => void),
    windowsOpened: 0,
    openWindows: new Set<number>(),
    // When set, chrome.windows.create waits for this before it answers (to hold the approval window's turn).
    holdCreate: null as null | Promise<void>,
    balanceReads: 0,
    balanceGate: null as null | Promise<void>,
  };
  let nextWindow = 100;
  (globalThis as { chrome?: unknown }).chrome = {
    storage: { onChanged: { addListener() {} } },
    runtime: { id: 'wallet-extension-id', lastError: undefined, getURL: (p: string) => `chrome-extension://x/${p}`, onMessage: { addListener(fn: typeof state.listener) { state.listener = fn; } } },
    windows: {
      onRemoved: { addListener() {} },
      get(id: number, cb: (w?: unknown) => void) { cb(state.openWindows.has(id) ? { id } : undefined); },
      getLastFocused(_o: unknown, cb: (w?: unknown) => void) { cb(undefined); },
      create(_o: unknown, cb: (w?: unknown) => void) {
        const id = nextWindow++;
        const done = () => { state.windowsOpened++; state.openWindows.add(id); cb({ id }); };
        if (state.holdCreate) state.holdCreate.then(done); else done();
      },
      update() {},
    },
    tabs: {
      sendMessage() {},
      query(_o: unknown, cb: (t: unknown[]) => void) { cb([]); },
      onRemoved: { addListener(fn: (tabId: number) => void) { state.tabRemoved = fn; } },
    },
  };
  return state;
});

vi.mock('@/wallet/context', () => ({
  openCtx: async () => ({ ctx: {}, active: {} }),
  balancesOf: async () => {
    h.balanceReads++;
    if (h.balanceGate) await h.balanceGate;
    return { kas: 5n, kusdt: 7n };
  },
}));

import { registerProvider, SITE_QUEUE_MAX, SITE_WAIT_MS, BALANCES_WAIT_MS, BALANCES_SHARED_MS } from '@/background/provider';
import { connectionsKey, REQUEST_KEY, type Connection } from '@/provider/protocol';
import { local, session } from '@/lib/storage';
import { OWN_KEY, SESSION_KEY } from '@/keys/session';
import { loadSettings } from '@/config/settings';
import { acceptTerms } from '@/config/terms';

type Answer = { result?: unknown; error?: { code: number; message: string }; pending?: boolean };

const BRIDGE = 'https://bridge.example';
const EVIL = 'https://evil.example';
const OTHER = 'https://other.example';
const ADDRESS = 'kaspatest:qqkqkzjvr7zwxxmjxjkmxxdwju9kjs6e9u82uh59z07vgaks6gg62v8707g73';

let seq = 0;
function ask(origin: string, method: string, tab = { id: 7, windowId: 1, active: false }, params: unknown = {}): Promise<Answer> {
  const sender = { id: 'wallet-extension-id', origin, url: `${origin}/page`, tab, frameId: 0 };
  return new Promise((resolve) => {
    h.listener!({ kind: 'kusdt-provider', id: `round14-${String(++seq).padStart(6, '0')}`, method, params }, sender, resolve as (r: unknown) => void);
  });
}

async function connect(origin: string): Promise<void> {
  const { network } = await loadSettings();
  const own = { address: ADDRESS, ownerHex: 'ab'.repeat(32), kasAddresses: [ADDRESS] };
  // Unlocked: a locked wallet answers no site its account or balances (run 21, R21-W2-4).
  await session.set({ [OWN_KEY]: { [network]: own }, [SESSION_KEY]: 'the unlocked phrase' });
  const all = (await local.get<Record<string, Connection>>(connectionsKey(network))) ?? {};
  await local.set({ [connectionsKey(network)]: { ...all, [origin]: { origin, ...own, at: 1 } } });
  // A connected site is one of a wallet that has accepted the Terms of Service (test/terms.test.ts: before that).
  await acceptTerms();
}

registerProvider();

afterEach(async () => {
  vi.useRealTimers();
  h.holdCreate = null; h.balanceGate = null; h.openWindows.clear();
  await session.remove(REQUEST_KEY);
});

describe('one site sending a flood of requests (R14-CL-1)', () => {
  it('does not hold back another site: the bridge site is answered before the flood drains', async () => {
    // The requests the wallet worked through (refused as not connected, 4100) before it answered the bridge site.
    let handledFirst = 0, bridgeAnswered = false;
    const flood: Promise<Answer>[] = [];
    for (let i = 0; i < 20_000; i++) {
      flood.push(ask(EVIL, 'kusdt_getBalances', { id: 9, windowId: 2, active: false }).then(a => { if (a.error?.code === 4100 && !bridgeAnswered) handledFirst++; return a; }));
    }
    const honest = await ask(BRIDGE, 'kaspa_getNetwork');
    bridgeAnswered = true;
    expect(honest.result).toBe((await loadSettings()).network);
    // At most the flooding site's own queue was worked through first, never the whole backlog.
    expect(handledFirst).toBeLessThanOrEqual(SITE_QUEUE_MAX);
    const answers = await Promise.all(flood);
    // The flooding site is refused on its own: beyond its queue, at once, as busy.
    const busy = answers.filter(a => a.error?.code === -32002).length;
    expect(busy).toBeGreaterThanOrEqual(20_000 - SITE_QUEUE_MAX);
    expect(answers.filter(a => a.error?.code === 4100).length).toBeLessThanOrEqual(SITE_QUEUE_MAX);
  });

  it('answers a connected site\'s account while another site floods', async () => {
    await connect(BRIDGE);
    const flood: Promise<Answer>[] = [];
    for (let i = 0; i < 5_000; i++) flood.push(ask(EVIL, 'kaspa_getNetwork', { id: 9, windowId: 2, active: false }));
    let evilAnswered = 0;
    for (const f of flood) void f.then(a => { if (a.result) evilAnswered++; });
    const accounts = await ask(BRIDGE, 'kaspa_requestAccounts');
    expect(accounts.result).toEqual([ADDRESS]);
    expect(evilAnswered).toBeLessThanOrEqual(SITE_QUEUE_MAX);
    await Promise.all(flood);
  });

  it('refuses a site past its queue at once, without waiting on its earlier requests', async () => {
    await connect(BRIDGE);
    let release!: () => void;
    h.balanceGate = new Promise<void>(r => { release = r; });
    const held: Promise<Answer>[] = [];
    for (let i = 0; i < SITE_QUEUE_MAX; i++) held.push(ask(BRIDGE, 'kusdt_getBalances'));
    const over = await ask(BRIDGE, 'kaspa_getNetwork');
    expect(over.error?.code).toBe(-32002);
    // Another site is not touched by this one's full queue.
    expect((await ask(OTHER, 'kaspa_getNetwork', { id: 8, windowId: 1, active: false })).result).toBeTruthy();
    release();
    for (const a of await Promise.all(held)) expect(a.result).toEqual({ kas: '5', kusdt: '7' });
  });

  it('answers a balances read that takes too long, and the site\'s next request is not held by it', async () => {
    // Balances read by an earlier test are shared for a moment: let that pass first.
    await new Promise(r => setTimeout(r, BALANCES_SHARED_MS + 10));
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    await connect(BRIDGE);
    let release!: () => void;
    h.balanceGate = new Promise<void>(r => { release = r; });
    const first = ask(BRIDGE, 'kusdt_getBalances');
    const second = ask(BRIDGE, 'kaspa_getNetwork');
    let secondAnswer: Answer | undefined;
    void second.then(a => { secondAnswer = a; });
    // The balances read is answered at its bound, as an error, and the queue moves on.
    await vi.advanceTimersByTimeAsync(BALANCES_WAIT_MS + 10);
    expect((await first).error?.code).toBe(-32603);
    // The waiting request waited less than SITE_WAIT_MS, so it is answered.
    expect(BALANCES_WAIT_MS).toBeLessThan(SITE_WAIT_MS);
    await vi.advanceTimersByTimeAsync(10);
    expect(secondAnswer?.result).toBeTruthy();
    release();
  });

  it('answers busy a request whose wait passed SITE_WAIT_MS', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    // An approval window that takes longer than the bound to open holds the site's queue.
    let open!: () => void;
    h.holdCreate = new Promise<void>(r => { open = r; });
    const connecting = ask(OTHER, 'kaspa_requestAccounts');
    const waiting = ask(OTHER, 'kaspa_getNetwork');
    await vi.advanceTimersByTimeAsync(SITE_WAIT_MS + 10);
    open();
    expect((await connecting).pending).toBe(true);
    const late = await waiting;
    expect(late.error?.code).toBe(-32002);
  });

  it('lets go of the requests a closed tab left waiting', async () => {
    let open!: () => void;
    h.holdCreate = new Promise<void>(r => { open = r; });
    const connecting = ask(OTHER, 'kaspa_requestAccounts', { id: 11, windowId: 1, active: false });
    const left: Promise<Answer>[] = [];
    for (let i = 0; i < 3; i++) left.push(ask(OTHER, 'kaspa_getNetwork', { id: 11, windowId: 1, active: false }));
    await new Promise(r => setTimeout(r, 10));
    h.tabRemoved!(11);
    // Their places are free at once: the site's next tab is not told it is busy.
    const fresh = ask(OTHER, 'kaspa_getNetwork', { id: 12, windowId: 1, active: false });
    for (const a of await Promise.all(left)) expect(a.error?.code).toBe(4900);
    open();
    await connecting;
    expect((await fresh).result).toBeTruthy();
  });
});

describe('a page that moves from one name of its own to the next (R14-CL-1)', () => {
  it('holds at most SITE_QUEUE_MAX places in all queues together', async () => {
    let open!: () => void;
    h.holdCreate = new Promise<void>(r => { open = r; });
    const all: Promise<Answer>[] = [];
    let early = 0;
    for (let i = 0; i < 20; i++) {
      const a = ask(`https://s${i}.evil.example`, 'kaspa_requestAccounts', { id: 31, windowId: 1, active: false });
      void a.then(x => { if (x.error?.code === -32002) early++; });
      all.push(a);
    }
    await new Promise(r => setTimeout(r, 10));
    // The first holds the window's turn, seven more wait for it, twelve are refused at once.
    expect(early).toBe(20 - SITE_QUEUE_MAX);
    // Another tab is not refused for that page's places.
    expect((await ask(BRIDGE, 'kaspa_getNetwork', { id: 32, windowId: 1, active: false })).result).toBeTruthy();
    open();
    await Promise.all(all);
    // Its places are given back as it is answered.
    expect((await ask('https://s0.evil.example', 'kaspa_getNetwork', { id: 31, windowId: 1, active: false })).result).toBeTruthy();
  });
});

describe('the approval window, shared by every site (R14-CL-1)', () => {
  it('opens one window at a time, and the site the user is looking at goes first', async () => {
    let open!: () => void;
    h.holdCreate = new Promise<void>(r => { open = r; });
    const opened = h.windowsOpened;
    const first = ask(EVIL, 'kaspa_requestAccounts', { id: 21, windowId: 1, active: false });
    await new Promise(r => setTimeout(r, 10));
    // Both wait for the first window to open: the inactive tab asked before the active one.
    const background = ask(OTHER, 'kaspa_requestAccounts', { id: 22, windowId: 1, active: false });
    const looking = ask(BRIDGE + '2', 'kaspa_requestAccounts', { id: 23, windowId: 1, active: true });
    const order: string[] = [];
    void background.then(() => order.push('background'));
    void looking.then(() => order.push('looking'));
    await new Promise(r => setTimeout(r, 10));
    open();
    expect((await first).pending).toBe(true);
    const [b, l] = await Promise.all([background, looking]);
    // One window: both later requests are told the wallet is busy, the active tab's first.
    expect(h.windowsOpened - opened).toBe(1);
    expect(b.error?.code).toBe(-32002);
    expect(l.error?.code).toBe(-32002);
    expect(order).toEqual(['looking', 'background']);
  });
});

describe('an approval window that never opens (R14-CL-1)', () => {
  it('holds another site\'s request no longer than SITE_WAIT_MS', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    let open!: () => void;
    h.holdCreate = new Promise<void>(r => { open = r; });
    const stuck = ask(EVIL, 'kaspa_requestAccounts', { id: 41, windowId: 1, active: false });
    const other = ask(OTHER, 'kaspa_requestAccounts', { id: 42, windowId: 1, active: true });
    let answer: Answer | undefined;
    void other.then(a => { answer = a; });
    await vi.advanceTimersByTimeAsync(SITE_WAIT_MS - 1_000);
    expect(answer).toBeUndefined();
    await vi.advanceTimersByTimeAsync(2_000);
    expect(answer?.error?.code).toBe(-32002);
    // The site's queue moves on: its next request is answered.
    expect((await ask(OTHER, 'kaspa_getNetwork', { id: 42, windowId: 1, active: true })).result).toBeTruthy();
    open();
    expect((await stuck).pending).toBe(true);
  });
});

describe('balances a connected site reads (R14-CL-1)', () => {
  it('are read once for requests that come together, and again only after a moment', async () => {
    await connect(BRIDGE);
    await connect(OTHER);
    await new Promise(r => setTimeout(r, BALANCES_SHARED_MS + 10));
    const before = h.balanceReads;
    const answers = await Promise.all([ask(BRIDGE, 'kusdt_getBalances'), ask(OTHER, 'kusdt_getBalances'), ask(BRIDGE, 'kusdt_getBalances')]);
    for (const a of answers) expect(a.result).toEqual({ kas: '5', kusdt: '7' });
    expect(h.balanceReads - before).toBe(1);
    await new Promise(r => setTimeout(r, BALANCES_SHARED_MS + 10));
    await ask(BRIDGE, 'kusdt_getBalances');
    expect(h.balanceReads - before).toBe(2);
  });
});
