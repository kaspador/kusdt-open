// Following KasPool (SPEC §15) through the transactions that spend it, the way
// minter.ts follows BridgeMint: the spent state comes from the program `R`,
// the successor from the entry's arguments by the covenant's arithmetic, and a
// successor (pool, reserve, new position) is adopted only when its locking
// script, computed by the core, is one of the outputs. Where a successor
// depends on which input paid (sell, add, init), every kUSDT input is tried
// and only one whose result the outputs hold is taken.
//
// "The outputs hold it" means the covenant's own outputs: the pool and a new
// position are the pool input's authorized outputs in the pool family (in that
// order), the reserve an output bound to kUSDT's covenant ID. A plain output
// paying to the same script is a decoy and is never adopted.

import { bytesToHex, equalBytes, hexToBytes, idBodyOf, transactionIdOf } from '@kusdt/kaspa';
import { ScriptError, parsePushes, readInt8, readScriptNum } from './script';
import { decodeKcc20Input, type Template, type TokenState } from './kcc20';
import { MIN_LIQUIDITY, afterAdd, afterBuy, afterRemove, afterSell, afterTick, type PoolState } from './pool';
import { authorizedOutputs, provesProgram, spkHex, type HeldOutpoint, type ProgramLayout, type TxLike } from './minter';
import { OWNER_COVENANT_ID } from './owner';

export interface PositionState { tokenCovid: string; shares: bigint; owner: string }

export class PoolFollowError extends Error {}

const ZERO32 = '00'.repeat(32);

/** PushExplicit fields (KCC-1 §3.4.3): 32-byte values, 8-byte ints and 1-byte bools, in order; null if `s` is not exactly that. */
function readFields(s: Uint8Array, spec: ('b32' | 'int' | 'bool')[]): (string | bigint | boolean)[] | null {
  const out: (string | bigint | boolean)[] = [];
  let at = 0;
  for (const kind of spec) {
    const len = kind === 'b32' ? 32 : kind === 'int' ? 8 : 1;
    if (s[at] !== len || at + 1 + len > s.length) return null;
    const value = s.slice(at + 1, at + 1 + len);
    if (kind === 'bool' && value[0] > 1) return null;
    out.push(kind === 'b32' ? bytesToHex(value) : kind === 'int' ? readInt8(value) : value[0] === 1);
    at += 1 + len;
  }
  return at === s.length ? out : null;
}

function stateOf(program: Uint8Array, layout: ProgramLayout): Uint8Array | null {
  const prefix = hexToBytes(layout.prefix);
  const suffix = hexToBytes(layout.suffix);
  if (program.length !== prefix.length + layout.stateLength + suffix.length) return null;
  if (!equalBytes(program.slice(0, prefix.length), prefix) || !equalBytes(program.slice(program.length - suffix.length), suffix)) return null;
  return program.slice(prefix.length, prefix.length + layout.stateLength);
}

/** The state inside a Pool program, or null when it is another program. */
export function decodePoolProgram(program: Uint8Array, layout: ProgramLayout): PoolState | null {
  const s = stateOf(program, layout);
  const f = s && readFields(s, ['b32', 'b32', 'b32', 'int', 'int', 'int', 'int', 'int', 'int', 'b32', 'int', 'int', 'int', 'int', 'int', 'bool', 'b32']);
  if (!f) return null;
  const [, , tokenCovid, kasReserve, tokenReserve, totalShares, protocolKas, protocolTokens, baseValue, admin,
    maxOutBps, windowLen, windowCredit, windowRef, windowOut, paused, guardian] = f as any[];
  return { tokenCovid, kasReserve, tokenReserve, totalShares, protocolKas, protocolTokens, baseValue, admin, maxOutBps, windowLen, windowCredit, windowRef, windowOut, paused, guardian };
}

/** The state inside a Position program, or null when it is another program. */
export function decodePositionProgram(program: Uint8Array, layout: ProgramLayout): PositionState | null {
  const s = stateOf(program, layout);
  const f = s && readFields(s, ['b32', 'b32', 'int', 'b32']);
  if (!f) return null;
  const [, tokenCovid, shares, owner] = f as any[];
  return { tokenCovid, shares, owner };
}

