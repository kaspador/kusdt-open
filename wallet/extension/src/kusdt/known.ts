// The kUSDT states this wallet has seen for itself: every state of its key that its node showed it (kusdt/verify.ts),
// and every one its own transactions made.
//
// The coordinator's list is where the wallet learns of its states, and its node is where it checks them. Either can
// fail for one owner alone: an owner's list cannot be answered while one of their states sits at an address too full
// to read (docs: known limits), and the node cannot list such an address at all. Then this record is what the wallet
// still has (round 12, R12-WW-1):
//   - it is checked on the node beside the coordinator's list at every look, so the wallet keeps its balance when
//     the coordinator does not answer;
//   - for a state at an address the node cannot list, it holds the state's outpoint and the KAS it carries, as the
//     node itself once showed them, to spend the state from (kusdt/tokens.ts planSend, `unchecked`).
//
// It is a record, never a balance: nothing in it is shown or spent before the node has shown it again, except by the
// user's own choice for a state the node cannot show. Only plain states of the wallet's own key are kept, so an
// entry is an outpoint and two amounts.
//
// Bounded, and kept true:
//   - the KNOWN_KEEP entries that hold the most kUSDT are kept (anyone can send a key dust states, and those must
//     not push the real ones out), for at most OWNERS_KEEP owners;
//   - what the wallet's own transaction spends, once the node took it, is marked as spent by it: never offered as
//     "not checked", and shown only while the node shows it unspent. The mark goes when the transaction lost the race
//     for the pool (restoreSpent), and when the node still shows it unspent SPENT_KEEP_MS after it was marked (the
//     transaction never landed). The entry goes only once the node shows it spent: three looks a minute apart that do
//     not find it, as below; one the node cannot answer for goes SPENT_KEEP_MS after it was marked. Until round 13 it
//     left at once, so the input of a pool transaction that lost the race was gone from the record though still
//     unspent (R13-CL-2); until the deep round of the second outside review of rc.22 it left as soon as the
//     transaction was seen accepted, at any depth, so a transaction a reorg then dropped for good took the input out
//     of the wallet's balance, though it was unspent on the chain again (D4-1);
//   - an entry the node answered for and did not show at three looks is dropped (spent by this key on another
//     device, or by a transaction of its own that never made it). The looks count at most one a minute (a site
//     asking for balances must not age the record), and an entry the wallet's own transaction made and the node
//     has not shown yet counts none while that transaction is waited for, or for ten minutes after it was made:
//     change that sits in the mempool is not "not there" (R13-CL-2);
//   - an entry the node cannot answer for (its address cannot be listed) is dropped the same way once the
//     coordinator's full list has not named it at three looks, ten minutes or more after it was recorded: otherwise
//     a state spent elsewhere would stay "not checked" for good.

import { local } from '../lib/storage';
import { ZERO32, isHex32 } from '../lib/bigint';
import { OWNER_P2PK_SCHNORR } from './owner';
import { inputsOf } from './pending';
import type { Built, Ctx } from './types';

export interface KnownState {
  txid: string;
  index: number;
  /** The kUSDT it holds, in base units. */
  amount: string;
  /** The KAS its coin carries, in sompi, as the node showed it or as this wallet's own transaction made it. */
  kas: string;
  /** The DAA score it was accepted at (0 for one of the wallet's own that the node has not shown yet). */
  daa: string;
  /** Looks in a row at which it was not there. */
  misses: number;
  /** When it was first recorded (ms). */
  at: number;
  /** The wallet's own transaction that spends it, which the node took (its id), and when that was marked (ms). */
  spentBy?: string;
  spentAt?: number;
  /** When the last look that did not find it was counted (ms). */
  missAt?: number;
}

export const KNOWN_KEEP = 600;
export const OWNERS_KEEP = 16;
/** How old a record must be before the coordinator's not naming it counts against it (it lists a new state within a minute). */
export const UNLISTED_AFTER_MS = 10 * 60_000;
const MISSES = 3;
/** Looks closer together than this count as one miss (R13-CL-2). */
export const MISS_SPACING_MS = 60_000;
/** How long an entry made by the wallet's own transaction counts no miss before the node has shown it. */
export const OWN_FRESH_MS = 10 * 60_000;
/**
 * How long an entry spent by the wallet's own transaction stays marked while the node still shows it unspent: past it,
 * that transaction never landed, and the entry is the user's again. One the node cannot answer for goes then.
 */
export const SPENT_KEEP_MS = 60 * 60_000;
const KEY = (network: string, ownerHex: string) => `kusdt.known.${network}.${ownerHex}`;
/** The owners this wallet keeps a record for: its own key, per account it was used with. */
const OWNERS = (network: string) => `kusdt.known.owners.${network}`;

