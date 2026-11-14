// Following BridgeMint (SPEC §6) through the transactions that spend it.
//
// A covenant UTXO shows only the hash of its program, so the minter's state is
// learned from its spend: the spent state sits inside the program `R` (the last
// push), and the successor follows from the entry's arguments by the
// covenant's own arithmetic, mirrored here. A successor is adopted only when
// the locking script the core computes for it is one of the transaction's
// outputs, and a mint only when every recipient's script is too: a decoding
// mistake can never be adopted silently, it surfaces as a MinterFollowError.
//
// "Is one of the outputs" means exactly what the covenant means: an output
// bound to the family's covenant ID and authorized by the spending input, in
// the covenant's order (the successor first, then the minted states). A plain
// output paying to the same P2SH script is a decoy that consensus doesn't bind
// to the family, and it is never adopted.
//
// A transaction id does not commit to signature scripts: a miner can publish a
// block with a rewritten body under a real txid (consensus drops a body whose
// script fails, but the txid stays accepted). A body is believed only when it
// proves itself: its program R hashes to the spent output's script, its
// arguments reproduce the outputs, and a mint or governance move carries the
// quorum's signatures over the digest, checked against the signer set of the
// held state. The scanner keeps every body (AcceptedTx.variants).

import { schnorr } from '@noble/curves/secp256k1.js';
import { blake2b } from '@noble/hashes/blake2.js';
import { blake3 } from '@noble/hashes/blake3.js';
import { bytesToHex, equalBytes, hexToBytes } from '@kusdt/kaspa';
import { ScriptError, parsePushes, readInt8, readScriptNum, writeInt8 } from './script';
import { decodeGroupedStates, type TokenState } from './kcc20';
import { CHAIN_BSC, CHAIN_ETHEREUM } from './evm';

export interface MinterState {
  remaining: bigint;
  bucket: bigint;
  capacity: bigint;
  refillPerDaa: bigint;
  nonceEthereum: bigint;
  nonceBsc: bigint;
  adminNonce: bigint;
  paused: boolean;
  signerSet: string;
  guardian: string;
  extensionCommitment: string;
  /** DAA the minter must stand untouched before a recovery can be carried out. Fixed at genesis. */
  recoveryDelay: bigint;
  /** The next nonce a recovery proposal or veto must carry. */
  recoveryNonce: bigint;
  recoveryPending: boolean;
  recoverySignerSet: string;
  recoveryGuardian: string;
}

/** One actor's program as the core's `layout` command describes it. */
export interface ProgramLayout {
  templateHash: string;
  prefix: string;
  stateLength: number;
  suffix: string;
  entries: Record<string, string>;
}

export const ACTION = { unpause: 1, setLimits: 2, setSigners: 3, skipNonce: 4, setValue: 5, proposeRecovery: 6, vetoRecovery: 7 } as const;

/** 72 hours at 10 blocks per second: how long the minter must stand untouched on mainnet before a recovery. */
/** The highest allowance ceiling and refill rate the minter takes (bridge_mint.ag MAX_LIMIT). */
export const MAX_LIMIT = 1_000_000_000_000_000n;
/**
 * The most inputs a minter or pool transaction may have (bridge_mint.ag MAX_TX_INPUTS): the covenant input, the other
 * covenant coins the entry takes, and the funding coins. Each funding coin is a plain Schnorr P2PK coin already in a
 * block, or an output of the transaction that made the minter or pool coin (`require_settled_inputs`).
 */
export const MAX_TX_INPUTS = 8;
/** The DAA score a node gives an output of a transaction still in its mempool (rusty-kaspa UNACCEPTED_DAA_SCORE). */
export const UNACCEPTED_DAA_SCORE = 0xffff_ffff_ffff_ffffn;
export const MAINNET_RECOVERY_DELAY_DAA = 2_592_000n;
const ZERO32_HEX = '00'.repeat(32);

export class MinterFollowError extends Error {}

/** The minter state as the core's JSON takes it (integers stay exact). */
export function minterJson(s: MinterState) {
  return { ...s };
}