/** A single `KCC20State` argument: six pushes, the amount as a script number, the schemes as raw bytes. */
function stateArg(p: Uint8Array[]): TokenState {
  const [amount, owner, scheme, borrow, guard, extension] = p;
  if (owner.length !== 32 || scheme.length !== 1 || borrow.length !== 1 || guard.length !== 32 || extension.length !== 32) {
    throw new ScriptError('not a KCC20State argument');
  }
  return {
    amount: readScriptNum(amount), owner: bytesToHex(owner), ownerScheme: scheme[0], borrowScheme: borrow[0],
    borrowGuard: bytesToHex(guard), extensionCommitment: bytesToHex(extension),
  };
}

const key32 = (p: Uint8Array) => {
  if (p.length !== 32) throw new ScriptError('not a 32-byte key');
  return bytesToHex(p);
};

export type PoolSpend =
  | { entry: 'init'; spent: PoolState; kasIn: bigint; owner: string; change: TokenState }
  | { entry: 'buy'; spent: PoolState; kasIn: bigint; ageDaa: bigint; buyer: TokenState }
  | { entry: 'sell'; spent: PoolState; kasOut: bigint; ageDaa: bigint; change: TokenState }
  | { entry: 'sell_all'; spent: PoolState; kasOut: bigint; ageDaa: bigint }
  | { entry: 'add'; spent: PoolState; kasIn: bigint; shares: bigint; ageDaa: bigint; owner: string; change: TokenState }
  | { entry: 'remove'; spent: PoolState; kasOut: bigint; ageDaa: bigint; receiver: TokenState }
  | { entry: 'tick'; spent: PoolState; ageDaa: bigint }
  | { entry: 'collect'; spent: PoolState; fees: TokenState }
  | { entry: 'pause'; spent: PoolState }
  | { entry: 'unpause'; spent: PoolState }
  | { entry: 'set_keys'; spent: PoolState; newAdmin: string; newGuardian: string };

/** Entries that move no kUSDT (they refuse any kUSDT input): no reserve successor. */
const NO_KUSDT_ENTRIES = new Set(['pause', 'unpause', 'set_keys', 'tick']);

/** Entries that claim the pool UTXO's age (`ageDaa`): what a spend claimed, to set against the age its UTXO really had. */
export const CLAIMING_ENTRIES: ReadonlySet<PoolSpend['entry']> = new Set(['buy', 'sell', 'sell_all', 'add', 'remove', 'tick']);

/** Decodes an input spending the pool, or null when it spends another program. */
export function decodePoolSpend(signatureScript: Uint8Array, layout: ProgramLayout): PoolSpend | null {
  let pushes: Uint8Array[];
  try { pushes = parsePushes(signatureScript); } catch { return null; }
  if (pushes.length < 2) return null;
  const spent = decodePoolProgram(pushes[pushes.length - 1], layout);
  if (!spent) return null;
  const tag = bytesToHex(pushes[pushes.length - 2]);
  const a = pushes.slice(0, -2);
  const e = layout.entries;
  try {
    if (tag === e.init && a.length === 13) return { entry: 'init', spent, kasIn: readScriptNum(a[0]), owner: key32(a[1]), change: stateArg(a.slice(2, 8)) };
    if (tag === e.buy && a.length === 10) return { entry: 'buy', spent, kasIn: readScriptNum(a[0]), ageDaa: readScriptNum(a[1]), buyer: stateArg(a.slice(2, 8)) };
    if (tag === e.sell && a.length === 10) return { entry: 'sell', spent, kasOut: readScriptNum(a[0]), ageDaa: readScriptNum(a[1]), change: stateArg(a.slice(2, 8)) };
    if (tag === e.sell_all && a.length === 4) return { entry: 'sell_all', spent, kasOut: readScriptNum(a[0]), ageDaa: readScriptNum(a[1]) };
    if (tag === e.add && a.length === 15) {
      return { entry: 'add', spent, kasIn: readScriptNum(a[0]), shares: readScriptNum(a[1]), ageDaa: readScriptNum(a[2]), owner: key32(a[3]), change: stateArg(a.slice(4, 10)) };
    }
    if (tag === e.remove && a.length === 12) return { entry: 'remove', spent, kasOut: readScriptNum(a[0]), ageDaa: readScriptNum(a[1]), receiver: stateArg(a.slice(2, 8)) };
    if (e.tick !== undefined && tag === e.tick && a.length === 1) return { entry: 'tick', spent, ageDaa: readScriptNum(a[0]) };
    if (tag === e.collect && a.length === 9) return { entry: 'collect', spent, fees: stateArg(a.slice(1, 7)) };
    if (tag === e.pause && a.length === 1) return { entry: 'pause', spent };
    if (tag === e.unpause && a.length === 1) return { entry: 'unpause', spent };
    if (tag === e.set_keys && a.length === 3) return { entry: 'set_keys', spent, newAdmin: key32(a[0]), newGuardian: key32(a[1]) };
  } catch (err) {
    if (err instanceof ScriptError) throw new PoolFollowError(`a pool spend does not decode: ${err.message}`);
    throw err;
  }
  throw new PoolFollowError(`a pool spend uses an unknown entry (tag ${tag}, ${a.length} arguments)`);
}