const time = (v: unknown): boolean => v === undefined || (typeof v === 'number' && Number.isFinite(v));
const valid = (k: KnownState): boolean =>
  !!k && isHex32(k.txid) && Number.isInteger(k.index) && k.index >= 0 && /^\d{1,30}$/.test(k.amount) && /^\d{1,30}$/.test(k.kas) && /^\d{1,30}$/.test(k.daa) &&
  (k.spentBy === undefined || isHex32(k.spentBy)) && time(k.spentAt) && time(k.missAt);

const idOf = (k: { txid: string; index: number }) => `${k.txid}:${k.index}`;

/** The record for `ownerHex`, or null when this wallet has never looked for that owner's states. */
async function read(network: string, ownerHex: string): Promise<KnownState[] | null> {
  const list = await local.get<KnownState[]>(KEY(network, ownerHex));
  return Array.isArray(list) ? list.filter(valid) : null;
}

/** The states this wallet knows of and has not spent itself. */
export async function knownStates(network: string, ownerHex: string): Promise<KnownState[]> {
  return ((await read(network, ownerHex)) ?? []).filter(k => k.spentBy === undefined);
}

/** The whole record, with the entries marked as spent by the wallet's own transactions (a look needs them to see one come back). */
export async function knownRecord(network: string, ownerHex: string): Promise<KnownState[]> {
  return (await read(network, ownerHex)) ?? [];
}

async function owners(network: string): Promise<string[]> {
  const list = await local.get<string[]>(OWNERS(network));
  return Array.isArray(list) ? list.filter((o) => isHex32(o)) : [];
}

/**
 * One change of a record at a time (a look at the node and a submission can end together): the second reads what
 * the first wrote. Only within this page; the background and a popup can still cross, and then the rules above put
 * the record right at the next looks.
 */
const queues = new Map<string, Promise<unknown>>();
function oneAtATime<T>(key: string, change: () => Promise<T>): Promise<T> {
  const next = (queues.get(key) ?? Promise.resolve()).then(change, change);
  queues.set(key, next.catch(() => {}));
  return next;
}

async function write(network: string, ownerHex: string, list: KnownState[], before: KnownState[] | null): Promise<void> {
  // The entries spent by the wallet's own transactions last: they never push out one that is not.
  const more = (a: KnownState, b: KnownState) => {
    if ((a.spentBy === undefined) !== (b.spentBy === undefined)) return a.spentBy === undefined ? -1 : 1;
    const x = BigInt(a.amount), y = BigInt(b.amount); return x === y ? b.at - a.at : x > y ? -1 : 1;
  };
  // A marked entry leaves by the looks (applyLook), never by a write: until the node has shown it spent, a reorg can
  // give it back (D4-1).
  const kept = list.slice().sort(more).slice(0, KNOWN_KEEP);
  // Looked at often (every refresh): written only when something changed.
  if (before && JSON.stringify(before) === JSON.stringify(kept)) return;
  await local.set({ [KEY(network, ownerHex)]: kept });
  if (before) return;
  // A new owner: the oldest one's record goes when there are too many.
  const all = [...(await owners(network)).filter((o) => o !== ownerHex), ownerHex];
  for (const gone of all.slice(0, Math.max(0, all.length - OWNERS_KEEP))) await local.remove(KEY(network, gone));
  await local.set({ [OWNERS(network)]: all.slice(-OWNERS_KEEP) });
}

/**
 * After a look at the node: `seen` are the states it showed (kept, or added), `missing` the outpoints that were not
 * there (the node answered and did not show them; or, for one it could not answer for, the coordinator's full list
 * did not name it). An entry is dropped after three such looks in a row. Anything else stays as it is.
 */
export function updateKnown(network: string, ownerHex: string, seen: { txid: string; index: number; amount: bigint; kas: bigint; daa: bigint }[], missing: string[]): Promise<void> {
  return oneAtATime(KEY(network, ownerHex), () => applyLook(network, ownerHex, seen, missing));
}

