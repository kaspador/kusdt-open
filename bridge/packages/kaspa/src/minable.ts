// Whether a block can take a transaction that a node's mempool holds.
//
// A node admits a transaction that spends an output of another mempool transaction without checking that input's
// relative lock: it gives the unconfirmed output the DAA score u64::MAX, and the lock test then passes for any lock a
// sequence can hold. A block applies the real score. So anyone can put a spend of a public covenant coin (the pool, or a
// copied spend of the minter) into ordinary nodes' mempools that no block will ever take, with a fee that is never paid,
// and those nodes then refuse every other spend of that coin as a double spend until the transaction expires (24 hours)
// or a real spend is mined (round 11, COV-1).
// (Read in rusty-kaspa v2.1.0, not run on a node: mining/src/mempool/populate_entries_and_try_validate.rs:26-43,
// consensus/src/processes/transaction_validator/tx_validation_in_utxo_context.rs:136-161, consensus/core/src/constants.rs:42-51.)
//
// Everything that builds on, or gives way to, a mempool spender of a state coin asks here first. A spender is minable
// only if every one of its inputs is, and an input is when one of these holds:
//   - its sequence has the disable bit set (no relative lock);
//   - its relative lock (the sequence's low 32 bits) is 0;
//   - the output it spends was accepted at DAA score d, and d + lock - 1 < the virtual DAA score (the node's own test).
// An output of a transaction still in the mempool proves no age, so any lock on it fails, and the transaction that
// made it must be minable itself: the check goes up the unconfirmed ancestors, within a bound. What cannot be
// established counts as not minable: nothing is built on a guess.
//
// The judged transaction is an outsider's, so the check costs the same whatever it holds (round 12, R12-COV-1,
// R12-ST-1, R12-WW-3). When an output was accepted is asked only of what the caller already knows (the state coin it
// follows, the coins it found itself), never of the node at an address the transaction names: rc.17 listed every coin
// at the address each locked input's signature script named, once per such input, and the outsider chose the address,
// how many coins sat there and how many inputs asked. A lock on any other output can't be checked and counts as not
// minable; no transaction this project builds locks anything but the state coin it spends. The number of outputs asked
// about is bounded as the mempool lookups are, and the inputs that claim an age are judged before the others, so the
// parked shape is answered at its first lookup.

import { RpcError, RpcTooLargeError } from './rpc';

/** A sequence with this bit set asks no relative lock (rusty-kaspa SEQUENCE_LOCK_TIME_DISABLED). */
export const SEQUENCE_LOCK_DISABLED = 1n << 63n;
/** The relative lock is the sequence's low 32 bits (rusty-kaspa SEQUENCE_LOCK_TIME_MASK). */
export const SEQUENCE_LOCK_MASK = 0xffff_ffffn;

/** The most mempool lookups one check makes: more unconfirmed ancestors than this are not followed, and the answer is "not minable". */
export const MINABLE_MAX_LOOKUPS = 64;
/** How far up a chain of unconfirmed ancestors one check goes. A chain of pool spends is walked hop by hop by its caller, with the verdicts kept, so each hop adds one level. */
export const MINABLE_MAX_DEPTH = 32;
/**
 * The most outputs one check asks the acceptance of, over the transaction and its unconfirmed ancestors. An honest spend
 * claims an age for one: the state coin it spends (a mint, a tick, a sale). A transaction that claims more is not minable.
 */
export const MINABLE_MAX_AGE_ASKS = 4;

export interface Outpoint { transactionId: string; index: number }

/** What the check reads from a node. Each read may throw (the node could not be asked): the check then throws too, and says nothing. */
export interface MinableReads {
  /** The node's virtual DAA score. */
  virtualDaa(): Promise<bigint>;
  /** The transaction with this id as the node's mempool holds it (the node's JSON, with `inputs`), or null when the mempool does not hold it. */
  mempoolTransaction(txid: string): Promise<any | null>;
  /**
   * The DAA score this output was accepted at, when the caller knows it (the state coin it follows, a coin it found in
   * the UTXO set itself), or null. It is told the outpoint and nothing of the transaction that spends it, on purpose:
   * an answer must never come from an address, or anything else, that the judged transaction chose (round 12, R12-COV-1).
   */
  acceptedDaa(outpoint: Outpoint): Promise<bigint | null>;
}

