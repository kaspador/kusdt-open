// The id of a transaction from its body as a node or the core writes it in JSON, version 0 and 1: rusty-kaspa
// consensus/core/src/hashing/tx.rs `id`, at the revision the core pins (a41a333). tx.ts has the version 0 id of the
// wallet's own plain transactions; this one reads any body, covenant bindings included.
//
// An id commits to each input's outpoint and sequence, to each output (its value, its script and, from version 1, its
// covenant binding), and to the lock time, the subnetwork, the gas and the payload. It does not commit to signature
// scripts, signature operation counts, compute budgets or masses. So a body that hashes to an id shows what that
// transaction spends and what it makes, whoever handed the body over: a client proves an output from it without
// listing the output's address (round 21, R21-POOL-1: the pool's kUSDT reserve, protocol/pool-follow.ts
// reserveMadeBy). A version 0 id leaves the bindings out (R21-IDENT-3): only a version 1 body proves one. And a
// version 1 id commits to the payload only by its digest (PayloadDigest), so a version 1 body handed out carries that
// digest in place of the payload: whatever a trader puts in a payload (up to about 125 KB) costs nobody who reads it.

import { blake2b } from '@noble/hashes/blake2.js';
import { blake3 } from '@noble/hashes/blake3.js';
import { bytesToHex, concatBytes, hexToBytes } from './bytes';

/** A body as far as its id goes, read exactly (idBodyOf). A script is hex: its version's 2 bytes big-endian, then the script, as the core writes it. */
export interface IdBody {
  version: number;
  inputs: { transactionId: string; index: number; sequence: bigint }[];
  outputs: { value: bigint; scriptPublicKey: string; covenant: { authorizingInput: number; covenantId: string } | null }[];
  lockTime: bigint;
  subnetworkId: string;
  gas: bigint;
  /** What the id commits to of the payload (hex): the payload itself for version 0, its PayloadDigest for version 1. */
  payloadCommitment: string;
}

/**
 * The parts of a JSON body its id commits to, in that JSON, the values as they were: what a server hands out for a
 * client to check against the id. Signature scripts (most of a covenant spend's bytes), signature operation counts,
 * compute budgets, masses and verbose data are left out, and so is a version 1 body's payload: its digest stands in
 * for it (`payloadDigest`). An empty payload is a payload too (a follower's body may leave it out).
 */
export function idFieldsOf(tx: any) {
  const payload = hexOf(tx.payload ?? '');
  return {
    version: tx.version,
    inputs: (tx.inputs ?? []).map((i: any) => ({ previousOutpoint: { transactionId: i?.previousOutpoint?.transactionId, index: i?.previousOutpoint?.index }, sequence: i?.sequence })),
    outputs: (tx.outputs ?? []).map((o: any) => ({ value: o?.value, scriptPublicKey: o?.scriptPublicKey, covenant: o?.covenant ? { authorizingInput: o.covenant.authorizingInput, covenantId: o.covenant.covenantId } : null })),
    lockTime: tx.lockTime, subnetworkId: tx.subnetworkId, gas: tx.gas,
    ...(typeof tx.version === 'number' && tx.version >= 1 && payload !== null ? { payloadDigest: payloadDigestOf(payload) } : { payload: tx.payload ?? '' }),
  };
}
export type IdFields = ReturnType<typeof idFieldsOf>;

const U64_MAX = (1n << 64n) - 1n;

/** A u64 as JSON gives it exactly: a safe integer, or a string of digits (16 or more digits arrive as one). */
function u64(v: unknown): bigint | null {
  const b = typeof v === 'bigint' ? v : typeof v === 'number' && Number.isSafeInteger(v) ? BigInt(v) : typeof v === 'string' && /^\d{1,20}$/.test(v) ? BigInt(v) : null;
  return b !== null && b >= 0n && b <= U64_MAX ? b : null;
}
const uint = (v: unknown, max: number): number | null => {
  const n = typeof v === 'string' && /^\d{1,10}$/.test(v) ? Number(v) : v;
  return typeof n === 'number' && Number.isInteger(n) && n >= 0 && n <= max ? n : null;
};
const present = <T>(x: T | null): x is T => x !== null;
/** Hex of whole bytes (of `chars` characters when given), lowercased. */
const hexOf = (v: unknown, chars?: number): string | null =>
  typeof v === 'string' && /^(?:[0-9a-fA-F]{2})*$/.test(v) && (chars === undefined || v.length === chars) ? v.toLowerCase() : null;
/** A script as the core writes it ("0000" + script), or as a node may ({version, scriptPublicKey}). */
function scriptOf(v: unknown): string | null {
  if (typeof v === 'string') return v.length >= 4 ? hexOf(v) : null;
  const o = v as { version?: unknown; scriptPublicKey?: unknown } | null;
  const version = uint(o?.version, 0xffff), script = hexOf(o?.scriptPublicKey);
  return version === null || script === null ? null : version.toString(16).padStart(4, '0') + script;
}