/** A minter state from the core's or a store's JSON (numbers or decimal strings). */
export function minterFromJson(j: any): MinterState {
  const int = (v: unknown) => BigInt(v as any);
  return {
    remaining: int(j.remaining), bucket: int(j.bucket), capacity: int(j.capacity),
    refillPerDaa: int(j.refillPerDaa), nonceEthereum: int(j.nonceEthereum), nonceBsc: int(j.nonceBsc),
    adminNonce: int(j.adminNonce), paused: Boolean(j.paused), signerSet: String(j.signerSet).toLowerCase(),
    guardian: String(j.guardian).toLowerCase(), extensionCommitment: String(j.extensionCommitment ?? '00'.repeat(32)).toLowerCase(),
    recoveryDelay: j.recoveryDelay === undefined ? MAINNET_RECOVERY_DELAY_DAA : int(j.recoveryDelay), recoveryNonce: int(j.recoveryNonce ?? 0),
    recoveryPending: Boolean(j.recoveryPending), recoverySignerSet: String(j.recoverySignerSet ?? ZERO32_HEX).toLowerCase(),
    recoveryGuardian: String(j.recoveryGuardian ?? ZERO32_HEX).toLowerCase(),
  };
}

/** The state inside a BridgeMint program `R`, or null when `R` is another program. */
export function decodeMinterProgram(program: Uint8Array, layout: ProgramLayout): MinterState | null {
  const prefix = hexToBytes(layout.prefix);
  const suffix = hexToBytes(layout.suffix);
  if (program.length !== prefix.length + layout.stateLength + suffix.length) return null;
  if (!equalBytes(program.slice(0, prefix.length), prefix)) return null;
  if (!equalBytes(program.slice(program.length - suffix.length), suffix)) return null;
  const s = program.slice(prefix.length, prefix.length + layout.stateLength);
  // PushExplicit fields (KCC-1 §3.4.3): the KCC20 template hash the minter
  // builds outputs with, seven ints, a bool, three 32-byte fields, then the recovery
  // fields: two ints, a bool and two 32-byte fields.
  let at = 0;
  const field = (len: number) => {
    if (s[at] !== len) throw new ScriptError('not an encoded BridgeMint state');
    const value = s.slice(at + 1, at + 1 + len);
    at += 1 + len;
    return value;
  };
  try {
    field(32);
    const ints = Array.from({ length: 7 }, () => readInt8(field(8)));
    const paused = field(1)[0];
    if (paused > 1) throw new ScriptError('not an encoded bool');
    const [signerSet, guardian, extension] = [field(32), field(32), field(32)];
    const [recoveryDelay, recoveryNonce] = [readInt8(field(8)), readInt8(field(8))];
    const recoveryPending = field(1)[0];
    if (recoveryPending > 1) throw new ScriptError('not an encoded bool');
    const [recoverySignerSet, recoveryGuardian] = [field(32), field(32)];
    if (at !== s.length) return null;
    const [remaining, bucket, capacity, refillPerDaa, nonceEthereum, nonceBsc, adminNonce] = ints;
    return {
      remaining, bucket, capacity, refillPerDaa, nonceEthereum, nonceBsc, adminNonce,
      paused: paused === 1, signerSet: bytesToHex(signerSet), guardian: bytesToHex(guardian), extensionCommitment: bytesToHex(extension),
      recoveryDelay, recoveryNonce, recoveryPending: recoveryPending === 1,
      recoverySignerSet: bytesToHex(recoverySignerSet), recoveryGuardian: bytesToHex(recoveryGuardian),
    };
  } catch (e) {
    if (e instanceof ScriptError) return null;
    throw e;
  }
}

/** The spends that carry signatures. */
export type QuorumSpend = Exclude<MinterSpend, { entry: 'pause' } | { entry: 'executeRecovery' }>;

/** The quorum a mint or a governance move carries: the arguments of `require_quorum` (bridge_mint.ag). */
export interface QuorumArgs { signerKeys: Uint8Array; indices: Uint8Array; signatures: Uint8Array }

export type MinterSpend =
  | { entry: 'mint'; spent: MinterState; chain: number; firstNonce: bigint; ageDaa: bigint; recipients: TokenState[]; quorum: QuorumArgs }
  | { entry: 'pause'; spent: MinterState }
  | { entry: 'executeRecovery'; spent: MinterState }
  | { entry: 'govern'; spent: MinterState; action: number; params: Uint8Array; ageDaa: bigint; quorum: QuorumArgs };

const byteArg = (push: Uint8Array) => {
  if (push.length > 1) throw new ScriptError('a byte argument is longer than one byte');
  return push.length ? push[0] : 0;
};

