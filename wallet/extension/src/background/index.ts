// The background service worker:
//   • auto-lock: the alarm, or the popup closing when auto-lock is "immediately",
//     clears the unlocked phrase from chrome.storage.session;
//   • window.kusdt: registers the page script (MAIN world) and answers
//     requests (background/provider.ts). Nothing is signed here.

import { registerProvider } from './provider';
import { SESSION_KEY, AUTOLOCK_ALARM, CLOSE_CHECK_ALARM, lockIfNoPageOpen } from '@/keys/session';
import { session } from '@/lib/storage';
import { loadSettings } from '@/config/settings';
import { PAGE_MATCHES } from '@/provider/matches';

registerProvider();

/** Whether any page of this wallet is open: the popup, or an approval window. */
async function walletPageOpen(): Promise<boolean> {
  const runtime = chrome.runtime as unknown as { getContexts?: (f: { contextTypes: string[] }) => Promise<unknown[]> };
  if (runtime.getContexts) return (await runtime.getContexts({ contextTypes: ['POPUP', 'TAB'] })).length > 0;
  // Chrome before 116.
  const clients = (self as unknown as { clients: { matchAll: (o: object) => Promise<unknown[]> } }).clients;
  return (await clients.matchAll({ includeUncontrolled: true, type: 'window' })).length > 0;
}

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === AUTOLOCK_ALARM) session.remove(SESSION_KEY).catch(() => {});
  if (alarm.name === CLOSE_CHECK_ALARM) lockIfNoPageOpen(walletPageOpen).catch(() => {});
});

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'popup' || !port.sender?.url?.startsWith(chrome.runtime.getURL(''))) return;
  port.onDisconnect.addListener(async () => {
    if ((await loadSettings()).autoLockMins === 0) await session.remove(SESSION_KEY);
  });
});

const INPAGE_ID = 'kusdt-inpage';

/** window.kusdt in each page's own world, before the page's scripts run. */
async function registerInpage(): Promise<void> {
  if (!chrome.scripting?.registerContentScripts) return;
  const existing = await chrome.scripting.getRegisteredContentScripts({ ids: [INPAGE_ID] }).catch(() => []);
  if (existing.length) return;
  await chrome.scripting.registerContentScripts([{
    id: INPAGE_ID, js: ['inpage.js'], matches: [...PAGE_MATCHES], runAt: 'document_start', world: 'MAIN', allFrames: false, persistAcrossSessions: true,
  }]).catch(() => {});
}
chrome.runtime.onInstalled.addListener(() => { registerInpage(); });
chrome.runtime.onStartup.addListener(() => { registerInpage(); });
registerInpage();

export {};
