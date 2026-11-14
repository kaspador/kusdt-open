// Run 21 round 2 (adapted from the round-2 reviewer's reproductions), on a fake chrome whose storage can be listed and
// whose listeners are the background's own:
//   R21-W2-4: a locked wallet still told every connected site its account and read its balances, and locked, its
//     user's own node and coordinator (network edits need the unlocked key) gave way to the built-in public ones, so a
//     site's balances request sent the wallet's 41 addresses to the public node network. A locked wallet now tells no
//     site either and reads nothing for them: balances are refused 4100 marked locked, and a connected site's Connect
//     goes to the wallet's window, which asks for the password first (test/run21-locked-connect*.test.ts).
//   R21-W2-6: createVault replaced an existing wallet (and forgot every site connection) without a word, as a setup
//     window left open from before the wallet existed could; and a password typed in another Unicode form (a composed
//     or a decomposed accent) was another password. createVault now refuses while a wallet exists, and the password
//     is sealed as NFKC; opening tries it as typed too, so a wallet sealed before still opens.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { seal } from '@/keys/crypto';

type Area = Map<string, unknown>;
function fakeChrome() {
  const areas: Record<'local' | 'session', Area> = { local: new Map(), session: new Map() };
  const changed: ((c: Record<string, { oldValue?: unknown; newValue?: unknown }>, a: string) => void)[] = [];
  const area = (name: 'local' | 'session') => ({
    get: (keys: string[], cb: (v: Record<string, unknown>) => void) => cb(Object.fromEntries(keys.filter(k => areas[name].has(k)).map(k => [k, structuredClone(areas[name].get(k))]))),
    set: (values: Record<string, unknown>, cb?: () => void) => {
      const c: Record<string, { oldValue?: unknown; newValue?: unknown }> = {};
      for (const [k, v] of Object.entries(values)) { c[k] = { oldValue: areas[name].get(k), newValue: v }; areas[name].set(k, structuredClone(v)); }
      changed.forEach(f => f(c, name)); cb?.();
    },
    remove: (keys: string[] | string, cb?: () => void) => {
      const c: Record<string, { oldValue?: unknown; newValue?: unknown }> = {};
      for (const k of Array.isArray(keys) ? keys : [keys]) { if (areas[name].has(k)) c[k] = { oldValue: areas[name].get(k) }; areas[name].delete(k); }
      changed.forEach(f => f(c, name)); cb?.();
    },
  });
  const listeners: Record<string, ((...a: any[]) => any)[]> = {};
  const on = (name: string) => ({ addListener: (f: (...a: any[]) => any) => { (listeners[name] ??= []).push(f); }, removeListener: () => {} });
  const alarms = new Map<string, unknown>();
  const chrome = {
    storage: { local: area('local'), session: area('session'), onChanged: { addListener: (f: any) => changed.push(f), removeListener: () => {} } },
    alarms: { create: (n: string, i: unknown) => { alarms.set(n, i); }, clear: async (n: string) => alarms.delete(n), onAlarm: on('alarm') },
    runtime: { id: 'extid', onMessage: on('message'), onConnect: on('connect'), onInstalled: on('installed'), onStartup: on('startup'), getURL: (p: string) => `chrome-extension://extid/${p}`, lastError: undefined, getContexts: async () => [] },
    scripting: { registerContentScripts: async () => {}, getRegisteredContentScripts: async () => [] },
    tabs: { onRemoved: on('tabRemoved'), query: (_q: unknown, cb: (t: unknown[]) => void) => cb([]), sendMessage: (_t: number, _m: unknown, cb?: () => void) => cb?.() },
    windows: { onRemoved: on('windowRemoved'), create: (_o: unknown, cb: (w: unknown) => void) => cb({ id: 9 }), get: (_id: number, cb: (w: unknown) => void) => cb(undefined), getLastFocused: (_o: unknown, cb: (w: unknown) => void) => cb(undefined), update: () => {} },
  };
  return { chrome, areas, listeners, alarms };
}

const PHRASE = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const SITE = 'https://site.example';

afterEach(() => { vi.unstubAllGlobals(); vi.resetModules(); });

