// Answering a page from the approval window (or the background).

import { session } from '@/lib/storage';
import { MSG_ANSWER, REQUEST_KEY, nextDeclines, requestExpired, type Declines, type PendingRequest, type ProviderError } from './protocol';

export const DECLINES_KEY = 'kusdt.provider.declines';

export function answerTab(req: Pick<PendingRequest, 'tabId' | 'id'>, body: { result: unknown } | { error: ProviderError }): void {
  try { chrome.tabs.sendMessage(req.tabId, { kind: MSG_ANSWER, id: req.id, body }, () => { void chrome.runtime.lastError; }); } catch { /* tab gone */ }
}

/** Counts a decision for the request's site and for its tab (run 20, PUB20-2: a page that changes its name is still that tab). */
export async function recordDecision(req: Pick<PendingRequest, 'origin' | 'tabId'>, approved: boolean): Promise<void> {
  const all = (await session.get<Declines>(DECLINES_KEY)) ?? {};
  await session.set({ [DECLINES_KEY]: nextDeclines(all, req.origin, approved, Date.now(), req.tabId) });
}

export async function readPending(): Promise<PendingRequest | null> {
  return (await session.get<PendingRequest>(REQUEST_KEY)) ?? null;
}

/**
 * The request is let go first (only this one: a newer request is left alone),
 * then the tab hears the answer and the decision is counted. In this order a
 * request the page sends the moment it hears the answer finds no window
 * waiting, instead of being told the wallet is busy (-32002).
 */
export async function finishRequest(req: PendingRequest, body: { result: unknown } | { error: ProviderError }, userDecided = true): Promise<void> {
  const open = await readPending();
  if (!open || open.id === req.id) await session.remove(REQUEST_KEY);
  answerTab(req, body);
  if (!userDecided) return;
  if ('result' in body) await recordDecision(req, true);
  else if (body.error.code === 4001) await recordDecision(req, false);
}

/**
 * Marks, before submitting, that the request's transaction may reach the
 * network; `false` again when nothing was sent after all (the window then asks
 * the user to confirm a new quote).
 *
 * Marking it is the window taking the request (Daybreak [28]): one the
 * background let go (its tab closed, its page went away, another site's request
 * took its place) or one past its time is refused, and nothing is signed for it.
 */
export async function markSending(req: PendingRequest, sending = true): Promise<void> {
  const open = await readPending();
  if (sending && (open?.id !== req.id || requestExpired(open, Date.now()))) {
    throw new Error('This request is no longer waiting: the page that asked for it went away, or it waited too long. Nothing was sent. Ask again from the page.');
  }
  if (open?.id === req.id) await session.set({ [REQUEST_KEY]: { ...open, sending } });
}
