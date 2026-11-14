// Addresses the node cannot list.
//
// A Kaspa node (kaspad 2.1.0) answers every coin at an address in one message, with no paging, and anyone can send
// an address coins. Past about 158,000 coins the answer is longer than this client reads (64 MB: it is refused
// unparsed, bridge/packages/kaspa/src/rpc.ts), and on a slow line the call times out well before that. A covenant
// state's address follows from public fields (a kUSDT state's from its owner and amount), so an outsider can fill
// the address of a state a holder has, or send a holder a dust state at an address filled beforehand.
//
// The wallet read all of its state addresses in one call, so one such address failed the whole read, and with it the
// whole kUSDT balance (round 12, R12-WW-1). Here that one read is still tried first; when it fails for its length or
// for time, each address is read on its own, so that one unlistable address costs only the states that sit there.
// Those come back as "could not be read": not found, and not known to be absent.
//
// What the new reads may cost is bounded, because whoever fills an address chooses when they happen:
//   - an address that could not be listed is not asked about again for some minutes (every ask makes the node build
//     the whole list again, and a timeout makes this client drop the node it was on);
//   - one look reads at most `singles` addresses on their own, and stops asking after `timeouts` of them timed out
//     (then the node is slow, not one address full); what was not asked counts as not read, this time only;
//   - at most `keep` addresses are remembered.

import { RpcError, RpcTooLargeError } from '@kusdt/kaspa';
import { session } from '../lib/storage';
import type { NodeUtxo } from '../kaspa/node';
import type { Ctx } from './types';

export const UNREADABLE = {
  /** How long an address whose list was too long is not asked about again. */
  fullMs: 10 * 60_000,
  /** The same for one whose read timed out: much shorter, a slow node recovers (and the pool's own address is read this way too). */
  slowMs: 60_000,
  /** The most addresses remembered. */
  keep: 64,
  /** The most addresses read on their own in one look. */
  singles: 64,
  /** Reads on their own that may time out in one look before the rest is left unasked. */
  timeouts: 2,
};

const KEY = (network: string) => `kusdt.unreadable.${network}`;

/** Address → when it may be asked about again; and where the next look's own reads start (for an owner with more addresses than one look reads). */
interface Store { until: Record<string, number>; next: number }

const tooLong = (e: unknown): boolean => e instanceof RpcTooLargeError;
const timedOut = (e: unknown): boolean => e instanceof RpcError && !(e instanceof RpcTooLargeError) && /timed out$/.test(e.message);
/** The node could not give this list: too long to read, or no answer in time. Anything else is an error like any other. */
export const cannotList = (e: unknown): boolean => tooLong(e) || timedOut(e);

async function load(network: string): Promise<Store> {
  const s = await session.get<Store>(KEY(network)).catch(() => undefined);
  const now = Date.now(), until: Record<string, number> = {};
  for (const [a, t] of Object.entries(s?.until ?? {})) if (typeof t === 'number' && t > now) until[a] = t;
  return { until, next: typeof s?.next === 'number' && Number.isSafeInteger(s.next) && s.next >= 0 ? s.next : 0 };
}

async function save(network: string, s: Store): Promise<void> {
  // The newest `keep`: whoever fills addresses decides how many there are, not how many are kept.
  const newest = Object.entries(s.until).sort((a, b) => b[1] - a[1]).slice(0, UNREADABLE.keep);
  await session.set({ [KEY(network)]: { until: Object.fromEntries(newest), next: s.next } }).catch(() => {});
}

/** The addresses remembered as unlistable right now. */
export async function unreadableNow(network: string): Promise<Set<string>> {
  return new Set(Object.keys((await load(network)).until));
}

/**
 * The coins at `addresses`, and which of the addresses could not be listed (see the top of this file). An address
 * in `unread` says nothing about its coins: they are neither in `utxos` nor known to be gone.
 */
export async function listAddresses(ctx: Pick<Ctx, 'node' | 'network'>, addresses: string[]): Promise<{ utxos: NodeUtxo[]; unread: Set<string> }> {
  const store = await load(ctx.network);
  const unread = new Set(addresses.filter(a => a in store.until));
  const ask = addresses.filter(a => !unread.has(a));
  if (ask.length === 0) return { utxos: [], unread };
  let first: unknown;
  try { return { utxos: await ctx.node.utxos(ask), unread }; }
  catch (e) { if (!cannotList(e)) throw e; first = e; }

  const utxos: NodeUtxo[] = [];
  const now = Date.now();
  const note = (address: string, e: unknown) => { unread.add(address); store.until[address] = now + (tooLong(e) ? UNREADABLE.fullMs : UNREADABLE.slowMs); };
  if (ask.length === 1) note(ask[0], first);
  else {
    // Each on its own, from where the last such look stopped, so an owner with more addresses than one look reads
    // has all of them read over a few looks.
    const from = ask.length > UNREADABLE.singles ? store.next % ask.length : 0;
    let asked = 0, timeouts = 0;
    for (let i = 0; i < ask.length; i++) {
      const address = ask[(from + i) % ask.length];
      if (asked >= UNREADABLE.singles || timeouts >= UNREADABLE.timeouts) { unread.add(address); continue; }
      asked++;
      try { utxos.push(...await ctx.node.utxos([address])); }
      catch (e) {
        if (!cannotList(e)) throw e;
        if (timedOut(e)) timeouts++;
        note(address, e);
      }
    }
    store.next = ask.length > UNREADABLE.singles ? (from + asked) % ask.length : 0;
  }
  await save(ctx.network, store);
  return { utxos, unread };
}