export type PositionSpend =
  | { entry: 'transfer'; spent: PositionState; newOwner: string }
  | { entry: 'redeem'; spent: PositionState };

/** Decodes an input spending a Position, or null when it spends another program. */
export function decodePositionSpend(signatureScript: Uint8Array, layout: ProgramLayout): PositionSpend | null {
  let pushes: Uint8Array[];
  try { pushes = parsePushes(signatureScript); } catch { return null; }
  if (pushes.length < 2) return null;
  const spent = decodePositionProgram(pushes[pushes.length - 1], layout);
  if (!spent) return null;
  const tag = bytesToHex(pushes[pushes.length - 2]);
  const a = pushes.slice(0, -2);
  if (tag === layout.entries.transfer && a.length === 2 && a[0].length === 32) return { entry: 'transfer', spent, newOwner: bytesToHex(a[0]) };
  if (tag === layout.entries.redeem && a.length === 3) return { entry: 'redeem', spent };
  throw new PoolFollowError(`a position spend uses an unknown entry (tag ${tag}, ${a.length} arguments)`);
}

/** The reserve state a pool state forces (SPEC §15). */
export function reserveOf(pool: PoolState, poolId: string): TokenState {
  return {
    amount: pool.tokenReserve + pool.protocolTokens, owner: poolId.toLowerCase(), ownerScheme: OWNER_COVENANT_ID,
    borrowScheme: 0, borrowGuard: ZERO32, extensionCommitment: ZERO32,
  };
}

/**
 * The KAS the pool's kUSDT reserve at `at` holds, proven from `made`, the body of the transaction that made it (the
 * coordinator serves it with the reserve), without listing the reserve's address (round 21, R21-POOL-1). That address
 * follows from the reserve's amount alone, so anyone can fill it, and anyone can trade the reserve back to that amount
 * after any move. Null when `made` does not prove it: it is not a version 1 body (a version 0 id leaves covenant
 * bindings out), or not the body of `at`'s transaction, or `at` is not that transaction's first output bound to
 * kUSDT, at `script` (the reserve's, from the pool's state), in a transaction that also made a coin of the pool's.
 *
 * Why that output is the reserve, unspent while the pool coin it came with is (pool.ag): the reserve's owner is the
 * pool's covenant, so it moves only beside a coin of the pool's, and a position takes no kUSDT beside it (a transfer
 * refuses any, a redeem needs the pool). Every pool entry either refuses any kUSDT input (tick, pause, unpause,
 * set_keys) or observes kUSDT, spending the reserve (there is none before `init`) and making its successor, at the
 * state the new pool forces, as the transaction's first kUSDT output. So a transaction that made a pool coin and a
 * kUSDT output made the reserve as its first kUSDT output, and the reserve is spent only by a transaction that spends
 * the pool coin of its time. The id covers each output's value, script and binding, so the body shows them as the
 * transaction has them, whoever handed it over.
 */
export function reserveMadeBy(made: unknown, at: Outpoint, script: string, ids: { covenantId: string; poolId: string }): bigint | null {
  const body = idBodyOf(made);
  if (!body || body.version < 1 || transactionIdOf(body) !== at.transactionId.toLowerCase()) return null;
  const kusdt = ids.covenantId.toLowerCase(), pool = ids.poolId.toLowerCase();
  const first = body.outputs.findIndex((o) => o.covenant?.covenantId === kusdt);
  if (first !== at.index || body.outputs[first].scriptPublicKey !== script.toLowerCase()) return null;
  return body.outputs.some((o) => o.covenant?.covenantId === pool) ? body.outputs[first].value : null;
}

export interface PoolLayouts { pool: ProgramLayout; position: ProgramLayout; template: Template }
export interface Outpoint { transactionId: string; index: number }
export interface FollowedUtxo extends Outpoint { amount: bigint; scriptPublicKey: string }