/** Decodes an input spending the minter, or answers null when the input spends another program. */
export function decodeMinterSpend(signatureScript: Uint8Array, layout: ProgramLayout): MinterSpend | null {
  let pushes: Uint8Array[];
  try { pushes = parsePushes(signatureScript); } catch { return null; }
  if (pushes.length < 2) return null;
  const spent = decodeMinterProgram(pushes[pushes.length - 1], layout);
  if (!spent) return null;
  const tag = bytesToHex(pushes[pushes.length - 2]);
  const args = pushes.slice(0, -2);
  try {
    if (tag === layout.entries.mint && args.length === 14) {
      // chain, first_nonce, age_daa, recipients (6), signer keys, indices, signatures, KCC20 prefix, suffix
      const recipients = decodeGroupedStates(args.slice(3, 9));
      if (!recipients) throw new ScriptError('the recipients argument does not decode');
      return { entry: 'mint', spent, chain: byteArg(args[0]), firstNonce: readScriptNum(args[1]), ageDaa: readScriptNum(args[2]), recipients, quorum: { signerKeys: args[9], indices: args[10], signatures: args[11] } };
    }
    if (tag === layout.entries.pause && args.length === 1) return { entry: 'pause', spent };
    if (tag === layout.entries.execute_recovery && args.length === 0) return { entry: 'executeRecovery', spent };
    if (tag === layout.entries.govern && args.length === 6) {
      // action, params, age_daa, signer keys, indices, signatures
      // Every action settles the allowance with age_daa, as a mint does, and the quorum signs it (quorumDigest).
      return { entry: 'govern', spent, action: byteArg(args[0]), params: args[1], ageDaa: readScriptNum(args[2]), quorum: { signerKeys: args[3], indices: args[4], signatures: args[5] } };
    }
  } catch (e) {
    if (e instanceof ScriptError) throw new MinterFollowError(`a minter spend does not decode: ${e.message}`);
    throw e;
  }
  throw new MinterFollowError(`a minter spend uses an unknown entry (tag ${tag}, ${args.length} arguments)`);
}

/** The covenant's `refilled`: the allowance once the minter UTXO is `ageDaa` old, exactly. */
export function refilled(bucket: bigint, ageDaa: bigint, capacity: bigint, refillPerDaa: bigint): bigint {
  if (ageDaa < 0n) throw new MinterFollowError('a negative age');
  if (refillPerDaa < 0n) throw new MinterFollowError('negative refill');
  let filled = bucket;
  if (refillPerDaa > 0n && bucket < capacity) {
    const needed = (capacity - bucket + refillPerDaa - 1n) / refillPerDaa;
    filled = ageDaa >= needed ? capacity : bucket + ageDaa * refillPerDaa;
  }
  return filled > capacity ? capacity : filled;
}

/** What a spend leaves between the age it claims and the age it read: a block more or less must not make consensus hold it back. */
export const AGE_MARGIN_DAA = 10n;
const MAX_AGE_DAA = (1n << 32n) - 1n;

/**
 * The age a spend of the minter can claim now: consensus holds the input back until the UTXO is that old, and
 * claiming less only refills less, so an unknown creation (null, as at genesis) claims nothing.
 */
export function claimableAge(virtualDaa: bigint, utxoDaa: bigint | number | string | null | undefined): bigint {
  if (utxoDaa === null || utxoDaa === undefined) return 0n;
  const age = virtualDaa - BigInt(utxoDaa) - AGE_MARGIN_DAA;
  return age <= 0n ? 0n : age > MAX_AGE_DAA ? MAX_AGE_DAA : age;
}

/**
 * What a governance action's default age leaves below the age the signer reads. Larger than a mint's margin: a mint
 * is built and sent at once, a governance action is signed by several people over minutes or hours and sent later,
 * and a small reorg must not move the minter coin's DAA score past the age signed. 600 DAA is a minute at ten
 * blocks per second, and costs a minute of refill.
 */
export const GOVERN_AGE_MARGIN_DAA = 600n;

/**
 * The least age at which the allowance is back at its ceiling: a spend that claims more credits nothing more.
 * 0 when nothing can refill (no refill rate, or the allowance already at or over the ceiling).
 */
export function fullRefillAge(m: { bucket: bigint; capacity: bigint; refillPerDaa: bigint }): bigint {
  if (m.refillPerDaa <= 0n || m.bucket >= m.capacity) return 0n;
  return (m.capacity - m.bucket + m.refillPerDaa - 1n) / m.refillPerDaa;
}