describe('R21-W2-4: a locked wallet answers no site its account or balances', () => {
  it('after the auto-lock a connected site is told neither, and nothing is read for it; unlocked again, it is answered', async () => {
    const fx = fakeChrome();
    vi.stubGlobal('chrome', fx.chrome);
    const asked: string[] = [];
    vi.stubGlobal('fetch', async (url: unknown) => { asked.push(String(url)); throw new Error('no network in the tests'); });
    vi.resetModules();
    const { createVault } = await import('@/keys/vault');
    const { unlockWith, currentHd } = await import('@/keys/session');
    const { acceptTerms } = await import('@/config/terms');
    const { keysFor } = await import('@/wallet/context');
    await import('@/background/index');
    await acceptTerms();
    await createVault(PHRASE, 'a long password');
    await unlockWith(PHRASE);
    const k = keysFor((await currentHd())!, 'testnet-10');
    fx.areas.local.set('kusdt.connections.testnet-10', { [SITE]: { origin: SITE, address: k.main.address, ownerHex: k.ownerHex, kasAddresses: k.scan.map(s => s.address), at: 1 } });
    let seq = 0;
    const ask = (method: string) => new Promise<any>(res => {
      for (const f of fx.listeners.message ?? []) f({ kind: 'kusdt-provider', id: `locked-${String(++seq).padStart(4, '0')}`, method, params: {} }, { id: 'extid', origin: SITE, url: `${SITE}/`, tab: { id: 3, active: true }, frameId: 0 }, res);
    });
    expect(await ask('kaspa_requestAccounts')).toEqual({ result: [k.main.address] });
    // The auto-lock alarm, through the background's own listener.
    for (const f of fx.listeners.alarm ?? []) f({ name: 'kusdt.autolock' });
    await new Promise(r => setTimeout(r, 20));
    expect(fx.areas.session.has('kusdt.session.phrase')).toBe(false);
    const accounts = await ask('kaspa_requestAccounts');
    const balances = await ask('kusdt_getBalances');
    // The account goes through the window, which asks for the password first: here, only that it is asked for.
    expect(accounts).toEqual({ pending: true });
    expect(balances.error).toEqual({ code: 4100, message: expect.stringMatching(/locked/i), data: { locked: true } });
    expect(asked).toEqual([]);
    // The network's name is public, locked or not.
    expect((await ask('kaspa_getNetwork')).result).toBe('testnet-10');
    await unlockWith(PHRASE);
    expect(await ask('kaspa_requestAccounts')).toEqual({ result: [k.main.address] });
  }, 60_000);
});

describe('R21-W2-6: the vault', () => {
  it('is not replaced while it exists: a second createVault is refused, and the wallet and its sites stay', async () => {
    const fx = fakeChrome();
    vi.stubGlobal('chrome', fx.chrome);
    vi.resetModules();
    const { createVault, openVault } = await import('@/keys/vault');
    const first = 'legal winner thank year wave sausage worth useful legal winner thank yellow';
    const second = 'letter advice cage absurd amount doctor acoustic avoid letter advice cage above';
    await createVault(first, 'first password');
    fx.areas.local.set('kusdt.connections.testnet-10', { [SITE]: { origin: SITE } });
    await expect(createVault(second, 'second password')).rejects.toThrow(/already/i);
    expect(await openVault('first password')).toBe(first);
    expect(await openVault('second password')).toBeNull();
    expect(fx.areas.local.has('kusdt.connections.testnet-10')).toBe(true);
  }, 60_000);

  it('opens with the password typed in another Unicode form, and a wallet sealed before (as typed) still opens', async () => {
    const fx = fakeChrome();
    vi.stubGlobal('chrome', fx.chrome);
    vi.resetModules();
    const { createVault, openVault, changePassword, removeVault, VAULT_KEY } = await import('@/keys/vault');
    const nfc = 'Pässwörd-é-2026'.normalize('NFC'), nfd = nfc.normalize('NFD');
    expect(nfc).not.toBe(nfd);
    await createVault(PHRASE, nfc);
    expect(await openVault(nfd)).toBe(PHRASE);
    expect(await openVault(nfc)).toBe(PHRASE);
    expect(await openVault('Passwörd-é-2026')).toBeNull();
    // A new password, typed decomposed, opens composed too.
    const next = 'Ünïcödé-pässwörd'.normalize('NFD');
    expect(await changePassword(nfd, next)).toBe(true);
    expect(await openVault(next.normalize('NFC'))).toBe(PHRASE);
    expect(await openVault(nfc)).toBeNull();
    // A vault sealed before this, with the password as it was typed (decomposed here): typed the same, it opens.
    await removeVault();
    fx.areas.local.set(VAULT_KEY, { sealed: await seal(PHRASE, nfd), createdAt: 1, version: 1 });
    expect(await openVault(nfd)).toBe(PHRASE);
  }, 120_000);
});
