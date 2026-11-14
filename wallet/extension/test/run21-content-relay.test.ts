// Run 21: the real content script (provider/content.ts) in a fake page, with a fake chrome.runtime. Each block below
// says which Daybreak finding it checks and what was wrong.

import { afterEach, describe, expect, it, vi } from 'vitest';

/* eslint-disable @typescript-eslint/no-explicit-any */
const g = globalThis as any;
const before = { window: g.window, chrome: g.chrome };
afterEach(() => { g.window = before.window; g.chrome = before.chrome; vi.resetModules(); });

/** The content script in a page at `origin`; the wallet answers each request with `reply`. */
async function page(origin: string, reply: (msg: any) => unknown = () => ({ pending: true })) {
  const listeners: Record<string, ((ev: any) => void)[]> = {};
  const toWallet: any[] = [], toPage: any[] = [];
  let fromWallet: ((msg: unknown, sender: unknown) => void) | null = null;
  g.window = {
    location: { origin }, origin,
    addEventListener: (type: string, fn: (ev: any) => void) => { (listeners[type] ??= []).push(fn); },
    postMessage: (data: unknown) => { toPage.push(data); },
  };
  g.chrome = {
    runtime: {
      id: 'wallet-extension-id', lastError: undefined,
      sendMessage: (msg: unknown, cb?: (r: unknown) => void) => { toWallet.push(msg); cb?.(reply(msg)); },
      onMessage: { addListener: (fn: typeof fromWallet) => { fromWallet = fn; } },
    },
  };
  vi.resetModules();
  await import('@/provider/content');
  const fire = (type: string, ev: any) => { for (const fn of listeners[type] ?? []) fn(ev); };
  return {
    toWallet, toPage,
    request: (id: string, method: string, params: unknown) => fire('message', { source: g.window, origin, data: { target: 'kusdt-wallet-content', id, method, params } }),
    event: (msg: unknown) => fromWallet!(msg, { id: 'wallet-extension-id' }),
    pagehide: (isTrusted = true) => fire('pagehide', { type: 'pagehide', isTrusted }),
  };
}

const ADDRESS = 'kaspatest:qqkqkzjvr7zwxxmjxjkmxxdwju9kjs6e9u82uh59z07vgaks6gg62v8707g73';

// Daybreak [55]: whatever a page put in a request's params (a 2,000,000-element array, a 50,000-deep object) was handed
// to chrome.runtime.sendMessage as it was, for the wallet to copy and read. Requests are a few short strings, so params
// past a size or a depth bound are refused in the page, before anything is sent.
describe('Daybreak [55]: params past the bounds never leave the page', () => {
  it('a huge array, a deep object, a long string and a value JSON has no form for are refused before sendMessage', async () => {
    const p = await page('https://evil.example');
    let deep: any = {};
    const top = deep;
    for (let i = 0; i < 50_000; i++) { deep.x = {}; deep = deep.x; }
    const cases: [string, unknown][] = [
      ['big1234a', Array.from({ length: 2_000_000 }, (_, i) => i)],
      ['deep1234', top],
      ['long1234', { to: 'k'.repeat(100_000), amount: '1' }],
      ['wide1234', Object.fromEntries(Array.from({ length: 10_000 }, (_, i) => [`k${i}`, i]))],
      ['bigint12', { amount: 10n }],
    ];
    for (const [id, params] of cases) p.request(id, 'kusdt_send', params);
    // (Ids only: printing what was relayed, were any of it, would take longer than the test.)
    expect(p.toWallet.map(m => m.id)).toEqual([]);
    expect(p.toPage.map(m => [m.id, m.error?.code])).toEqual(cases.map(([id]) => [id, -32602]));
  });

  it('what every method takes still goes through as it is', async () => {
    const p = await page('https://bridge.example', () => ({ result: 'ok' }));
    const cases: [string, string, unknown][] = [
      ['send1234', 'kusdt_send', [{ to: ADDRESS, amount: '1000000' }]],
      ['redeem12', 'kusdt_redeem', { chain: 'bsc', address: '0x90F79bf6EB2c4f870365E785982E1f101E93b906', amount: 1_000_000 }],
      ['swap1234', 'kusdt_swap', { side: 'buy', amountIn: '100000000', minOut: '1' }],
      ['remove12', 'kusdt_removeLiquidity', { position: `${'ab'.repeat(32)}:1` }],
      ['switch12', 'kaspa_switchNetwork', [{ network: 'testnet-10' }]],
      ['accounts', 'kaspa_requestAccounts', {}],
      // A few levels deep and a few hundred characters of extras: still within the bounds.
      ['nested12', 'kusdt_send', { to: ADDRESS, amount: '1', meta: { app: { name: 'x'.repeat(200), tags: ['a', 'b'] } } }],
    ];
    for (const [id, method, params] of cases) p.request(id, method, params);
    expect(p.toWallet.map(m => [m.id, m.method, m.params])).toEqual(cases);
    expect(p.toPage.map(m => [m.id, m.result])).toEqual(cases.map(([id]) => [id, 'ok']));
  });
});

// Daybreak [32], the content script's half: an account event was posted to whatever page the tab showed by the time it
// arrived. It is posted only to the origin the wallet decided it for.
describe('Daybreak [32] (content script): an account event reaches only the origin it was meant for', () => {
  it('is posted to a page of that origin, and never to another page the tab now shows', async () => {
    const p = await page('https://evil.example');
    p.event({ kind: 'kusdt-provider-event', event: 'accountsChanged', data: [ADDRESS], origin: 'https://bridge.example' });
    p.event({ kind: 'kusdt-provider-event', event: 'accountsChanged', data: [ADDRESS] });
    p.event({ kind: 'kusdt-provider-event', event: 'networkChanged', data: 'simnet', origin: 'https://bridge.example' });
    expect(p.toPage).toEqual([]);
    p.event({ kind: 'kusdt-provider-event', event: 'accountsChanged', data: [], origin: 'https://evil.example' });
    p.event({ kind: 'kusdt-provider-event', event: 'networkChanged', data: 'simnet', origin: 'https://evil.example' });
    expect(p.toPage).toEqual([
      { target: 'kusdt-wallet-inpage', event: 'accountsChanged', data: [] },
      { target: 'kusdt-wallet-inpage', event: 'networkChanged', data: 'simnet' },
    ]);
  });
});

// Daybreak [28], the page's half: a page going away says which of its requests it was still waiting for, so the
// wallet lets them go rather than keep an approval window open for nobody.
describe('Daybreak [28] (content script): a page going away lets its waiting requests go', () => {
  it('names, at pagehide, the requests it still waits an answer for', async () => {
    const p = await page('https://bridge.example', (msg) => (msg.id === 'answered' ? { result: 1 } : { pending: true }));
    p.request('answered', 'kaspa_getNetwork', {});
    p.request('waiting1', 'kusdt_send', { to: ADDRESS, amount: '1' });
    // A page's own "pagehide" (dispatched by its script) is not the page going away.
    p.pagehide(false);
    expect(p.toWallet.filter(m => m.kind !== 'kusdt-provider')).toEqual([]);
    p.pagehide();
    expect(p.toWallet.filter(m => m.kind !== 'kusdt-provider')).toEqual([{ kind: 'kusdt-provider-gone', ids: ['waiting1'] }]);
  });

  it('says nothing when it waits for nothing', async () => {
    const p = await page('https://bridge.example', () => ({ result: 1 }));
    p.request('answered', 'kaspa_getNetwork', {});
    p.pagehide();
    expect(p.toWallet.filter(m => m.kind !== 'kusdt-provider')).toEqual([]);
  });
});