/**
 * The age a governance action is signed for when the operator names none: the minter coin's age now less
 * GOVERN_AGE_MARGIN_DAA, and never more than a full refill needs. The signers sign this age (SPEC §6), and consensus
 * holds the spend back until the minter coin is that old: if a mint replaces the coin before the action is sent, the
 * action waits that long on the new coin. Claiming more than a full refill would lengthen that wait and credit
 * nothing, so the default never does. An unknown creation (null, as at genesis) claims nothing.
 */
export function governAge(m: { bucket: bigint; capacity: bigint; refillPerDaa: bigint }, virtualDaa: bigint, utxoDaa: bigint | number | string | null | undefined): bigint {
  if (utxoDaa === null || utxoDaa === undefined) return 0n;
  const age = virtualDaa - BigInt(utxoDaa) - GOVERN_AGE_MARGIN_DAA;
  const most = fullRefillAge(m);
  const capped = age > most ? most : age;
  return capped <= 0n ? 0n : capped > MAX_AGE_DAA ? MAX_AGE_DAA : capped;
}

export interface MinterStep {
  next: MinterState;
  /** The new KAS value of the minter UTXO (set_value), else unchanged. */
  value?: bigint;
  /** A mint's recipients, in order. */
  minted: TokenState[];
  /** A skip_nonce: the deposit that will be refunded instead. */
  skipped?: { chain: number; nonce: bigint };
}

/** The recovery fields after a veto, an execution, or four signers replacing the set. */
const recoveryCleared = (s: MinterState) => ({ recoveryNonce: s.recoveryNonce + 1n, recoveryPending: false, recoverySignerSet: ZERO32_HEX, recoveryGuardian: ZERO32_HEX });