export type Minability = { minable: true } | {
  minable: false;
  /** The transaction at fault: this one, or an unconfirmed ancestor. */
  txid: string; why: string;
  /**
   * Set when the one thing in the way is that the caller does not know when an output was accepted: not shown to be
   * unminable, only not shown to be minable. It counts as not minable all the same (nothing is built on a guess), but
   * a caller that keeps verdicts keeps this one for a moment only: it may know the output the next time it looks.
   */
  unknown?: true;
  /**
   * Set when it passed every test and is called not minable only for how long it has sat in a node's mempool (a
   * caller's stuck timer, the services' SpenderJudge): it may be an honest spend in a busy network, so a caller does not
   * take its place with a replacement (run 21, R21-OPS2-2).
   */
  stuck?: true;
};

export interface MinableOptions {
  /** Verdicts already reached, by transaction id: a caller that walks a chain hop by hop shares one map, so each ancestor is judged once. */
  known?: Map<string, Minability>;
  maxLookups?: number;
  maxDepth?: number;
  maxAgeAsks?: number;
}

/**
 * The relative lock, in DAA, that an input's sequence asks of the output it spends: 0 for none (the disable bit, or a
 * lock of 0). Null when the sequence is not a 64-bit number: nothing is assumed about such an input.
 */
export function relativeLock(sequence: unknown): bigint | null {
  let s: bigint;
  try {
    if (typeof sequence === 'bigint') s = sequence;
    else if (typeof sequence === 'number' && Number.isSafeInteger(sequence)) s = BigInt(sequence);
    else if (typeof sequence === 'string' && /^\d{1,20}$/.test(sequence)) s = BigInt(sequence);
    else return null;
  } catch { return null; }
  if (s < 0n || s >= 1n << 64n) return null;
  if ((s & SEQUENCE_LOCK_DISABLED) !== 0n) return 0n;
  return s & SEQUENCE_LOCK_MASK;
}

const outpointOf = (input: any): Outpoint | null => {
  const o = input?.previousOutpoint;
  const index = Number(o?.index);
  return typeof o?.transactionId === 'string' && /^[0-9a-f]{64}$/.test(o.transactionId) && Number.isInteger(index) && index >= 0 ? { transactionId: o.transactionId, index } : null;
};

/**
 * Whether a block can take the mempool transaction `tx` (the node's JSON) now. `txid` is its id, for the answer.
 * Throws when the node cannot be asked: no verdict then, and the caller must not treat the transaction either way.
 */