/** `v` read as a transaction body, as far as its id goes; null when anything in it is not what a body holds. */
export function idBodyOf(v: unknown): IdBody | null {
  const b = v as Record<string, any> | null;
  if (!b || typeof b !== 'object' || !Array.isArray(b.inputs) || !Array.isArray(b.outputs)) return null;
  const inputs = (b.inputs as any[]).map((i): IdBody['inputs'][number] | null => {
    const transactionId = hexOf(i?.previousOutpoint?.transactionId, 64), index = uint(i?.previousOutpoint?.index, 0xffff_ffff), sequence = u64(i?.sequence);
    return transactionId === null || index === null || sequence === null ? null : { transactionId, index, sequence };
  });
  const outputs = (b.outputs as any[]).map((o): IdBody['outputs'][number] | null => {
    const value = u64(o?.value), scriptPublicKey = scriptOf(o?.scriptPublicKey);
    if (value === null || scriptPublicKey === null) return null;
    if (o.covenant == null) return { value, scriptPublicKey, covenant: null };
    const authorizingInput = uint(o.covenant.authorizingInput, 0xffff), covenantId = hexOf(o.covenant.covenantId, 64);
    return authorizingInput === null || covenantId === null ? null : { value, scriptPublicKey, covenant: { authorizingInput, covenantId } };
  });
  const version = uint(b.version, 0xffff), lockTime = u64(b.lockTime), gas = u64(b.gas), subnetworkId = hexOf(b.subnetworkId, 40);
  // The payload, or for version 1 its digest in its place (idFieldsOf).
  const payload = b.payload === undefined ? null : hexOf(b.payload);
  const payloadCommitment = version === null ? null
    : b.payload === undefined ? (version >= 1 ? hexOf(b.payloadDigest, 64) : null)
      : payload === null ? null : version === 0 ? payload : payloadDigestOf(payload);
  if (version === null || lockTime === null || gas === null || subnetworkId === null || payloadCommitment === null || !inputs.every(present) || !outputs.every(present)) return null;
  return { version, inputs, outputs, lockTime, subnetworkId, gas, payloadCommitment };
}

/** Little-endian integers and raw bytes, in order. */
class Writer {
  private parts: Uint8Array[] = [];
  bytes(b: Uint8Array) { this.parts.push(b); return this; }
  private le(v: bigint, n: number) { const b = new Uint8Array(n); for (let i = 0; i < n; i++) b[i] = Number((v >> BigInt(8 * i)) & 0xffn); return this.bytes(b); }
  u8(v: number) { return this.le(BigInt(v), 1); }
  u16(v: number) { return this.le(BigInt(v), 2); }
  u32(v: number) { return this.le(BigInt(v), 4); }
  u64(v: bigint) { return this.le(v, 8); }
  out() { return concatBytes(...this.parts); }
}

const utf8 = (s: string) => new TextEncoder().encode(s);
/** A BLAKE3 key from a domain name: its bytes, padded with zeros to 32 (rusty-kaspa crypto/hashes blake3_hasher). */
const key32 = (domain: string) => { const k = new Uint8Array(32); k.set(utf8(domain)); return k; };
/** A payload's digest (hex), all of it a version 1 id commits to (rusty-kaspa hashing/tx.rs payload_digest). */
const payloadDigestOf = (payloadHex: string) => bytesToHex(blake3(hexToBytes(payloadHex), { key: key32('PayloadDigest') }));

/** The transaction's id, as consensus computes it. */
export function transactionIdOf(t: IdBody): string {
  const w = new Writer().u16(t.version).u64(BigInt(t.inputs.length));
  // An input: its outpoint, an empty signature script, its sequence.
  for (const i of t.inputs) w.bytes(hexToBytes(i.transactionId)).u32(i.index).u64(0n).u64(i.sequence);
  w.u64(BigInt(t.outputs.length));
  for (const o of t.outputs) {
    const spk = hexToBytes(o.scriptPublicKey);
    w.u64(o.value).u16((spk[0] << 8) | spk[1]).u64(BigInt(spk.length - 2)).bytes(spk.subarray(2));
    if (t.version >= 1) {
      w.u8(o.covenant ? 1 : 0);
      if (o.covenant) w.u16(o.covenant.authorizingInput).bytes(hexToBytes(o.covenant.covenantId));
    }
  }
  w.u64(t.lockTime).bytes(hexToBytes(t.subnetworkId)).u64(t.gas);
  const payload = hexToBytes(t.payloadCommitment);
  if (t.version === 0) return bytesToHex(blake2b(w.u64(BigInt(payload.length)).bytes(payload).out(), { dkLen: 32, key: utf8('TransactionID') }));
  // Version 1: the payload's digest, then the rest hashed with an empty payload in its place.
  const rest = blake3(w.u64(0n).out(), { key: key32('TransactionRest') });
  return bytesToHex(blake3(concatBytes(payload, rest), { key: key32('TransactionV1Id') }));
}
