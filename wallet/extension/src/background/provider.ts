// window.kusdt requests, in the background (rules: provider/protocol.ts).
// Reads are answered here; connecting, switching the network and every signing
// request open the wallet's approval window, which answers the tab itself
// (screens/Approve.tsx). A network switch it approves is saved to the settings,
// and the storage listener below tells every tab (networkChanged,
// accountsChanged), exactly as for a switch made in the wallet.

import {
  parseRequest, invalidReason, routeRequest, switchRoute, senderOrigin, connectionsKey, REQUEST_KEY, ERR, MSG_REQUEST, MSG_EVENT, MSG_GONE,
  REQUEST_MAX_MS, requestExpired, cooldownOf, tabDeclineKey, type Connection, type Declines, type PendingRequest, type ProviderError, type ProviderRequest,
} from '@/provider/protocol';
import { answerTab, recordDecision, DECLINES_KEY } from '@/provider/answer';
import { local, session } from '@/lib/storage';
import { ownAddresses, SESSION_KEY, type OwnAddresses } from '@/keys/session';
import { loadSettings, mergeConfig, networkLive, SETTINGS_KEY, type Active } from '@/config/settings';
import { NETWORKS } from '@/config/networks';
import { TERMS_REFUSAL, termsAccepted } from '@/config/terms';
import { openCtx, balancesOf } from '@/wallet/context';

type Answer = { result: unknown } | { error: ProviderError } | { pending: true };
const fail = (code: number, message: string): Answer => ({ error: { code, message } });

/**
 * A stored connection as far as it can be trusted: only that the site was approved. Its addresses are replaced by the
 * wallet's own; one that names another address is not this wallet's connection, and a wallet that has not been
 * unlocked since the browser started has no address to answer with yet.
 */
export function ownConnection(stored: Connection | null, own: OwnAddresses[string] | undefined): Connection | null {
  if (!stored || !own || stored.address !== own.address) return null;
  return { ...stored, address: own.address, ownerHex: own.ownerHex, kasAddresses: own.kasAddresses };
}

export async function connectionsOf(network: string): Promise<Record<string, Connection>> {
  return (await local.get<Record<string, Connection>>(connectionsKey(network))) ?? {};
}

async function windowOpen(id?: number): Promise<boolean> {
  if (id == null) return false;
  return new Promise(r => chrome.windows.get(id, () => r(!chrome.runtime.lastError)));
}

const APPROVAL_WIDTH = 400, APPROVAL_HEIGHT = 640;

/**
 * Where the approval window opens: at the right edge of the browser window
 * the request came from, just under its toolbar, where the extension's own
 * popup shows. Without a position Chrome centres it on the screen.
 */
async function besideToolbar(windowId: number | undefined): Promise<{ left?: number; top?: number }> {
  const get = (id: number) => new Promise<chrome.windows.Window | undefined>(r => chrome.windows.get(id, w => r(chrome.runtime.lastError ? undefined : w)));
  const last = () => new Promise<chrome.windows.Window | undefined>(r => chrome.windows.getLastFocused({ windowTypes: ['normal'] }, w => r(chrome.runtime.lastError ? undefined : w)));
  const win = (windowId != null ? await get(windowId) : undefined) ?? await last();
  if (win?.left == null || win.top == null || win.width == null || win.state === 'minimized') return {};
  return { left: Math.max(win.left, win.left + win.width - APPROVAL_WIDTH - 8), top: win.top + 80 };
}

// The approval window is one for every site: the part from the decline check to the window opening runs for one
// request at a time, as it did when every request waited in one queue (two windows, or one request's record
// overwritten by another's, must not happen). Round 14, R14-CL-1: the tab the user is looking at goes first, unless
// the request it would pass has waited more than APPROVAL_FAIR_MS. Each site has at most one request here at a time
// (its own queue runs one by one), so this list is at most one per site.
export const APPROVAL_FAIR_MS = 1_000;
let approving = false;
const approvalWaiters: { active: boolean; at: number; go: () => void }[] = [];

/** Waits for the approval window's turn: true once it is this request's, false after SITE_WAIT_MS without it. */
function approvalTurn(active: boolean): Promise<boolean> {
  if (!approving) { approving = true; return Promise.resolve(true); }
  return new Promise(r => {
    // A turn that never comes (a window Chrome never opens) holds this site's queue no longer than its own wait.
    const w = { active, at: Date.now(), go: () => { clearTimeout(t); r(true); } };
    const t = setTimeout(() => {
      const i = approvalWaiters.indexOf(w);
      if (i >= 0) { approvalWaiters.splice(i, 1); r(false); }
    }, SITE_WAIT_MS);
    approvalWaiters.push(w);
  });
}