export interface PoolMove {
  spend: PoolSpend;
  pool: { utxo: FollowedUtxo; state: PoolState };
  /** The reserve successor (none for pause, unpause, set_keys and tick, which move no kUSDT). */
  reserve: { utxo: FollowedUtxo; state: TokenState } | null;
  /** A position created by init or add. */
  position?: { utxo: FollowedUtxo; state: PositionState };
  /** The position a remove consumed. */
  consumed?: Outpoint;
}

type Scripts = (actor: 'Pool' | 'Position' | 'KCC20', state: unknown) => string;

/**
 * Follows the pool across `tx` when it spends `current`: null when it
 * doesn't. Throws PoolFollowError when the pool is spent in a way this code
 * can't verify.
 */
export function followPool(txid: string, tx: TxLike, current: HeldOutpoint, poolId: string, layouts: PoolLayouts, scriptOf: Scripts): PoolMove | null {
  const inputIndex = tx.inputs.findIndex((i) => i.previousOutpoint.transactionId === current.transactionId && i.previousOutpoint.index === current.index);
  if (inputIndex < 0) return null;
  if (!provesProgram(current, tx.inputs[inputIndex].signatureScript)) throw new PoolFollowError(`${txid}: the program in this body is not the one the spent pool's script commits to`);
  const spend = decodePoolSpend(hexToBytes(tx.inputs[inputIndex].signatureScript), layouts.pool);
  if (!spend) throw new PoolFollowError(`${txid} spends the pool with a program that is not Pool`);
  const scripts = tx.outputs.map((o) => spkHex(o.scriptPublicKey));
  const poolOutputs = authorizedOutputs(tx, poolId, inputIndex);
  const kusdt = spend.spent.tokenCovid.toLowerCase();
  const kusdtOutputs = tx.outputs.flatMap((o, k) => (o.covenant && String(o.covenant.covenantId).toLowerCase() === kusdt ? [k] : []));
  const utxoAt = (index: number): FollowedUtxo => ({ transactionId: txid, index, amount: BigInt(tx.outputs[index].value), scriptPublicKey: scripts[index] });
  const s = spend.spent;

  // Who paid kUSDT in: any KCC20 input. Even a pool-owned state can (its
  // covenant-ID owner is satisfied by the pool's own input); the reserve as a
  // candidate yields nothing the outputs hold.
  const payers: TokenState[] = [];
  for (const i of tx.inputs) {
    // Any input can carry any bytes: one that doesn't decode is simply not a payer.
    let d: ReturnType<typeof decodeKcc20Input> = null;
    try { d = decodeKcc20Input(hexToBytes(i.signatureScript), layouts.template); } catch { d = null; }
    if (d) payers.push(d.spent);
  }

  const candidates: { next: PoolState; position?: PositionState; consumed?: Outpoint }[] = [];
  switch (spend.entry) {
    case 'init':
      for (const p of payers) {
        const tokensIn = p.amount - spend.change.amount;
        candidates.push({
          next: { ...s, kasReserve: spend.kasIn, tokenReserve: tokensIn, totalShares: spend.kasIn, windowRef: spend.kasIn },
          position: { tokenCovid: s.tokenCovid, shares: spend.kasIn - MIN_LIQUIDITY, owner: spend.owner },
        });
      }
      break;
    case 'buy':
      candidates.push({ next: afterBuy(s, spend.kasIn, spend.buyer.amount, spend.ageDaa) });
      break;
    case 'sell':
      for (const p of payers) candidates.push({ next: afterSell(s, p.amount - spend.change.amount, spend.kasOut, spend.ageDaa) });
      break;
    case 'sell_all':
      for (const p of payers) candidates.push({ next: afterSell(s, p.amount, spend.kasOut, spend.ageDaa) });
      break;
    case 'add':
      for (const p of payers) {
        const tokensIn = p.amount - spend.change.amount;
        candidates.push({
          next: afterAdd(s, spend.kasIn, tokensIn, spend.shares, spend.ageDaa),
          position: { tokenCovid: s.tokenCovid, shares: spend.shares, owner: spend.owner },
        });
      }
      break;
    case 'remove':
      for (const i of tx.inputs) {
        let ps: PositionSpend | null = null;
        try { ps = decodePositionSpend(hexToBytes(i.signatureScript), layouts.position); } catch { ps = null; }
        if (ps?.entry !== 'redeem') continue;
        candidates.push({
          next: afterRemove(s, ps.spent.shares, spend.kasOut, spend.receiver.amount, spend.ageDaa),
          consumed: { transactionId: i.previousOutpoint.transactionId, index: i.previousOutpoint.index },
        });
      }
      break;
    case 'collect':
      candidates.push({ next: { ...s, protocolKas: 0n, protocolTokens: 0n } });
      break;
    case 'pause':
      candidates.push({ next: { ...s, paused: true } });
      break;
    case 'unpause':
      candidates.push({ next: { ...s, paused: false } });
      break;
    case 'set_keys':
      candidates.push({ next: { ...s, admin: spend.newAdmin, guardian: spend.newGuardian } });
      break;
    case 'tick':
      candidates.push({ next: afterTick(s, spend.ageDaa) });
      break;
  }

  // The pool's first authorized output is its successor; init and add authorize a
  // position second.
  const at = poolOutputs[0];
  for (const c of candidates) {
    // Candidates come from every KCC-20-shaped input, whichever token it is, so one can
    // hold numbers no state can: that is a candidate that doesn't match, not a failure.
    let nextScript: string | null = null;
    try { nextScript = scriptOf('Pool', c.next).toLowerCase(); } catch { nextScript = null; }
    if (at === undefined || nextScript === null || scripts[at] !== nextScript) continue;
    const move: PoolMove = { spend, pool: { utxo: utxoAt(at), state: c.next }, reserve: null };
    if (!NO_KUSDT_ENTRIES.has(spend.entry)) {
      const reserve = reserveOf(c.next, poolId);
      const script = scriptOf('KCC20', reserve).toLowerCase();
      const r = kusdtOutputs.find((k) => scripts[k] === script);
      if (r === undefined) throw new PoolFollowError(`${txid}: no kUSDT output holds the ${spend.entry} reserve successor`);
      move.reserve = { utxo: utxoAt(r), state: reserve };
    }
    if (c.position) {
      const p = poolOutputs[1];
      if (p === undefined || scripts[p] !== scriptOf('Position', c.position).toLowerCase()) throw new PoolFollowError(`${txid}: the pool's second authorized output is not the new position`);
      move.position = { utxo: utxoAt(p), state: c.position };
    }
    if (c.consumed) move.consumed = c.consumed;
    return move;
  }
  throw new PoolFollowError(`${txid}: no output holds the computed ${spend.entry} successor of the pool`);
}