/** The successor state, by the covenant's arithmetic (SPEC §6). */
export function nextMinter(spend: MinterSpend): MinterStep {
  const s = spend.spent;
  // A pause moves the admin nonce: it voids every 4-of-5 signature made before it (bridge_mint.ag, pause).
  if (spend.entry === 'pause') {
    if (s.paused) throw new MinterFollowError('a pause of a paused minter');
    return { next: { ...s, paused: true, adminNonce: s.adminNonce + 1n }, minted: [] };
  }
  if (spend.entry === 'executeRecovery') {
    if (!s.recoveryPending) throw new MinterFollowError('execute_recovery with no recovery proposed');
    return { next: { ...s, signerSet: s.recoverySignerSet, guardian: s.recoveryGuardian, adminNonce: s.adminNonce + 1n, ...recoveryCleared(s) }, minted: [] };
  }
  if (spend.entry === 'mint') {
    const n = BigInt(spend.recipients.length);
    const total = spend.recipients.reduce((sum, r) => sum + r.amount, 0n);
    const available = refilled(s.bucket, spend.ageDaa, s.capacity, s.refillPerDaa);
    const next = { ...s, remaining: s.remaining - total, bucket: available - total };
    const held = spend.chain === CHAIN_ETHEREUM ? s.nonceEthereum : spend.chain === CHAIN_BSC ? s.nonceBsc : null;
    if (held === null) throw new MinterFollowError(`a mint names unknown chain ${spend.chain}`);
    // The covenant's own require: a body replaying an older identical mint carries good signatures over another nonce.
    if (spend.firstNonce !== held) throw new MinterFollowError(`a mint starts at nonce ${spend.firstNonce} of chain ${spend.chain}, the minter holds ${held}`);
    if (spend.chain === CHAIN_ETHEREUM) next.nonceEthereum = held + n;
    else next.nonceBsc = held + n;
    return { next, minted: spend.recipients };
  }
  const p = spend.params;
  // The spend restarts the UTXO's age, so every action settles the allowance first (bridge_mint.ag, govern).
  const settled = refilled(s.bucket, spend.ageDaa, s.capacity, s.refillPerDaa);
  const next = { ...s, adminNonce: s.adminNonce + 1n, bucket: settled };
  switch (spend.action) {
    case ACTION.proposeRecovery:
      if (p.length !== 64) throw new MinterFollowError('propose_recovery params are not 64 bytes');
      if (s.recoveryPending) throw new MinterFollowError('a recovery is proposed already');
      return {
        next: { ...s, bucket: settled, recoveryNonce: s.recoveryNonce + 1n, recoveryPending: true, recoverySignerSet: bytesToHex(p.slice(0, 32)), recoveryGuardian: bytesToHex(p.slice(32, 64)) },
        minted: [],
      };
    case ACTION.vetoRecovery:
      if (p.length !== 0) throw new MinterFollowError('veto_recovery params are not empty');
      if (!s.recoveryPending) throw new MinterFollowError('no recovery to veto');
      return { next: { ...s, bucket: settled, ...recoveryCleared(s) }, minted: [] };
    case ACTION.unpause:
      if (!s.paused) throw new MinterFollowError('an unpause of a minter that is not paused');
      next.paused = false;
      return { next, minted: [] };
    case ACTION.setLimits: {
      if (p.length !== 16) throw new MinterFollowError('set_limits params are not 16 bytes');
      next.capacity = readInt8(p, 0);
      next.refillPerDaa = readInt8(p, 8);
      if (next.capacity > MAX_LIMIT || next.refillPerDaa > MAX_LIMIT) throw new MinterFollowError('set_limits above the highest limit the minter takes');
      next.bucket = settled > next.capacity ? next.capacity : settled;
      return { next, minted: [] };
    }
    case ACTION.setSigners:
      if (p.length !== 64) throw new MinterFollowError('set_signers params are not 64 bytes');
      next.signerSet = bytesToHex(p.slice(0, 32));
      next.guardian = bytesToHex(p.slice(32, 64));
      return { next: { ...next, ...recoveryCleared(s) }, minted: [] };
    case ACTION.skipNonce: {
      if (p.length !== 9) throw new MinterFollowError('skip_nonce params are not 9 bytes');
      const chain = p[0];
      const nonce = readInt8(p, 1);
      const held = chain === CHAIN_ETHEREUM ? s.nonceEthereum : chain === CHAIN_BSC ? s.nonceBsc : null;
      if (held === null) throw new MinterFollowError(`skip_nonce names unknown chain ${chain}`);
      // The covenant's own require: an unused skip quorum at this admin nonce must not be read as this spend.
      if (nonce !== held) throw new MinterFollowError(`a skip of nonce ${nonce} of chain ${chain}, the minter holds ${held}`);
      if (chain === CHAIN_ETHEREUM) next.nonceEthereum = nonce + 1n;
      else next.nonceBsc = nonce + 1n;
      return { next, minted: [], skipped: { chain, nonce } };
    }
    case ACTION.setValue:
      if (p.length !== 8) throw new MinterFollowError('set_value params are not 8 bytes');
      return { next, value: readInt8(p, 0), minted: [] };
    default:
      throw new MinterFollowError(`unknown governance action ${spend.action}`);
  }
}

/** The fields of a node (or core) transaction the follower reads. */
export interface TxLike {
  inputs: { previousOutpoint: { transactionId: string; index: number }; signatureScript: string }[];
  outputs: {
    value: bigint | number | string;
    scriptPublicKey: string | { version: number; scriptPublicKey: string };
    /** KIP-20 binding: the family and the input that authorized the output (null for a plain output). */
    covenant?: { covenantId: string; authorizingInput: number | string } | null;
  }[];
}

/** The core's locking script of P2SH(`program`): BLAKE2b-256 of the program, as consensus hashes it. */
export function p2shOfProgram(program: Uint8Array): string {
  return `0000aa20${bytesToHex(blake2b(program, { dkLen: 32 }))}87`;
}

/** A held output, with the locking script the program in a spend of it must hash to. */
export interface HeldOutpoint {
  transactionId: string;
  index: number;
  scriptPublicKey?: TxLike['outputs'][number]['scriptPublicKey'];
}

/** Whether `signatureScript`'s last push (the program R) hashes to the script of `current`. */
export function provesProgram(current: HeldOutpoint, signatureScript: string): boolean {
  if (current.scriptPublicKey === undefined) return false;
  let pushes: Uint8Array[];
  try { pushes = parsePushes(hexToBytes(signatureScript)); } catch { return false; }
  return pushes.length > 0 && p2shOfProgram(pushes[pushes.length - 1]) === spkHex(current.scriptPublicKey);
}

const MINT_QUORUM = 3;
const ADMIN_QUORUM = 4;
const SIGNERS = 5;
const utf8 = (text: string) => new TextEncoder().encode(text);

function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
}

/** The outpoint of the minter coin a spend spends: an unpause signs it (bridge_mint.ag, unpause_digest). */
export interface SpentOutpoint { transactionId: string; index: number }