export async function minability(txid: string, tx: any, reads: MinableReads, opts: MinableOptions = {}): Promise<Minability> {
  const known = opts.known ?? new Map<string, Minability>();
  const maxLookups = opts.maxLookups ?? MINABLE_MAX_LOOKUPS;
  const maxDepth = opts.maxDepth ?? MINABLE_MAX_DEPTH;
  const maxAgeAsks = opts.maxAgeAsks ?? MINABLE_MAX_AGE_ASKS;
  // One check's reads of the mempool, by parent id: an ancestor spent by several inputs is asked for once.
  const parents = new Map<string, any | null>();
  let lookups = 0;
  // The outputs whose acceptance one check asked about, each once.
  const ages = new Map<string, bigint | null>();
  let virtual: bigint | undefined;
  const inProgress = new Set<string>();

  const judge = async (id: string, body: any, depth: number): Promise<Minability> => {
    const before = known.get(id);
    if (before) return before;
    const no = (why: string, at = id): Extract<Minability, { minable: false }> => ({ minable: false, txid: at, why });
    // The mempool holds no cycles; a node that showed one is not believed.
    if (inProgress.has(id)) return no('its unconfirmed ancestors form a cycle');
    if (depth > maxDepth) return no(`it has more than ${maxDepth} levels of unconfirmed ancestors: not checked further`);
    if (!Array.isArray(body?.inputs) || body.inputs.length === 0) return no('its inputs can\'t be read');
    // Read first, all of them: the node is asked nothing for a transaction with an input that can't be read.
    const inputs: { n: number; spent: Outpoint; lock: bigint }[] = [];
    for (const [n, input] of body.inputs.entries()) {
      const spent = outpointOf(input);
      const lock = relativeLock(input?.sequence);
      if (!spent || lock === null) return no(`input ${n} can't be read`);
      inputs.push({ n, spent, lock });
    }
    // An honest spend claims an age for the one state coin it spends. More than the bound is refused before anything
    // is asked: how many of its inputs claim one is the judged transaction's to choose, and what judging it costs must not be.
    const locked = inputs.filter((i) => i.lock > 0n);
    if (locked.length > maxAgeAsks) return no(`it claims an age for ${locked.length} of the outputs it spends: more than ${maxAgeAsks}, which no honest spend does, so none is looked up`);
    inProgress.add(id);
    try {
      // The inputs that claim an age first: that is where a parked spend fails, at one lookup, wherever its locked input stands.
      // An age the caller cannot vouch for does not end the look at them: another of the few may be shown to fail,
      // and that is the verdict worth keeping. With none shown to fail, "not known" is the answer, and the rest is not asked.
      let unvouched: Minability | null = null;
      for (const { n, spent, lock } of [...locked, ...inputs.filter((i) => i.lock === 0n)]) {
        if (lock === 0n && unvouched) return unvouched;
        let parent = parents.get(spent.transactionId);
        if (parent === undefined) {
          if (++lookups > maxLookups) return no(`it has more than ${maxLookups} inputs or unconfirmed ancestors to look up: not checked further`);
          parent = await reads.mempoolTransaction(spent.transactionId);
          parents.set(spent.transactionId, parent ?? null);
        }
        if (parent) {
          // Not accepted yet: it has no age, whatever the node's mempool made of the lock.
          if (lock > 0n) return no(`input ${n} claims an age of ${lock} DAA for an output of ${spent.transactionId}, which is still in the mempool: an unconfirmed output has no age`);
          const above = await judge(spent.transactionId, parent, depth + 1);
          if (!above.minable) return above.txid === spent.transactionId ? { ...no(`it spends an output of ${spent.transactionId}, which no block can take (${above.why})`, above.txid), ...(above.unknown && { unknown: true as const }) } : above;
          continue;
        }
        if (lock === 0n) continue;
        const key = `${spent.transactionId}:${spent.index}`;
        let accepted = ages.get(key);
        if (accepted === undefined) {
          if (ages.size >= maxAgeAsks) return no(`it and its unconfirmed ancestors claim an age for more than ${maxAgeAsks} outputs: not checked further`);
          accepted = await reads.acceptedDaa(spent);
          ages.set(key, accepted);
        }
        if (accepted === null) {
          unvouched ??= { ...no(`input ${n} claims an age of ${lock} DAA for ${spent.transactionId}:${spent.index}, and the node can't say when that output was accepted`), unknown: true };
          continue;
        }
        virtual ??= await reads.virtualDaa();
        // The node's own test (check_sequence_lock): the lock holds while accepted + lock - 1 >= the DAA score it is judged at.
        if (accepted + lock - 1n >= virtual) return no(`input ${n} claims an age of ${lock} DAA for an output accepted at DAA ${accepted}: no block takes it before DAA ${accepted + lock} (now ${virtual})`);
      }
      return unvouched ?? { minable: true };
    } finally { inProgress.delete(id); }
  };

  const verdict = await judge(txid, tx, 0);
  // Kept only when it is this transaction's own: a verdict that ran out of lookups half way up says nothing of the ancestors it passed.
  known.set(txid, verdict);
  return verdict;
}

/** How long a verdict of "minable" is kept for a transaction: about one look. Its parents can leave the mempool, so it is asked again soon. */
export const MINABLE_KEPT_MS = 5_000;
/** How long a verdict of "not minable" is kept after the transaction was last looked at: while the mempool shows it, it stays one. */
export const UNMINABLE_KEPT_MS = 600_000;