function approvalDone(): void {
  const oldest = approvalWaiters[0];
  const looking = approvalWaiters.findIndex(w => w.active);
  const i = oldest && Date.now() - oldest.at <= APPROVAL_FAIR_MS && looking >= 0 ? looking : 0;
  const next = approvalWaiters.splice(i, 1)[0];
  if (next) next.go(); else approving = false;
}

/**
 * kusdt_getBalances, shared (round 14, R14-CL-1): a connected site that asks again and again made the wallet read
 * every KAS address, the kUSDT states and the coordinator for each request. Requests for the same wallet on the same
 * network now share one read while it runs and its answer for BALANCES_SHARED_MS after. A site waits at most
 * BALANCES_WAIT_MS for it, then is told to try again; a read that ran that long is not joined again, so a read that
 * never ends holds nobody past that bound, and a new read starts at most once per BALANCES_WAIT_MS.
 */
export const BALANCES_SHARED_MS = 1_000, BALANCES_WAIT_MS = 30_000;
const balanceReads = new Map<string, { read: Promise<Answer>; started: number; done?: number }>();

function sharedBalances(net: Pick<Active, 'network' | 'config'>, conn: Connection): Promise<Answer> {
  const key = `${net.network}|${conn.address}|${conn.ownerHex}`;
  const now = Date.now();
  // A clock set back makes an answer older, never fresher: one from the future is not used.
  const usable = (e: { started: number; done?: number }) => e.done != null
    ? now >= e.done && now - e.done < BALANCES_SHARED_MS
    : now >= e.started && now - e.started < BALANCES_WAIT_MS;
  for (const [k, e] of balanceReads) if (!usable(e)) balanceReads.delete(k);
  let entry = balanceReads.get(key);
  if (!entry) {
    const read = (async (): Promise<Answer> => {
      try {
        const b = await balancesOf(await openCtx(net), conn.kasAddresses, conn.ownerHex, conn.address);
        return { result: { kas: b.kas.toString(), kusdt: (b.kusdt ?? 0n).toString() } };
      } catch (e) { return fail(ERR.internal, (e as Error).message || 'Could not read balances.'); }
    })();
    const made: { read: Promise<Answer>; started: number; done?: number } = { read, started: now };
    void read.then(() => { made.done = Date.now(); });
    balanceReads.set(key, made);
    entry = made;
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<Answer>(r => { timer = setTimeout(() => r(fail(ERR.internal, 'kUSDT Wallet could not read the balances in time. Try again.')), BALANCES_WAIT_MS); });
  return Promise.race([entry.read, late]).finally(() => clearTimeout(timer));
}

async function handle(req: ProviderRequest, origin: string, sender: chrome.runtime.MessageSender): Promise<Answer> {
  const tabId = sender.tab!.id!;
  // One look at the settings answers the whole request (Daybreak [52]): the network a site is checked against is the
  // one its balances are read on, whatever the wallet switches to while this runs.
  const { network, overrides } = await loadSettings();
  // Until this version of the Terms of Service is accepted, no site is taken as connected, so nothing is answered
  // from an earlier approval: a connect opens the window, which shows the terms before the request (popup/App.tsx),
  // and every other request but the network's name is refused, saying why.
  const accepted = await termsAccepted();
  // Connected: the site was approved, and for the address this wallet has. The account answered is the wallet's own.
  const conn = accepted ? ownConnection((await connectionsOf(network))[origin] ?? null, (await ownAddresses())[network]) : null;
  const route = routeRequest(req.method, !!conn);
  if (route.kind === 'refuse') return { error: accepted || route.error.code !== ERR.unauthorized ? route.error : { code: ERR.unauthorized, message: TERMS_REFUSAL } };
  if (req.params.method === 'kaspa_switchNetwork') {
    // The wallet's own network answers at once; a preset with nothing deployed is refused before any window.
    const target = req.params.network;
    const sw = switchRoute(target, network, networkLive(target, overrides), NETWORKS[target].name);
    if (sw.kind === 'answer') return { result: network };
    if (sw.kind === 'refuse') return { error: sw.error };
  }
  if (route.kind === 'answer') {
    if (req.method === 'kaspa_getNetwork') return { result: network };
    if (await session.get<string>(SESSION_KEY)) {
      if (req.method === 'kaspa_requestAccounts') return { result: [conn!.address] };
      if (req.method === 'kusdt_getBalances') return sharedBalances({ network, config: mergeConfig(network, overrides[network]) }, conn!);
    }
    // A locked wallet tells no site its account or balances (R21-W2-4). Locked, it can't check its user's network edits
    // either (config/settings.ts), so a balances read would ask the built-in public endpoints, not the user's own node
    // and coordinator, about every address of the wallet. The refusal is marked locked, so a page keeps its connection
    // and says so (a plain 4100 had the web app forget it at every auto-lock). A connected site's kaspa_requestAccounts
    // goes on to the window below, which asks for the password and then answers it (screens/Approve.tsx); so does a
    // signing request.
    if (req.method === 'kusdt_getBalances') return { error: { code: ERR.unauthorized, message: 'kUSDT Wallet is locked. Unlock it, then try again.', data: { locked: true } } };
  }
  if (!chrome.windows?.create) return fail(ERR.internal, 'Approvals are not supported in this browser.');
  if (!await approvalTurn(sender.tab?.active === true)) return fail(ERR.busy, 'kUSDT Wallet is busy with another site\'s request. Try again.');
  try { return await approve(req, origin, tabId, network, sender); } finally { approvalDone(); }
}

async function approve(req: ProviderRequest, origin: string, tabId: number, network: string, sender: chrome.runtime.MessageSender): Promise<Answer> {
  // Held by the site's declines, or by its tab's under any name (run 20, PUB20-2); another tab is not held by either.
  const declines = (await session.get<Declines>(DECLINES_KEY)) ?? {}, now = Date.now();
  const wait = Math.max(cooldownOf(declines, origin, now), cooldownOf(declines, tabDeclineKey(tabId), now));
  if (wait > 0) return fail(ERR.busy, `Too many declined requests. Try again in ${Math.ceil(wait / 1000)} s.`);
  const open = await session.get<PendingRequest>(REQUEST_KEY);
  if (open && await windowOpen(open.windowId)) {
    if (open.sending || !requestExpired(open, now)) {
      chrome.windows.update(open.windowId!, { focused: true });
      return fail(ERR.busy, 'kUSDT Wallet is waiting for you to finish another request.');
    }
    // Past its time it holds the window no longer (Daybreak [28]): it is let go, and this request takes its place.
    await dropPending(p => p.id === open.id, `The request waited more than ${REQUEST_MAX_MS / 60_000} minutes without an answer and was let go. Ask again.`);
  }
  const pending: PendingRequest = { ...req, origin, tabId, at: now, expires: now + REQUEST_MAX_MS, network };
  await session.set({ [REQUEST_KEY]: pending });
  const at = await besideToolbar(sender.tab?.windowId);
  const create = (pos: { left?: number; top?: number }) => new Promise<chrome.windows.Window | undefined>(r => chrome.windows.create({
    url: chrome.runtime.getURL(`src/popup/index.html#request=${req.id}`), type: 'popup', width: APPROVAL_WIDTH, height: APPROVAL_HEIGHT, focused: true, ...pos,
  }, w => { void chrome.runtime.lastError; r(w); }));
  // Chrome refuses a position mostly off the visible screen (a browser window wider than its screen, another
  // monitor, a headless screen): then the window opens where Chrome puts it.
  let win = await create(at);
  if (!win?.id && (at.left != null || at.top != null)) win = await create({});
  if (!win?.id) { await session.remove(REQUEST_KEY); return fail(ERR.internal, 'Could not open kUSDT Wallet.'); }
  await session.set({ [REQUEST_KEY]: { ...pending, windowId: win.id } });
  return { pending: true };
}

/**
 * Daybreak [28]: the request the approval window is open for was let go only when its window closed. A page that
 * asked and then went away (its tab closed, or it navigated elsewhere) left the window able to act for it, and every
 * other site busy, until someone closed it. Now the request `which` names is let go: its window is closed, its page
 * answered `message` (4001), and the decline counted, as for a window closed without approval. One already being sent
 * is left to its window, which may have put it on the network. The window takes a request only while it is still the
 * open one (provider/answer.ts markSending), so one let go here can no longer be approved.
 */
async function dropPending(which: (p: PendingRequest) => boolean, message: string): Promise<void> {
  const open = await session.get<PendingRequest>(REQUEST_KEY);
  if (!open || open.sending || !which(open)) return;
  await session.remove(REQUEST_KEY);
  if (open.windowId != null) chrome.windows.remove(open.windowId, () => { void chrome.runtime.lastError; });
  await recordDecision(open, false);
  answerTab(open, { error: { code: ERR.rejected, message } });
}

async function onWindowClosed(windowId: number): Promise<void> {
  const open = await session.get<PendingRequest>(REQUEST_KEY);
  if (!open || open.windowId !== windowId) return;
  await session.remove(REQUEST_KEY);
  if (open.sending) {
    answerTab(open, { error: { code: ERR.internal, message: 'kUSDT Wallet was closed while sending: the transaction may have been sent. Check the wallet before trying again.' } });
    return;
  }
  await recordDecision(open, false);
  answerTab(open, { error: { code: ERR.rejected, message: 'The request was closed without approval.' } });
}

/**
 * Tells pages about a new network, and each connected site its account on it. Every event names the origin it was
 * decided for (Daybreak [32]): a tab is only a number, and by the time an event arrives it may show another site's
 * page, so its content script posts the event only to a page of that origin (provider/content.ts).
 */
async function broadcast(network: string): Promise<void> {
  const conns = await connectionsOf(network);
  const own = (await ownAddresses())[network];
  const tabs = await new Promise<chrome.tabs.Tab[]>(r => chrome.tabs.query({}, t => r(t ?? [])));
  for (const t of tabs) {
    if (t.id == null || !t.url) continue;
    let origin: string;
    try { origin = new URL(t.url).origin; } catch { continue; }
    const send = (event: string, data: unknown) => chrome.tabs.sendMessage(t.id!, { kind: MSG_EVENT, event, data, origin }, () => { void chrome.runtime.lastError; });
    send('networkChanged', network);
    const mine = ownConnection(conns[origin] ?? null, own);
    send('accountsChanged', mine ? [mine.address] : []);
  }
}

export async function accountsChangedFor(network: string, before: Record<string, Connection>, after: Record<string, Connection>): Promise<void> {
  // The wallet's own address or none, here too: this event is how a page learns its account without asking.
  const own = (await ownAddresses())[network];
  const was = (o: string) => ownConnection(before[o] ?? null, own)?.address ?? null;
  const is = (o: string) => ownConnection(after[o] ?? null, own)?.address ?? null;
  const changed = new Set([...Object.keys(before), ...Object.keys(after)].filter(o => was(o) !== is(o)));
  if (changed.size === 0 || (await loadSettings()).network !== network) return;
  const tabs = await new Promise<chrome.tabs.Tab[]>(r => chrome.tabs.query({}, t => r(t ?? [])));
  for (const t of tabs) {
    let origin = '';
    try { origin = new URL(t.url ?? '').origin; } catch { continue; }
    if (t.id == null || !changed.has(origin)) continue;
    chrome.tabs.sendMessage(t.id, { kind: MSG_EVENT, event: 'accountsChanged', data: is(origin) ? [is(origin)] : [], origin }, () => { void chrome.runtime.lastError; });
  }
}

/**
 * Round 14, R14-CL-1: every site's requests waited in one queue, first come first served and without a bound, so a
 * page that sent requests without end (even ones that are refused) held every other site's behind it. Now a request
 * from a page that may not use the wallet, or one that is not understood, is answered at once; each site has a queue
 * of its own, of at most SITE_QUEUE_MAX requests (one more is answered busy at once, before anything is read), whose
 * requests are answered one after the other as before; sites do not wait on each other, only for the approval window
 * (approvalTurn). A request that waited SITE_WAIT_MS is answered busy instead of run, and those a closed tab left
 * waiting are let go.
 */
export const SITE_QUEUE_MAX = 8, SITE_WAIT_MS = 45_000;
interface Waiting { req: ProviderRequest; origin: string; sender: chrome.runtime.MessageSender; at: number; reply: (a: Answer) => void }
interface SiteQueue { waiting: Waiting[]; running: boolean }
const sites = new Map<string, SiteQueue>();
/** How many requests each tab has waiting or running, in every site's queue. */
const tabHeld = new Map<number, number>();

async function drain(origin: string, site: SiteQueue): Promise<void> {
  site.running = true;
  while (site.waiting.length) {
    const w = site.waiting.shift()!;
    // A clock set back a little (time sync) only makes a wait look shorter: the queue's length still bounds it.
    if (Date.now() - w.at > SITE_WAIT_MS) { w.reply(fail(ERR.busy, 'kUSDT Wallet is busy with this site\'s earlier requests. Try again.')); continue; }
    w.reply(await handle(w.req, w.origin, w.sender).catch(() => fail(ERR.internal, 'kUSDT Wallet hit an error.')));
  }
  site.running = false;
  if (sites.get(origin) === site) sites.delete(origin);
}

function enqueue(w: Waiting): void {
  let site = sites.get(w.origin);
  if (!site) { site = { waiting: [], running: false }; sites.set(w.origin, site); }
  if (site.waiting.length + (site.running ? 1 : 0) >= SITE_QUEUE_MAX) {
    w.reply(fail(ERR.busy, 'This site sent kUSDT Wallet too many requests at once. Try again.'));
    return;
  }
  site.waiting.push(w);
  if (!site.running) void drain(w.origin, site);
}

/** Waiting requests whose page is gone are let go: nobody hears their answers, and they no longer take the site's places. */
function dropWaiting(gone: (w: Waiting) => boolean, message: string): void {
  for (const site of sites.values()) {
    const out = site.waiting.filter(gone);
    if (out.length === 0) continue;
    site.waiting = site.waiting.filter(w => !gone(w));
    for (const w of out) w.reply(fail(ERR.disconnected, message));
  }
}

/**
 * A page going away (its content script's pagehide, provider/content.ts) names the requests it was still waiting for,
 * and they are let go, the approval window's too (Daybreak [28]). Only that page can let its own go: the same tab, the
 * same origin, the same request.
 */
function pageGone(msg: unknown, sender: chrome.runtime.MessageSender): void {
  const origin = senderOrigin(sender, chrome.runtime.id), tabId = sender.tab?.id;
  const ids = (msg as { ids?: unknown }).ids;
  if (!origin || tabId == null || !Array.isArray(ids)) return;
  dropWaiting(w => w.sender.tab?.id === tabId && w.origin === origin && ids.includes(w.req.id), 'The page went away.');
  dropPending(p => p.tabId === tabId && p.origin === origin && ids.includes(p.id), 'The page went away before the request was answered.').catch(() => {});
}

export function registerProvider(): void {
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    const kind = (msg as { kind?: string } | null)?.kind;
    if (kind === MSG_GONE) { pageGone(msg, sender); return false; }
    if (kind !== MSG_REQUEST) return false;
    const reply = (a: Answer) => { try { sendResponse(a); } catch { /* the page is gone */ } };
    const origin = senderOrigin(sender, chrome.runtime.id);
    if (!origin || sender.tab?.id == null) { reply(fail(ERR.unauthorized, 'This page cannot use kUSDT Wallet.')); return false; }
    const req = parseRequest(msg);
    if (!req) { reply(fail(ERR.invalid, invalidReason(msg))); return false; }
    // One tab holds at most SITE_QUEUE_MAX places too, in all sites' queues together: a page that moves from one
    // name of its own to the next (a.evil.example, b.evil.example) does not get a new queue's places with each.
    const tabId = sender.tab.id;
    const held = tabHeld.get(tabId) ?? 0;
    if (held >= SITE_QUEUE_MAX) { reply(fail(ERR.busy, 'This page sent kUSDT Wallet too many requests at once. Try again.')); return false; }
    tabHeld.set(tabId, held + 1);
    let answered = false;
    enqueue({
      req, origin, sender, at: Date.now(), reply: a => {
        if (answered) return;
        answered = true;
        const n = (tabHeld.get(tabId) ?? 1) - 1;
        if (n > 0) tabHeld.set(tabId, n); else tabHeld.delete(tabId);
        reply(a);
      },
    });
    return true;
  });
  chrome.tabs?.onRemoved?.addListener(id => {
    dropWaiting(w => w.sender.tab?.id === id, 'The tab was closed.');
    dropPending(p => p.tabId === id, 'The tab was closed.').catch(() => {});
  });
  chrome.windows?.onRemoved.addListener(id => { onWindowClosed(id).catch(() => {}); });
  chrome.storage.onChanged.addListener((changes, area) => {
    // Unlocked: each connected site's tab hears its account again, as a locked wallet named it none (handle()). Not
    // before the Terms of Service are accepted, when no site counts as connected.
    const phrase = area === 'session' ? changes[SESSION_KEY] : undefined;
    if (phrase && phrase.oldValue === undefined && phrase.newValue !== undefined) {
      (async () => {
        if (!(await termsAccepted())) return;
        const { network } = await loadSettings();
        await accountsChangedFor(network, {}, await connectionsOf(network));
      })().catch(() => {});
    }
    if (area !== 'local') return;
    const s = changes[SETTINGS_KEY];
    if (s && s.oldValue?.network !== s.newValue?.network && s.newValue?.network) broadcast(s.newValue.network).catch(() => {});
    for (const [key, c] of Object.entries(changes)) {
      const m = /^kusdt\.connections\.(.+)$/.exec(key);
      if (m) accountsChangedFor(m[1], c.oldValue ?? {}, c.newValue ?? {}).catch(() => {});
    }
  });
}