/**
 * What four signers sign to lift a pause (SPEC §6): the paused minter coin itself, so that it cannot be signed before
 * the pause exists, and the age of that coin the spend claims (it settles the allowance):
 * BLAKE3("kUSDT/unpause/v2" ‖ covenant_id[32] ‖ admin_nonce[8] ‖ age_daa[8] ‖ outpoint_txid[32] ‖ outpoint_index[8]).
 */
export function unpauseDigest(covenantId: string, adminNonce: bigint, ageDaa: bigint, spent: SpentOutpoint): Uint8Array {
  const txid = hexToBytes(spent.transactionId);
  if (txid.length !== 32 || !Number.isSafeInteger(spent.index) || spent.index < 0 || spent.index > 0xffffffff) throw new ScriptError('not an outpoint');
  return blake3(concat([utf8('kUSDT/unpause/v2'), hexToBytes(covenantId), writeInt8(adminNonce), writeInt8(ageDaa), txid, writeInt8(BigInt(spent.index))]));
}

/**
 * The digest the quorum signs for `spend` (SPEC §6), and the fewest signatures that can stand for it, as the covenant
 * counts them. `spent` is the outpoint the spend spends: an unpause signs it, and without it no unpause has a quorum.
 */
function quorumDigest(spend: QuorumSpend, covenantId: string, spent?: SpentOutpoint): { digest: Uint8Array; atLeast: number } {
  const covenant = hexToBytes(covenantId);
  if (spend.entry === 'mint') {
    // The claimed age is signed: a body resubmitted with another age does not carry the quorum.
    const parts: Uint8Array[] = [utf8('kUSDT/mint/v2'), covenant, Uint8Array.of(spend.chain), writeInt8(spend.firstNonce), writeInt8(spend.ageDaa)];
    for (const r of spend.recipients) parts.push(Uint8Array.of(r.ownerScheme), hexToBytes(r.owner), writeInt8(r.amount));
    return { digest: blake3(concat(parts)), atLeast: MINT_QUORUM };
  }
  // A recovery proposal or veto has its own nonce and quorum (bridge_mint.ag, govern).
  const propose = spend.action === ACTION.proposeRecovery, veto = spend.action === ACTION.vetoRecovery;
  const nonce = propose || veto ? spend.spent.recoveryNonce : spend.spent.adminNonce;
  if (spend.action === ACTION.unpause) {
    if (!spent) throw new ScriptError('an unpause signs the outpoint it spends');
    return { digest: unpauseDigest(covenantId, nonce, spend.ageDaa, spent), atLeast: ADMIN_QUORUM };
  }
  // The claimed age is signed, as a mint's is: a body resubmitted with another age does not carry the quorum.
  const parts = [utf8('kUSDT/govern/v2'), covenant, writeInt8(nonce), writeInt8(spend.ageDaa), Uint8Array.of(spend.action), spend.params];
  return { digest: blake3(concat(parts)), atLeast: propose ? MINT_QUORUM : veto ? 1 : ADMIN_QUORUM };
}

/**
 * `require_quorum` of bridge_mint.ag: the signatures in `spend` are exactly its quorum over the digest, by distinct
 * members (in order) of the signer set of the state it spends. `spent` is the outpoint of the minter coin the spend
 * spends (an unpause signs it). Exactly, as the covenant requires (`indices.length == quorum`): until run 21
 * (R21-CRYPTO-2) more signatures than the quorum passed here, though no such body can be valid.
 */
export function hasQuorum(spend: QuorumSpend, covenantId: string, spent?: SpentOutpoint): boolean {
  const { signerKeys, indices, signatures } = spend.quorum;
  let digest: Uint8Array;
  let atLeast: number;
  try { ({ digest, atLeast } = quorumDigest(spend, covenantId, spent)); } catch { return false; }
  const quorum = indices.length;
  if (signerKeys.length !== 32 * SIGNERS || quorum !== atLeast || signatures.length !== 64 * quorum) return false;
  if (bytesToHex(blake3(signerKeys)) !== spend.spent.signerSet.toLowerCase()) return false;
  let previous = -1;
  for (let i = 0; i < quorum; i++) {
    const index = indices[i];
    if (index <= previous || index >= SIGNERS) return false;
    previous = index;
    let valid = false;
    try { valid = schnorr.verify(signatures.subarray(64 * i, 64 * i + 64), digest, signerKeys.subarray(32 * index, 32 * index + 32)); } catch { /* not a signature */ }
    if (!valid) return false;
  }
  return true;
}