/**
 * The verdicts a client keeps between its looks at a node's mempool, by transaction id (round 12, R12-WW-3): a wallet
 * or a page looks every few seconds, and without this each look judged the same transaction again, lookups and all.
 * "Not minable" stays for as long as the transaction keeps being looked at: the nodes that build blocks dropped it
 * when they first tried it, and a lock that has run out since does not bring it back to them. "Minable" is kept for a
 * few seconds only. A "not minable" that only says the caller did not know an output (`unknown`) is not kept at all:
 * what a caller knows differs from look to look (a look at the wallet's tokens does not know the pool, a look at the
 * pool does), and judging such a transaction again costs a handful of lookups at most. Bounded: the oldest entries go first.
 */
export class VerdictMemory {
  private readonly kept = new Map<string, { verdict: Minability; at: number }>();

  constructor(private readonly most = 256, private readonly now: () => number = Date.now) {}

  get(txid: string): Minability | undefined {
    const k = this.kept.get(txid);
    if (!k) return undefined;
    const now = this.now();
    if (now - k.at > (k.verdict.minable ? MINABLE_KEPT_MS : UNMINABLE_KEPT_MS)) { this.kept.delete(txid); return undefined; }
    // Seen again: a "no" goes on standing from now. A "minable" is not renewed, or it would never be asked again.
    if (!k.verdict.minable) k.at = now;
    return k.verdict;
  }

  set(txid: string, verdict: Minability): void {
    this.kept.delete(txid);
    if (!verdict.minable && verdict.unknown) return;
    this.kept.set(txid, { verdict, at: this.now() });
    while (this.kept.size > this.most) this.kept.delete(this.kept.keys().next().value as string);
  }

  /** `minability`, answered from what is kept when it can be. A check that throws keeps nothing. */
  async judge(txid: string, tx: any, reads: MinableReads, opts: MinableOptions = {}): Promise<Minability> {
    const before = this.get(txid);
    if (before) { opts.known?.set(txid, before); return before; }
    const verdict = await minability(txid, tx, reads, opts);
    this.set(txid, verdict);
    return verdict;
  }
}

/** Whether an error is the node's own answer to a call (a refusal), as opposed to a lost connection, a timeout or an answer too long to read. */
export function isNodeRefusal(e: unknown): boolean {
  return e instanceof RpcError && !(e instanceof RpcTooLargeError) && !/timed out$/.test(e.message);
}

/** A node as these reads use it: one call, answered parsed (KaspaRpc.call). */
export type NodeCall = <T = any>(method: string, params: object) => Promise<T>;

/**
 * The check's reads through a node's wRPC: the mempool by transaction id, and the virtual DAA score. `acceptedAt`
 * answers the outputs whose acceptance the caller already knows (the state it follows, the coins it found at the
 * addresses it asked about itself). For every other output the answer is "not known", and the node is not asked:
 * kaspad 2.1.0 has no call that answers about one outpoint, only one that lists every coin at an address, and the only
 * address to be had for such an output is the one its spender names. rc.17 listed it, once per locked input, and so
 * read whatever an outsider had put there, as often as the outsider's transaction asked (round 12, R12-COV-1,
 * R12-ST-1, R12-WW-3). A lock on an output the caller does not know therefore counts as not minable. No transaction
 * this project builds locks any coin but the state coin it spends.
 */
export function nodeMinableReads(call: NodeCall, acceptedAt?: (outpoint: Outpoint) => bigint | null | undefined): MinableReads {
  return {
    virtualDaa: async () => BigInt((await call('getBlockDagInfo', {})).virtualDaaScore),
    mempoolTransaction: async (txid) => {
      try {
        const answer = await call('getMempoolEntry', { transactionId: txid, includeOrphanPool: false, filterTransactionPool: false });
        const tx = answer?.mempoolEntry?.transaction;
        return tx && Array.isArray(tx.inputs) ? tx : null;
      } catch (e) {
        // The node's refusal for a transaction it does not hold is "Transaction <id> not found" (rusty-kaspa v2.1.0
        // rpc/core/src/error.rs, read, not run). Only those words mean that: any other refusal, a timeout or a closed
        // connection is not an answer, and taking one for "not in the mempool" would pass an unconfirmed parent as confirmed.
        if (isNodeRefusal(e) && /not found/i.test((e as Error).message)) return null;
        throw e;
      }
    },
    acceptedDaa: async (outpoint) => acceptedAt?.(outpoint) ?? null,
  };
}

