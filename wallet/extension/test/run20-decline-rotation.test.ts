// Outside review of rc.22 (run 20), PUB20-2: the wallet's decline limit (three declines in two minutes, then a minute's
// wait) counted per origin only. A page that moved to a new name of its own after each decline (n0.evil.example,
// n1.evil.example, ...) in the same tab opened the focused approval window again and again without end, and while it
// was open every other site got -32002 busy. Now declines count per tab too, as the queue cap of R14-CL-1 does: the
// tab waits its minute whatever name it asks under, and a site in another tab is not held by it.

import { afterEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => {
  const state = {
    listener: null as null | ((msg: unknown, sender: unknown, sendResponse: (r: unknown) => void) => boolean),
    windowRemoved: null as null | ((windowId: number) => void),
    windowsOpened: 0,
    openWindows: new Set<number>(),
  };
  let nextWindow = 500;
  (globalThis as { chrome?: unknown }).chrome = {
    storage: { onChanged: { addListener() {} } },
    runtime: { id: 'wallet-extension-id', lastError: undefined, getURL: (p: string) => `chrome-extension://x/${p}`, onMessage: { addListener(fn: typeof state.listener) { state.listener = fn; } } },
    windows: {
      onRemoved: { addListener(fn: (id: number) => void) { state.windowRemoved = fn; } },
      get(id: number, cb: (w?: unknown) => void) { cb(state.openWindows.has(id) ? { id } : undefined); },
      getLastFocused(_o: unknown, cb: (w?: unknown) => void) { cb(undefined); },
      create(_o: unknown, cb: (w?: unknown) => void) { const id = nextWindow++; state.windowsOpened++; state.openWindows.add(id); cb({ id }); },
      update() {},
    },
    tabs: { sendMessage(_t: number, _m: unknown, cb?: () => void) { cb?.(); }, query(_o: unknown, cb: (t: unknown[]) => void) { cb([]); }, onRemoved: { addListener() {} } },
  };
  return state;
});

vi.mock('@/wallet/context', () => ({ openCtx: async () => ({ ctx: {}, active: {} }), balancesOf: async () => ({ kas: 0n, kusdt: 0n }) }));

import { registerProvider } from '@/background/provider';
import { COOLDOWN_MS, DECLINE_LIMIT, DECLINE_WINDOW_MS, REQUEST_KEY, cooldownOf, nextDeclines, tabDeclineKey } from '@/provider/protocol';
import { DECLINES_KEY, finishRequest, readPending } from '@/provider/answer';
import { session } from '@/lib/storage';
import { acceptTerms } from '@/config/terms';

type Answer = { result?: unknown; error?: { code: number; message: string }; pending?: boolean };

let seq = 0;
function ask(origin: string, tabId: number, method = 'kaspa_requestAccounts'): Promise<Answer> {
  const sender = { id: 'wallet-extension-id', origin, url: `${origin}/page`, tab: { id: tabId, windowId: 1, active: true }, frameId: 0 };
  return new Promise((resolve) => {
    h.listener!({ kind: 'kusdt-provider', id: `run20-${String(++seq).padStart(6, '0')}`, method, params: {} }, sender, resolve as (r: unknown) => void);
  });
}

/** The user declines the open request: Reject in the window (4001), or `close` it. */
async function decline(how: 'reject' | 'close' = 'reject'): Promise<void> {
  const open = (await readPending())!;
  if (how === 'reject') await finishRequest(open, { error: { code: 4001, message: 'The user rejected the request.' } });
  h.openWindows.delete(open.windowId!);
  h.windowRemoved!(open.windowId!);
  await new Promise(r => setTimeout(r, 5));
}

registerProvider();
await acceptTerms();

afterEach(async () => {
  vi.useRealTimers();
  await session.remove(REQUEST_KEY);
  await session.remove(DECLINES_KEY);
});

