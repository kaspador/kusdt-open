// The unlocked wallet. The phrase is kept in chrome.storage.session (memory
// only, readable by the wallet's own pages and service worker, never by
// content scripts or web pages) so reopening the popup within the auto-lock
// time needs no password. The auto-lock alarm (background) and Lock clear it.

import type { HDKey } from '@scure/bip32';
import { session, local } from '@/lib/storage';
import { hdFromMnemonic, walletKeys } from './derive';
import { KASPA_NETWORKS } from '@kusdt/kaspa/network';
import { KASPA_NETWORK_NAMES } from '@/config/defaults';
import { SESSION_PHRASE_KEY } from '@/config/settings';

/**
 * The wallet's own address on each network (public), written at unlock and kept until the browser closes. The
 * service worker answers a site's "which account" from this, never from the stored connection: that one is in
 * local storage, written without the password, and an address swapped there became "your kUSDT Wallet address" on
 * the web app's deposit form.
 */
export const OWN_KEY = 'kusdt.own.addresses';
export type OwnAddresses = Record<string, { address: string; ownerHex: string; kasAddresses: string[] }>;
export const ownAddresses = async (): Promise<OwnAddresses> => (await session.get<OwnAddresses>(OWN_KEY)) ?? {};

export const SESSION_KEY = SESSION_PHRASE_KEY;
export const AUTOLOCK_ALARM = 'kusdt.autolock';
/**
 * For "when the popup closes": every minute, is a wallet page still open? The port's disconnect is only the fast path, as a
 * service worker that has gone to sleep never hears it, and the phrase would stay unlocked until the browser exits.
 */
export const CLOSE_CHECK_ALARM = 'kusdt.autolock.closed';

let hd: HDKey | null = null;

/**
 * How many times this page's unlock has ended (Daybreak [15]): by Lock, by the wallet's removal, or by the phrase
 * leaving the session from anywhere else (the auto-lock alarm, the close check, Lock in another window). A signer hands
 * out keys only while the count is the one it was made at (wallet/context.ts signerOf), so what was under way when the
 * wallet locked stops before its next signature, and unlocking again does not bring it back.
 */
let locks = 0;
export const lockCount = (): number => locks;

/**
 * The count each key unlocked or restored here was made under. A signer counts from its key's, not from the moment it
 * is made (run 21, reviewer RV-W): a window that has not heard of a lock yet can still hold the key and make a signer
 * from it, and that signer must refuse as the earlier ones do.
 */
const madeUnder = new WeakMap<HDKey, number>();
export const lockCountOf = (key: HDKey): number => madeUnder.get(key) ?? locks;

// chrome.storage tells every page of the wallet when the phrase leaves the session: the unlock ends here too.
(globalThis as { chrome?: typeof chrome }).chrome?.storage?.onChanged?.addListener((changes, area) => {
  if (area === 'session' && SESSION_KEY in changes && changes[SESSION_KEY].newValue === undefined) forgetInMemory();
});

async function scheduleAutoLock(): Promise<void> {
  const c = (globalThis as { chrome?: typeof chrome }).chrome;
  if (!c?.alarms) return;
  const s = await local.get<{ autoLockMins?: number }>('kusdt.settings');
  // One of the times the wallet offers: a stored ten million minutes would be a wallet that never locks.
  const mins = typeof s?.autoLockMins === 'number' && [0, 5, 15, 60].includes(s.autoLockMins) ? s.autoLockMins : 15;
  await c.alarms.clear(AUTOLOCK_ALARM);
  await c.alarms.clear(CLOSE_CHECK_ALARM);
  if (mins > 0) c.alarms.create(AUTOLOCK_ALARM, { delayInMinutes: mins });
  else c.alarms.create(CLOSE_CHECK_ALARM, { periodInMinutes: 1 });
}

/** The auto-lock setting changed: applies it to a wallet that is unlocked now. */
export async function rearmAutoLock(): Promise<void> {
  if (await session.get<string>(SESSION_KEY)) await scheduleAutoLock();
}

/** The close check's alarm: with no wallet page open, the wallet locks. A check that can't answer locks too. */
export async function lockIfNoPageOpen(pageOpen: () => Promise<boolean>): Promise<void> {
  if (await pageOpen().catch(() => false)) return;
  await session.remove(SESSION_KEY);
  const c = (globalThis as { chrome?: typeof chrome }).chrome;
  await c?.alarms?.clear(CLOSE_CHECK_ALARM);
}

export async function unlockWith(mnemonic: string): Promise<void> {
  hd = hdFromMnemonic(mnemonic);
  madeUnder.set(hd, locks);
  const own: OwnAddresses = {};
  for (const n of KASPA_NETWORK_NAMES) { const k = walletKeys(hd, KASPA_NETWORKS[n]); own[n] = { address: k.main.address, ownerHex: k.ownerHex, kasAddresses: k.scan.map(s => s.address) }; }
  await session.set({ [SESSION_KEY]: mnemonic, [OWN_KEY]: own });
  await scheduleAutoLock();
}

export async function lock(): Promise<void> {
  forgetInMemory();
  await session.remove(SESSION_KEY);
  const c = (globalThis as { chrome?: typeof chrome }).chrome;
  await c?.alarms?.clear(AUTOLOCK_ALARM);
  await c?.alarms?.clear(CLOSE_CHECK_ALARM);
}

/**
 * The unlocked HD key, restored from the session after the popup reopens. Null when locked, and when a lock lands while
 * the phrase is read (run 21, reviewer RV-W): the restore set the key all the same, so the page held a working key with
 * the session empty, and every later call returned it.
 */
export async function currentHd(): Promise<HDKey | null> {
  if (hd) return hd;
  const at = locks;
  const m = await session.get<string>(SESSION_KEY);
  if (!m || locks !== at) return null;
  try { hd = hdFromMnemonic(m); madeUnder.set(hd, at); return hd; } catch { await session.remove(SESSION_KEY); return null; }
}

/** Ends this page's unlock: the key in memory goes, and every signer made from it refuses from now on. */
export function forgetInMemory(): void { hd = null; locks++; }

/** The wallet was removed from this browser: nothing of it answers a site any more. */
export async function forgetWallet(): Promise<void> {
  forgetInMemory();
  await session.remove(OWN_KEY);
}