/**
 * A Position transfer across `tx` for the position at `current`: the new
 * position, or null when `tx` doesn't spend it or redeems it (a remove).
 */
export function followPositionTransfer(txid: string, tx: TxLike, current: HeldOutpoint, layout: ProgramLayout, scriptOf: Scripts, poolId: string): { utxo: FollowedUtxo; state: PositionState } | 'redeemed' | null {
  const inputIndex = tx.inputs.findIndex((i) => i.previousOutpoint.transactionId === current.transactionId && i.previousOutpoint.index === current.index);
  if (inputIndex < 0) return null;
  if (!provesProgram(current, tx.inputs[inputIndex].signatureScript)) throw new PoolFollowError(`${txid}: the program in this body is not the one the spent position's script commits to`);
  const spend = decodePositionSpend(hexToBytes(tx.inputs[inputIndex].signatureScript), layout);
  if (!spend) throw new PoolFollowError(`${txid} spends a position with a program that is not Position`);
  // A redeem consumes the position and makes no successor, so its input authorizes nothing in
  // the pool's family; a real transfer rewritten as a redeem still has its output, and fails.
  if (spend.entry === 'redeem') {
    if (authorizedOutputs(tx, poolId, inputIndex).length !== 0) throw new PoolFollowError(`${txid}: a redeem of a position authorizes outputs`);
    return 'redeemed';
  }
  const next = { ...spend.spent, owner: spend.newOwner };
  const scripts = tx.outputs.map((o) => spkHex(o.scriptPublicKey));
  const at = authorizedOutputs(tx, poolId, inputIndex)[0];
  if (at === undefined || scripts[at] !== scriptOf('Position', next).toLowerCase()) throw new PoolFollowError(`${txid}: the position's authorized output is not the transferred position`);
  return { utxo: { transactionId: txid, index: at, amount: BigInt(tx.outputs[at].value), scriptPublicKey: scripts[at] }, state: next };
}
