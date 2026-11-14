// Round 10, finding 6: a sandboxed page (user-supplied HTML served with
// "CSP: sandbox allow-scripts" under a connected site's URL) has an opaque
// origin, "null". The background fell back from it to the URL's origin, so the
// approval window named the connected site. An opaque origin is nobody's site.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { senderOrigin } from '@/provider/protocol';

describe('the origin of a request', () => {
  const tab = { id: 1 };

  it('is never the URL\'s site for a page whose origin is opaque', () => {
    expect(senderOrigin({ id: 'ext', tab, frameId: 0, origin: 'null', url: 'https://app.example/uploads/page.html' }, 'ext')).toBeNull();
    expect(senderOrigin({ id: 'ext', tab, frameId: 0, origin: 'null', url: 'http://localhost:5173/x' }, 'ext')).toBeNull();
    expect(senderOrigin({ id: 'ext', tab, frameId: 0, origin: 'null' }, 'ext')).toBeNull();
  });

  it('is still the browser\'s origin for a page that has one, and the URL\'s where the browser names none', () => {
    expect(senderOrigin({ id: 'ext', tab, frameId: 0, origin: 'https://app.example', url: 'https://app.example/x' }, 'ext')).toBe('https://app.example');
    expect(senderOrigin({ id: 'ext', tab, url: 'http://localhost:5173/x' }, 'ext')).toBe('http://localhost:5173');
  });
});

describe('the content script', () => {
  /* eslint-disable @typescript-eslint/no-explicit-any */
  const g = globalThis as any;
  const before = { window: g.window, chrome: g.chrome };
  afterEach(() => { g.window = before.window; g.chrome = before.chrome; vi.resetModules(); });

  /** Loads the content script in a page with these origins; answers how to post it a message and what it relayed. */
  async function page(origins: { location: string; own: string }) {
    const listeners: ((ev: any) => void)[] = [];
    const sendMessage = vi.fn();
    g.window = { location: { origin: origins.location }, origin: origins.own, postMessage: vi.fn(), addEventListener: (type: string, fn: (ev: any) => void) => { if (type === 'message') listeners.push(fn); } };
    g.chrome = { runtime: { id: 'ext', onMessage: { addListener() {} }, sendMessage } };
    vi.resetModules();
    await import('@/provider/content');
    const post = (origin: string) => { for (const fn of listeners) fn({ source: g.window, origin, data: { target: 'kusdt-wallet-content', id: 'r1', method: 'kaspa_requestAccounts', params: {} } }); };
    return { post, sendMessage };
  }

  it('relays a page\'s request to the wallet', async () => {
    const p = await page({ location: 'https://app.example', own: 'https://app.example' });
    p.post('https://app.example');
    expect(p.sendMessage).toHaveBeenCalledTimes(1);
  });

  it('relays nothing from a page with an opaque origin', async () => {
    // "null" === "null" used to pass the same-origin check.
    const both = await page({ location: 'null', own: 'null' });
    both.post('null');
    expect(both.sendMessage).not.toHaveBeenCalled();
    // The page's own origin is opaque although its URL names a site.
    const sandboxed = await page({ location: 'https://app.example', own: 'null' });
    sandboxed.post('https://app.example');
    sandboxed.post('null');
    expect(sandboxed.sendMessage).not.toHaveBeenCalled();
  });
});