/** Indices of the outputs bound to `covenantId` and authorized by input `inputIndex`, in output order. */
export function authorizedOutputs(tx: TxLike, covenantId: string, inputIndex: number): number[] {
  const want = covenantId.toLowerCase();
  const out: number[] = [];
  tx.outputs.forEach((o, k) => {
    if (o.covenant && String(o.covenant.covenantId).toLowerCase() === want && Number(o.covenant.authorizingInput) === inputIndex) out.push(k);
  });
  return out;
}

/** An output's script public key as the core writes it: 2-byte big-endian version, then the script. */
export function spkHex(spk: TxLike['outputs'][number]['scriptPublicKey']): string {
  if (typeof spk === 'string') return spk.toLowerCase();
  return spk.version.toString(16).padStart(4, '0') + spk.scriptPublicKey.toLowerCase();
}

export interface MinterUtxo { transactionId: string; index: number; amount: bigint; scriptPublicKey: string }

export interface MinterMove {
  spend: MinterSpend;
  step: MinterStep;
  /** The successor minter UTXO and state. */
  minter: { utxo: MinterUtxo; state: MinterState };
  /** For a mint: each recipient and the output that holds it. */
  minted: { index: number; state: TokenState }[];
}

/**
 * Follows the minter across `tx` when it spends `current`: null when it
 * doesn't. Throws MinterFollowError when this body doesn't prove the move: a
 * body rewritten under a real txid, or a spend this code can't verify (which a
 * monitor must treat as an alarm once no body of the transaction proves it).
 */
export function followMinter(
  txid: string,
  tx: TxLike,
  current: HeldOutpoint,
  layout: ProgramLayout,
  scriptOf: (actor: 'BridgeMint' | 'KCC20', state: unknown) => string,
  covenantId: string,
): MinterMove | null {
  const inputIndex = tx.inputs.findIndex((i) => i.previousOutpoint.transactionId === current.transactionId && i.previousOutpoint.index === current.index);
  if (inputIndex < 0) return null;
  if (!provesProgram(current, tx.inputs[inputIndex].signatureScript)) {
    throw new MinterFollowError(`${txid}: the program in this body is not the one the spent minter's script commits to`);
  }
  const spend = decodeMinterSpend(hexToBytes(tx.inputs[inputIndex].signatureScript), layout);
  if (!spend) throw new MinterFollowError(`${txid} spends the minter with a program that is not BridgeMint`);
  if (spend.entry !== 'pause' && spend.entry !== 'executeRecovery' && !hasQuorum(spend, covenantId, { transactionId: current.transactionId, index: current.index })) {
    throw new MinterFollowError(`${txid}: the ${spend.entry} in this body does not carry the signers' quorum`);
  }
  const step = nextMinter(spend);
  // The covenant's own order: its first authorized output is the successor, the
  // next ones are the minted states.
  const authorized = authorizedOutputs(tx, covenantId, inputIndex);
  const scripts = tx.outputs.map((o) => spkHex(o.scriptPublicKey));
  const at = authorized[0];
  const want = scriptOf('BridgeMint', minterJson(step.next)).toLowerCase();
  if (at === undefined || scripts[at] !== want) throw new MinterFollowError(`${txid}: the minter's first authorized output is not the computed ${spend.entry} successor`);
  if (authorized.length !== 1 + step.minted.length) throw new MinterFollowError(`${txid}: the minter authorizes ${authorized.length} outputs, the ${spend.entry} makes ${1 + step.minted.length}`);
  const minted = step.minted.map((state, k) => {
    const index = authorized[1 + k];
    if (scripts[index] !== scriptOf('KCC20', { ...state }).toLowerCase()) throw new MinterFollowError(`${txid}: minted output ${index} is not recipient ${k}`);
    return { index, state };
  });
  return {
    spend,
    step,
    minter: { utxo: { transactionId: txid, index: at, amount: BigInt(tx.outputs[at].value), scriptPublicKey: scripts[at] }, state: step.next },
    minted,
  };
}

/** The least KAS (sompi) the minter lets a minted output carry (bridge_mint.ag MIN_MINTED_VALUE): 1 KAS. */
export const MIN_MINTED_VALUE = 100_000_000n;
