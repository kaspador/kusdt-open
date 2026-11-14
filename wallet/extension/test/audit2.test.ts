// Security audit 2 of the wallet. As in adversarial.test.ts, a test marked

import { describe, expect, it, vi } from 'vitest';

// lib/storage.ts falls back to its in-memory areas when chrome.storage.local and
// .session are missing, so only the parts the background touches are stubbed.
const h = vi.hoisted(() => {
  const state = {
    listener: null as null | ((msg: unknown, sender: unknown, sendResponse: (r: unknown) => void) => boolean),
    windowsOpened: 0,
  };
  (globalThis as { chrome?: unknown }).chrome = {
    storage: { onChanged: { addListener() {} } },
    runtime: { id: 'wallet-extension-id', lastError: undefined, onMessage: { addListener(fn: typeof state.listener) { state.listener = fn; } } },
    windows: {
      onRemoved: { addListener() {} },
      get(_id: number, cb: (w?: unknown) => void) { cb(undefined); },
      getLastFocused(_o: unknown, cb: (w?: unknown) => void) { cb(undefined); },
      create(_o: unknown, cb: (w?: unknown) => void) { state.windowsOpened++; cb({ id: 1 }); },
      update() {},
    },
    tabs: { sendMessage() {}, query(_o: unknown, cb: (t: unknown[]) => void) { cb([]); } },
  };
  return state;
});

import { KASPA_NETWORKS } from '@kusdt/kaspa';
import { registerProvider } from '@/background/provider';
import { createVault, removeVault } from '@/keys/vault';
import { lock, unlockWith } from '@/keys/session';
import { hdFromMnemonic, walletKeys } from '@/keys/derive';
import { connectionsKey, type Connection } from '@/provider/protocol';
import { local } from '@/lib/storage';

const NETWORK = 'testnet-10' as const;
const SITE = 'https://bridge.example';
const OLD_PHRASE = `${'abandon '.repeat(23)}art`;
const NEW_PHRASE = 'legal winner thank year wave sausage worth useful legal winner thank year wave sausage worth useful legal winner thank year wave sausage worth title';
const PASSWORD = 'correct horse battery';

const keysOf = (phrase: string) => walletKeys(hdFromMnemonic(phrase), KASPA_NETWORKS[NETWORK]);

function ask(method: string): Promise<{ result?: unknown; error?: unknown; pending?: boolean }> {
  const sender = { id: 'wallet-extension-id', origin: SITE, url: `${SITE}/bridge`, tab: { id: 7, windowId: 1 }, frameId: 0 };
  return new Promise((resolve) => {
    h.listener!({ kind: 'kusdt-provider', id: 'audit2-request-1', method, params: {} }, sender, resolve as (r: unknown) => void);
  });
}

registerProvider();

describe('a site connected before the wallet was removed and replaced', () => {
  // A connection names one wallet: removing or replacing the wallet forgets it, so the site is asked again.
  it('is not told the removed wallet\'s address as the account of the new wallet', async () => {
    const before = keysOf(OLD_PHRASE), after = keysOf(NEW_PHRASE);
    expect(before.main.address).not.toBe(after.main.address);

    // Wallet A, and the site approved exactly as screens/Approve.tsx:93 records it.
    await createVault(OLD_PHRASE, PASSWORD);
    await unlockWith(OLD_PHRASE);
    const connection: Connection = { origin: SITE, address: before.main.address, ownerHex: before.ownerHex, kasAddresses: before.scan.map(k => k.address), at: 1 };
    await local.set({ [connectionsKey(NETWORK)]: { [SITE]: connection } });

    // Remove wallet (screens/Settings.tsx RemovePage), then a different wallet is created in the same browser.
    await lock();
    await removeVault();
    await createVault(NEW_PHRASE, PASSWORD);
    await unlockWith(NEW_PHRASE);

    const answer = await ask('kaspa_requestAccounts');

    // Safe: the site is unknown to the new wallet (the user approves it again), or it gets the new wallet's account.
    const accounts = (answer.result ?? []) as string[];
    expect(accounts).not.toContain(before.main.address);
    expect(await local.get(connectionsKey(NETWORK))).toBeUndefined();
  });
});