/** A transaction the node's mempool holds, as getMempoolEntriesByAddresses and getMempoolEntry show it. */
export interface MempoolSpender { txid: string; tx: any; /** The fee the node says it pays (sompi), when it says. */ fee: bigint | null }

const spenderOf = (entry: any): MempoolSpender | null => {
  const tx = entry?.transaction;
  const txid = tx?.verboseData?.transactionId;
  if (typeof txid !== 'string' || !/^[0-9a-f]{64}$/.test(txid) || !Array.isArray(tx?.inputs)) return null;
  let fee: bigint | null = null;
  try { if (entry.fee !== undefined && entry.fee !== null) fee = BigInt(String(entry.fee)); } catch { /* no fee told */ }
  return { txid, tx, fee: fee !== null && fee >= 0n ? fee : null };
};

/** The mempool transactions a getMempoolEntriesByAddresses answer lists under `key` (spending from its addresses, or paying them), each once. */
function listed(answer: any, key: 'sending' | 'receiving'): MempoolSpender[] {
  const found = new Map<string, MempoolSpender>();
  for (const entry of Array.isArray(answer?.entries) ? answer.entries : []) {
    for (const one of Array.isArray(entry?.[key]) ? entry[key] : []) {
      const s = spenderOf(one);
      if (s && !found.has(s.txid)) found.set(s.txid, s);
    }
  }
  return [...found.values()];
}

/** The mempool transactions a getMempoolEntriesByAddresses answer lists as spending from its addresses, each once. */
export const sendingIn = (answer: any): MempoolSpender[] => listed(answer, 'sending');
/** The mempool transactions a getMempoolEntriesByAddresses answer lists as paying its addresses, each once. */
export const receivingIn = (answer: any): MempoolSpender[] => listed(answer, 'receiving');

/** Whether a transaction (the node's JSON) spends `outpoint`. */
export function spendsOutpoint(tx: any, outpoint: { transactionId: string; index: number | string }): boolean {
  const index = Number(outpoint.index);
  return (Array.isArray(tx?.inputs) ? tx.inputs : []).some((i: any) => i?.previousOutpoint?.transactionId === outpoint.transactionId && Number(i.previousOutpoint.index) === index);
}

/**
 * The mempool transactions that spend `outpoint`, asked for by the address of the output it names: the node answers
 * only what spends from or pays that address, never its whole mempool (round 11, R11-ST-2). A covenant state's address
 * changes with its state, so a chain of spends is followed one call per hop.
 */
export async function mempoolSpendersOf(call: NodeCall, address: string, outpoint: { transactionId: string; index: number | string }): Promise<MempoolSpender[]> {
  const answer = await call('getMempoolEntriesByAddresses', { addresses: [address], includeOrphanPool: false, filterTransactionPool: false });
  return sendingIn(answer).filter((s) => spendsOutpoint(s.tx, outpoint));
}

/**
 * What a mempool transaction pays per gram as the node counts it for a replacement: its fee over the larger of its
 * compute mass and its storage mass ("fee rate per contextual mass gram"; the entry carries `storageMass` beside
 * `verboseData.computeMass`). A transaction built at a whole feerate above this one outbids it. Until run 21 (chain2 I1)
 * it divided by the compute mass alone, which read a mint on simnet at 170.7 sompi a gram where the node counted 100
 * (a pause at 100 was refused as "not greater"), and TN10's mempool entries 17 to 19 times too high: an outbid overpaid,
 * or was given up as over its cap when it would have won. An entry that does not say its storage mass is divided by
 * its compute mass, so the figure reads high, never low. Null when the entry does not say its fee or compute mass.
 */
export function feerateCeiling(spender: { fee?: unknown; tx?: any } | null | undefined): number | null {
  try {
    if (spender?.fee === undefined || spender.fee === null) return null;
    const fee = Number(BigInt(String(spender.fee)));
    const compute = Number(spender?.tx?.verboseData?.computeMass);
    const storage = Number(spender?.tx?.storageMass);
    const mass = Number.isFinite(storage) && storage > compute ? storage : compute;
    return Number.isFinite(fee) && fee >= 0 && Number.isFinite(mass) && mass > 0 ? fee / mass : null;
  } catch { return null; }
}
