// Relays window.kusdt requests (inpage.ts) to the background and answers back.
// Decides nothing and never reads the wallet's storage.

const TO_CONTENT = 'kusdt-wallet-content';
const TO_PAGE = 'kusdt-wallet-inpage';

function toPage(body: Record<string, unknown>): void {
  window.postMessage({ target: TO_PAGE, ...body }, window.location.origin);
}

/** The requests this page has sent and not had answered yet. */
const waiting = new Set<string>();

/**
 * Whether this script lost the wallet. After the extension is reloaded or
 * updated, a page opened before keeps this script, cut off: chrome.runtime.id
 * is gone and sendMessage throws ("Extension context invalidated").
 */
function cutOff(): boolean {
  try { return !chrome.runtime?.id; } catch { return true; }
}

/** Answers a request, and every one still waiting, that the page must be reloaded to reach the wallet. */
function answerCutOff(id: string): void {
  const error = { code: 4900, message: 'kUSDT Wallet was reloaded or updated. Reload this page to reach it.' };
  waiting.add(id);
  for (const w of waiting) toPage({ id: w, error });
  waiting.clear();
}

chrome.runtime.onMessage.addListener((msg: { kind?: string; id?: string; body?: { result?: unknown; error?: unknown }; event?: string; data?: unknown; origin?: string }, sender) => {
  if (sender.id !== chrome.runtime.id) return;
  if (msg?.kind === 'kusdt-provider-answer' && typeof msg.id === 'string' && waiting.has(msg.id)) {
    waiting.delete(msg.id);
    toPage({ id: msg.id, ...(msg.body ?? { error: { code: -32603, message: 'kUSDT Wallet did not answer.' } }) });
  }
  // An event names the origin the wallet decided it for. The tab may have moved to another site's page since, which
  // must not hear another site's account (Daybreak [32]): it is posted only to a page of that origin.
  if (msg?.kind === 'kusdt-provider-event' && (msg.event === 'accountsChanged' || msg.event === 'networkChanged') && msg.origin === window.location.origin) {
    toPage({ event: msg.event, data: msg.data });
  }
});

/**
 * The most a request's params may hold (Daybreak [55]). Whatever a page put there was handed to
 * chrome.runtime.sendMessage as it was, for the wallet to copy and read: a 2,000,000-element array, a 50,000-deep
 * object. Every method takes a few short strings (provider/protocol.ts), so params are refused here, before anything
 * is sent, when they hold more than MAX_PARAMS_SIZE characters (strings and keys, and one for every other value), are
 * nested more than MAX_PARAMS_DEPTH deep, or hold anything but JSON's values.
 */
const MAX_PARAMS_SIZE = 4_096, MAX_PARAMS_DEPTH = 4;

function paramsFit(params: unknown): boolean {
  let left = MAX_PARAMS_SIZE;
  const todo: [unknown, number][] = [[params, 1]];
  while (todo.length) {
    const [v, depth] = todo.pop()!;
    if (typeof v === 'string') left -= v.length;
    else if (v === null || v === undefined || typeof v === 'number' || typeof v === 'boolean') left -= 1;
    else if (Array.isArray(v) || (typeof v === 'object' && Object.getPrototypeOf(v) === Object.prototype)) {
      // An array's length is known at once: one too long is not walked.
      if (depth > MAX_PARAMS_DEPTH || (Array.isArray(v) && v.length > left)) return false;
      for (const k in v) {
        left -= k.length + 1;
        if (left < 0) return false;
        todo.push([(v as Record<string, unknown>)[k], depth + 1]);
      }
    } else return false;
    if (left < 0) return false;
  }
  return true;
}

/** A page with an opaque origin (sandboxed): its URL names a site it is not, so nothing of it is relayed. */
function opaque(ev: MessageEvent): boolean {
  return ev.origin === 'null' || window.origin === 'null' || window.location.origin === 'null';
}

window.addEventListener('message', (ev: MessageEvent) => {
  if (ev.source !== window || opaque(ev) || ev.origin !== window.location.origin) return;
  const d = ev.data as { target?: string; id?: unknown; method?: unknown; params?: unknown } | null;
  if (!d || d.target !== TO_CONTENT || typeof d.id !== 'string' || typeof d.method !== 'string') return;
  if (d.id.length > 64 || d.method.length > 40) return;
  const id = d.id;
  if (!paramsFit(d.params)) { toPage({ id, error: { code: -32602, message: 'kUSDT Wallet did not understand that request: its params are too large, too deep, or not JSON.' } }); return; }
  if (cutOff()) { answerCutOff(id); return; }
  waiting.add(id);
  try {
    chrome.runtime.sendMessage({ kind: 'kusdt-provider', id, method: d.method, params: d.params ?? {} },
      (r: { result?: unknown; error?: unknown; pending?: boolean } | undefined) => {
        if (chrome.runtime.lastError) { waiting.delete(id); toPage({ id, error: { code: 4900, message: 'kUSDT Wallet is not available. Reload the page.' } }); return; }
        // Pending: the wallet's window answers it (kusdt-provider-answer), maybe before this callback runs.
        if (r?.pending) return;
        waiting.delete(id);
        toPage({ id, ...(r ?? { error: { code: -32603, message: 'kUSDT Wallet did not answer.' } }) });
      });
  } catch {
    answerCutOff(id);
  }
});

// The page going away (navigating elsewhere, its tab closing, into the back/forward cache) tells the wallet which of
// its requests it was still waiting for, and the wallet lets them go rather than keep its window open for a page that
// is gone (Daybreak [28]). A page's own script can dispatch a "pagehide" too: only the browser's counts.
window.addEventListener('pagehide', (ev: PageTransitionEvent) => {
  if (!ev.isTrusted || waiting.size === 0 || cutOff()) return;
  chrome.runtime.sendMessage({ kind: 'kusdt-provider-gone', ids: [...waiting] }, () => { void chrome.runtime.lastError; });
});

export {};