async function applyLook(network: string, ownerHex: string, seen: { txid: string; index: number; amount: bigint; kas: bigint; daa: bigint }[], missing: string[]): Promise<void> {
  const before = await read(network, ownerHex);
  const byId = new Map((before ?? []).map(k => [idOf(k), { ...k }]));
  const now = Date.now();
  // Shown unspent. A mark of the wallet's own transaction stays: the node's UTXO set shows an input until a block takes
  // its spender, and a mempool that could not be read shows no spender. Still shown unspent SPENT_KEEP_MS after it was
  // marked, its transaction never landed (or a reorg dropped it for good): the mark goes, and it is the user's again.
  const shown = new Set<string>();
  for (const s of seen) {
    const old = byId.get(idOf(s));
    const marked = old?.spentBy !== undefined && now - (old.spentAt ?? 0) < SPENT_KEEP_MS;
    shown.add(idOf(s));
    byId.set(idOf(s), { txid: s.txid, index: s.index, amount: s.amount.toString(), kas: s.kas.toString(), daa: s.daa.toString(), misses: 0, at: old?.at ?? now, ...(marked && { spentBy: old!.spentBy, spentAt: old!.spentAt }) });
  }
  // The transactions still waited for: what they made is not "not there" yet. What they spent leaves the record only
  // once the node shows it spent, by the looks below, never because the transaction was seen accepted: a reorg can drop
  // an accepted transaction for good and give the input back (D4-1).
  const waited = new Set<string>();
  const missed = new Set(missing);
  for (const k of [...byId.values()]) {
    if (k.spentBy === undefined) continue;
    waited.add(k.spentBy);
    // Marked for longer than SPENT_KEEP_MS, and the node neither showed it nor answered for it (an address too full to
    // list): it goes, as before; never offered as "not checked" while marked.
    if (!shown.has(idOf(k)) && !missed.has(idOf(k)) && now - (k.spentAt ?? 0) >= SPENT_KEEP_MS) byId.delete(idOf(k));
  }
  for (const id of missing) {
    const k = byId.get(id);
    if (!k) continue;
    // Made by the wallet's own transaction and not shown yet: most likely still in the mempool.
    if (k.daa === '0' && (now - k.at < OWN_FRESH_MS || waited.has(k.txid))) continue;
    // Looks a moment apart are one look.
    if (k.missAt !== undefined && now - k.missAt < MISS_SPACING_MS) continue;
    if (k.misses + 1 >= MISSES) byId.delete(id); else { k.misses++; k.missAt = now; }
  }
  await write(network, ownerHex, [...byId.values()], before);
}

/**
 * After the wallet submitted a transaction: for each owner it keeps a record of, the states the transaction makes for
 * that owner go in (its own key's change, a merge, what a purchase or a withdrawal pays: not on the node yet, the
 * next looks show them or drop them), and with `spent` what it spends is marked as spent by it (see the top of this
 * file). `spent` is false while it is not known that the node took the transaction: its inputs may still be there.
 */
export async function noteBuilt(ctx: Pick<Ctx, 'network'>, built: Pick<Built, 'txid' | 'outputs' | 'transaction'>, spent: boolean): Promise<void> {
  const made = new Map<string, KnownState[]>();
  const now = Date.now();
  for (const o of built.outputs) {
    const t = o.token as { amount?: unknown; owner?: unknown; ownerScheme?: unknown; borrowScheme?: unknown; borrowGuard?: unknown; extensionCommitment?: unknown } | undefined;
    // A plain state of a key, the only kind this wallet spends (owner.ts isPlainStateOf).
    if (!t || t.ownerScheme !== OWNER_P2PK_SCHNORR || !isHex32(t.owner) || (t.borrowScheme ?? 0) !== 0) continue;
    if ((t.borrowGuard ?? ZERO32) !== ZERO32 || (t.extensionCommitment ?? ZERO32) !== ZERO32) continue;
    const amount = typeof t.amount === 'bigint' || typeof t.amount === 'number' || typeof t.amount === 'string' ? String(t.amount) : '';
    const k: KnownState = { txid: built.txid, index: o.index, amount, kas: o.value.toString(), daa: '0', misses: 0, at: now };
    if (valid(k)) made.set(t.owner, [...(made.get(t.owner) ?? []), k]);
  }
  const gone = new Set(spent ? inputsOf(built.transaction) : []);
  // Only for owners this wallet has looked up before: what it sends to others is not its to keep.
  for (const ownerHex of await owners(ctx.network)) {
    await oneAtATime(KEY(ctx.network, ownerHex), async () => {
      const before = await read(ctx.network, ownerHex);
      if (!before) return;
      const added = made.get(ownerHex) ?? [];
      const ids = new Set(added.map(idOf));
      const marked = before.filter(k => !ids.has(idOf(k))).map(k => (gone.has(idOf(k)) ? { ...k, spentBy: built.txid, spentAt: now } : k));
      await write(ctx.network, ownerHex, [...marked, ...added], before);
    });
  }
}

/** Changes every record of `network` that `change` changes. */
async function changeAll(network: string, change: (list: KnownState[]) => KnownState[]): Promise<void> {
  for (const ownerHex of await owners(network)) {
    await oneAtATime(KEY(network, ownerHex), async () => {
      const before = await read(network, ownerHex);
      if (before) await write(network, ownerHex, change(before), before);
    });
  }
}

/**
 * The wallet's own transaction `txid` can never be accepted (it lost the race for the pool): what it spent is back in
 * the record as it was, and what it made is gone.
 */
export function restoreSpent(network: string, txid: string): Promise<void> {
  return changeAll(network, list => list.filter(k => k.txid !== txid).map(k => {
    if (k.spentBy !== txid) return k;
    const back = { ...k };
    delete back.spentBy;
    delete back.spentAt;
    return back;
  }));
}
