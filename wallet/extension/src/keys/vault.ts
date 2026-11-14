// The recovery phrase at rest: sealed with the user's password (keys/crypto.ts)
// in chrome.storage.local, which web pages and content scripts never read.
// Nothing else secret is ever stored: every key is derived from the phrase
// when needed. The wallet has no way to show or export a key or the phrase
// after onboarding.

import { local } from '@/lib/storage';
import { NETWORKS } from '@/config/networks';
import { connectionsKey } from '@/provider/protocol';
import { open, seal, type SealedBox } from './crypto';
import { cleanMnemonic } from './derive';

export const VAULT_KEY = 'kusdt.vault';
export const MIN_PASSWORD = 8;

interface StoredVault { sealed: SealedBox; createdAt: number; version: 1 }

export async function hasVault(): Promise<boolean> {
  return !!(await local.get<StoredVault>(VAULT_KEY))?.sealed;
}

/** A site's approval names one wallet's addresses: it must not outlive that wallet. */
async function forgetConnections(): Promise<void> {
  for (const network of Object.keys(NETWORKS)) await local.remove(connectionsKey(network));
}

/**
 * The password as it is sealed (R21-W2-6): NFKC, so the same password typed in another Unicode form (an accent as one
 * character or as two, from another keyboard or system) is the same password. A vault sealed before took the password
 * as it was typed, so openVault tries that form too.
 */
const sealedForm = (password: string): string => password.normalize('NFKC');

/** Refuses while a wallet exists (R21-W2-6): replacing it, and with it every site connection, takes Remove first. */
export async function createVault(mnemonic: string, password: string): Promise<void> {
  if (await hasVault()) throw new Error('This browser already holds a kUSDT Wallet. Remove it in Settings first; its recovery phrase is its only backup.');
  await forgetConnections();
  const m = cleanMnemonic(mnemonic);
  if (!m) throw new Error('That is not a valid recovery phrase.');
  if (password.length < MIN_PASSWORD) throw new Error(`Use a password of at least ${MIN_PASSWORD} characters.`);
  const sealed = await seal(m, sealedForm(password));
  // Proven to open before it is kept.
  if ((await open(sealed, sealedForm(password))) !== m) throw new Error('Could not seal the wallet. Nothing was saved.');
  await local.set({ [VAULT_KEY]: { sealed, createdAt: Date.now(), version: 1 } satisfies StoredVault });
}

/** The phrase, or null for a wrong password. */
export async function openVault(password: string): Promise<string | null> {
  const v = await local.get<StoredVault>(VAULT_KEY);
  if (!v?.sealed) return null;
  const opened = await open(v.sealed, sealedForm(password));
  return opened ?? (sealedForm(password) === password ? null : open(v.sealed, password));
}

export async function changePassword(oldPw: string, newPw: string): Promise<boolean> {
  if (newPw.length < MIN_PASSWORD) return false;
  const m = await openVault(oldPw);
  if (!m) return false;
  const sealed = await seal(m, sealedForm(newPw));
  if ((await open(sealed, sealedForm(newPw))) !== m) return false;
  const v = await local.get<StoredVault>(VAULT_KEY);
  await local.set({ [VAULT_KEY]: { ...(v as StoredVault), sealed } });
  return true;
}

/** Removes the wallet from this browser (the phrase is the only backup). */
export async function removeVault(): Promise<void> {
  await forgetConnections();
  await local.remove(VAULT_KEY);
}