describe('PUB20-2: a page that moves to a new subdomain after each decline, in one tab', () => {
  it('is held after three declines, whatever name it asks under next', async () => {
    let inARow = 0;
    for (let i = 0; i < 30; i++) {
      const a = await ask(`https://n${i}.evil.example`, 61);
      if (!a.pending) {
        expect(a.error?.code).toBe(-32002);
        expect(a.error?.message).toMatch(/Too many declined requests/);
        break;
      }
      inARow++;
      await decline(i % 2 ? 'close' : 'reject');
    }
    // Before the fix: 30 windows in a row, one per name.
    expect(inARow).toBe(DECLINE_LIMIT);
  });

  it('does not hold an honest site in another tab, nor the wallet for it', async () => {
    for (let i = 0; i < DECLINE_LIMIT; i++) { expect((await ask(`https://m${i}.evil.example`, 62)).pending).toBe(true); await decline(); }
    expect((await ask('https://m9.evil.example', 62)).error?.code).toBe(-32002);
    // The bridge site, in its own tab, gets its window at once.
    const honest = await ask('https://bridge.example', 63);
    expect(honest.pending).toBe(true);
    const open = (await readPending())!;
    expect(open.origin).toBe('https://bridge.example');
    await finishRequest(open, { result: ['kaspatest:q'] });
  });

  it('an approval in the tab clears its count, and the hold ends after its minute', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    for (let i = 0; i < DECLINE_LIMIT - 1; i++) { await ask(`https://k${i}.evil.example`, 64); await decline(); }
    // The user approves one: the tab starts again from nothing.
    await ask('https://k8.evil.example', 64);
    await finishRequest((await readPending())!, { result: ['kaspatest:q'] });
    for (let i = 0; i < DECLINE_LIMIT - 1; i++) { expect((await ask(`https://j${i}.evil.example`, 64)).pending).toBe(true); await decline(); }
    expect((await ask('https://j8.evil.example', 64)).pending).toBe(true);
    await decline();
    expect((await ask('https://j9.evil.example', 64)).error?.code).toBe(-32002);
    vi.setSystemTime(Date.now() + COOLDOWN_MS + 1);
    expect((await ask('https://j9.evil.example', 64)).pending).toBe(true);
    await decline();
  });
});

describe('the decline count (protocol.ts)', () => {
  it('counts a tab beside its origin, and an approval clears both', () => {
    const at = { origin: 'https://a.example', tabId: 5 };
    let d = {};
    for (let i = 0; i < DECLINE_LIMIT; i++) d = nextDeclines(d, `https://s${i}.example`, false, 1_000 + i, 5);
    expect(cooldownOf(d, tabDeclineKey(5), 1_100)).toBe(COOLDOWN_MS - 1_100 + 1_002);
    for (let i = 0; i < DECLINE_LIMIT; i++) expect(cooldownOf(d, `https://s${i}.example`, 1_100)).toBe(0);
    expect(cooldownOf(d, tabDeclineKey(6), 1_100)).toBe(0);
    d = nextDeclines(d, at.origin, true, 2_000, at.tabId);
    expect(cooldownOf(d, tabDeclineKey(5), 2_000)).toBe(0);
  });

  it('forgets what is over, so names a page moves through do not pile up', () => {
    let d = {};
    for (let i = 0; i < 200; i++) d = nextDeclines(d, `https://p${i}.example`, false, i * (DECLINE_WINDOW_MS / 4), 9);
    expect(Object.keys(d).length).toBeLessThan(10);
  });

  it('a clock set back does not hold a site or a tab for longer than the minute', () => {
    let d = {};
    for (let i = 0; i < DECLINE_LIMIT; i++) d = nextDeclines(d, 'https://a.example', false, 10_000_000 + i, 3);
    // An hour back: the hold was set from a time that has not come yet.
    expect(cooldownOf(d, 'https://a.example', 10_000_000 - 3_600_000)).toBe(0);
    expect(cooldownOf(d, tabDeclineKey(3), 10_000_000 - 3_600_000)).toBe(0);
    // And declines dated ahead of the clock do not count toward the next hold.
    d = {};
    for (let i = 0; i < DECLINE_LIMIT - 1; i++) d = nextDeclines(d, 'https://a.example', false, 10_000_000 + i, 3);
    d = nextDeclines(d, 'https://a.example', false, 10_000_000 - 3_600_000, 3);
    expect(cooldownOf(d, 'https://a.example', 10_000_000 - 3_600_000)).toBe(0);
  });
});
