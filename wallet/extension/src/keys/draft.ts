// The recovery phrase of a wallet still being created. Until the wallet exists it
// stays the same, however often the window closes or falls behind: someone who
// has already saved it must never be shown different words. It sits where the
// unlocked phrase sits (chrome.storage.session: memory only, the wallet's own
// pages and service worker), holds no funds yet, and goes when the wallet is
// created or the browser closes.

import { session } from '@/lib/storage';
import { newMnemonic } from './derive';

const DRAFT_KEY = 'kusdt.onboard.phrase';

export const readDraft = (): Promise<string | undefined> => session.get<string>(DRAFT_KEY);

export async function draftPhrase(): Promise<string> {
  const had = await readDraft();
  if (had) return had;
  const fresh = newMnemonic();
  await session.set({ [DRAFT_KEY]: fresh });
  return fresh;
}

export const clearDraft = (): Promise<void> => session.remove(DRAFT_KEY);
