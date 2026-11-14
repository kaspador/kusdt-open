// Reading KCC-20 states out of transactions.
//
// A covenant UTXO shows only the hash of its program, so a state is learned
// from the transaction that created it: the leader of a KCC-20 transfer
// passes every successor state as its `next_states` argument (KCC-20 §2). The
// states are then checked against the outputs' scripts (the `script` core
// command), which makes the decoding trustless.

import { bytesToHex, equalBytes, hexToBytes } from '@kusdt/kaspa';
import { ScriptError, parsePushes, readInt8 } from './script';

export interface TokenState {
  amount: bigint;
  owner: string;          // 32 bytes, hex
  ownerScheme: number;
  borrowScheme: number;
  borrowGuard: string;    // 32 bytes, hex
  extensionCommitment: string;
}

/** The KCC-1 dispatch tags of the standard transfer entrypoints (KCC-20 vectors). */
export const TRANSFER_TAG = '79c71c23';
export const DELEGATOR_TAG = 'fd3ef14a';

/** The standard KCC20 template, as wallets match it (KCC-1 template view). */
export interface Template { templateHash: string; prefix: string; suffix: string }

/** Whether a covenant program `R` is the standard KCC20 actor. */
export function isKcc20Program(program: Uint8Array, template: Template): boolean {
  const prefix = hexToBytes(template.prefix);
  const suffix = hexToBytes(template.suffix);
  // R = prefix ‖ 112-byte KCC20 state ‖ suffix (the template hash is inside the prefix).
  if (program.length !== prefix.length + 112 + suffix.length) return false;
  return equalBytes(program.slice(0, prefix.length), prefix) && equalBytes(program.slice(program.length - suffix.length), suffix);
}

/** Decodes the 112-byte encoded KCC20 state inside a program `R`. */
export function stateOfProgram(program: Uint8Array, template: Template): TokenState {
  const at = hexToBytes(template.prefix).length;
  const s = program.slice(at, at + 112);
  // PushExplicit fields: 08 amount, 20 owner, 01 scheme, 01 borrow, 20 guard, 20 extension.
  const expect = (offset: number, len: number) => {
    if (s[offset] !== len) throw new ScriptError('not an encoded KCC20 state');
  };
  expect(0, 8); expect(9, 32); expect(42, 1); expect(44, 1); expect(46, 32); expect(79, 32);
  return {
    amount: readInt8(s, 1),
    owner: bytesToHex(s.slice(10, 42)),
    ownerScheme: s[43],
    borrowScheme: s[45],
    borrowGuard: bytesToHex(s.slice(47, 79)),
    extensionCommitment: bytesToHex(s.slice(80, 112)),
  };
}

export interface DecodedTransfer {
  /** "leader" calls transfer(next_states, witness); "delegator" calls transfer_delegator. */
  role: 'leader' | 'delegator';
  /** The state this input spends. */
  spent: TokenState;
  /** For a leader: every successor state, in output order. */
  nextStates: TokenState[];
}

/**
 * Decodes the signature script of an input spending a KCC20 state, or answers
 * null when the input is not one (another program, another entrypoint).
 */
export function decodeKcc20Input(signatureScript: Uint8Array, template: Template): DecodedTransfer | null {
  let pushes: Uint8Array[];
  try { pushes = parsePushes(signatureScript); } catch { return null; }
  if (pushes.length < 2) return null;
  const program = pushes[pushes.length - 1];
  if (!isKcc20Program(program, template)) return null;
  const tag = bytesToHex(pushes[pushes.length - 2]);
  // The template's prefix and suffix alone don't make a KCC20 input: anyone can put their own
  // program between them. It must decode to nothing here, never throw: a scanner reading a
  // whole batch would lose everything after this transaction.
  let spent: TokenState;
  try { spent = stateOfProgram(program, template); } catch (e) {
    if (e instanceof ScriptError) return null;
    throw e;
  }
  if (tag === DELEGATOR_TAG) return { role: 'delegator', spent, nextStates: [] };
  if (tag !== TRANSFER_TAG || pushes.length !== 9) return null;
  // next_states (six pushes), then the witness.
  const nextStates = decodeGroupedStates(pushes.slice(0, 6));
  return nextStates ? { role: 'leader', spent, nextStates } : null;
}

/**
 * A `KCC20State[]` argument: one push per field across all states (KCC-1
 * §3.4.6), in field order. Null when the six pushes don't fit together.
 */
export function decodeGroupedStates(pushes: Uint8Array[]): TokenState[] | null {
  if (pushes.length !== 6) return null;
  const [amounts, owners, schemes, borrows, guards, extensions] = pushes;
  const n = amounts.length / 8;
  if (!Number.isInteger(n) || n < 1 || owners.length !== 32 * n || schemes.length !== n || borrows.length !== n
    || guards.length !== 32 * n || extensions.length !== 32 * n) return null;
  const states: TokenState[] = [];
  for (let k = 0; k < n; k++) {
    states.push({
      amount: readInt8(amounts, 8 * k),
      owner: bytesToHex(owners.slice(32 * k, 32 * k + 32)),
      ownerScheme: schemes[k],
      borrowScheme: borrows[k],
      borrowGuard: bytesToHex(guards.slice(32 * k, 32 * k + 32)),
      extensionCommitment: bytesToHex(extensions.slice(32 * k, 32 * k + 32)),
    });
  }
  return states;
}

/** A state as the core's JSON wants it (amounts as numbers or exact strings). */
export function stateJson(s: TokenState) {
  return { ...s, amount: s.amount };
}
