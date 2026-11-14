// Kaspa transactions (version 0): the signature hash, signing, transaction id,
// mass and the JSON the REST API accepts. Ported from rusty-kaspa
// consensus/core (hashing/sighash.rs, hashing/tx.rs, mass/mod.rs) and checked
// against the official SDK in kaspa.test.ts. All integers are little-endian.

import { blake2b } from '@noble/hashes/blake2.js';
import { randomBytes } from '@noble/hashes/utils.js';
import { schnorr } from '@noble/curves/secp256k1.js';
import { bytesToHex, hexToBytes } from './bytes';
import type { ScriptPublicKey } from './address';

export const TX_VERSION       = 0;
export const SIGHASH_ALL      = 0x01;
export const NATIVE_SUBNET    = new Uint8Array(20);
const SIG_SCRIPT_LEN          = 66;   // OP_DATA_65 <64-byte Schnorr sig> <sighash type>

// Mass rules (consensus params, identical on mainnet and testnet-10).
export const MASS_PER_TX_BYTE        = 1n;
export const MASS_PER_SPK_BYTE       = 10n;
export const MASS_PER_SIGOP          = 1000n;
export const TRANSIENT_BYTE_TO_MASS  = 4n;
export const STORAGE_MASS_PARAMETER  = 10n ** 12n;     // SOMPI_PER_KASPA * 10_000
export const MAX_STANDARD_MASS       = 100_000n;       // largest transaction nodes relay

export interface KaspaUtxo {
  txid:          string;       // 64 hex chars, in the byte order the API and explorers show
  index:         number;
  amount:        bigint;       // sompi
  script:        ScriptPublicKey;
  blockDaaScore: bigint;
  isCoinbase:    boolean;
  address:       string;
}

export interface KaspaTxInput {
  txid:            string;
  index:           number;
  sequence:        bigint;
  sigOpCount:      number;
  signatureScript: Uint8Array;
  utxo:            { amount: bigint; script: ScriptPublicKey };   // what the input spends (signed over)
}

export interface KaspaTxOutput { amount: bigint; script: ScriptPublicKey }

export interface KaspaTx {
  version:      number;
  inputs:       KaspaTxInput[];
  outputs:      KaspaTxOutput[];
  lockTime:     bigint;
  subnetworkId: Uint8Array;   // 20 bytes
  gas:          bigint;
  payload:      Uint8Array;
}

// ── Byte writer + domain-keyed BLAKE2b ──────────────────────────────────────
class W {
  private buf: number[] = [];
  bytes(b: Uint8Array) { for (const x of b) this.buf.push(x); return this; }
  u8(v: number)  { this.buf.push(v & 0xff); return this; }
  u16(v: number) { return this.u8(v).u8(v >>> 8); }
  u32(v: number) { for (let i = 0; i < 4; i++) this.u8(v >>> (8 * i)); return this; }
  u64(v: bigint) {
    if (v < 0n || v > 0xffffffffffffffffn) throw new Error('u64 out of range');
    for (let i = 0n; i < 8n; i++) this.u8(Number((v >> (8n * i)) & 0xffn));
    return this;
  }
  varBytes(b: Uint8Array) { return this.u64(BigInt(b.length)).bytes(b); }
  spk(s: ScriptPublicKey) { return this.u16(s.version).varBytes(s.script); }
  out() { return Uint8Array.from(this.buf); }
}

const enc = new TextEncoder();
const KEY_SIGNING = enc.encode('TransactionSigningHash');
const KEY_TXID    = enc.encode('TransactionID');
const hashWith = (key: Uint8Array, data: Uint8Array) => blake2b(data, { dkLen: 32, key });
const ZERO_HASH = new Uint8Array(32);

function txidBytes(txid: string): Uint8Array {
  if (!/^[0-9a-f]{64}$/.test(txid)) throw new Error('Bad transaction id.');
  return hexToBytes(txid);
}

// ── Signature hash (SIGHASH_ALL, Schnorr) ──────────────────────────────────
export function signatureHash(tx: KaspaTx, inputIndex: number): Uint8Array {
  if (tx.version !== TX_VERSION) throw new Error('Only version 0 transactions are supported.');
  const input = tx.inputs[inputIndex];
  if (!input) throw new Error('No such input.');

  const prevOuts = new W(); const seqs = new W(); const sigops = new W(); const outs = new W();
  for (const i of tx.inputs) { prevOuts.bytes(txidBytes(i.txid)).u32(i.index); seqs.u64(i.sequence); sigops.u8(i.sigOpCount); }
  for (const o of tx.outputs) outs.u64(o.amount).spk(o.script);
  const payloadHash = isNative(tx.subnetworkId) && tx.payload.length === 0
    ? ZERO_HASH
    : hashWith(KEY_SIGNING, new W().varBytes(tx.payload).out());

  const w = new W()
    .u16(tx.version)
    .bytes(hashWith(KEY_SIGNING, prevOuts.out()))
    .bytes(hashWith(KEY_SIGNING, seqs.out()))
    .bytes(hashWith(KEY_SIGNING, sigops.out()))
    .bytes(txidBytes(input.txid)).u32(input.index)
    .spk(input.utxo.script)
    .u64(input.utxo.amount)
    .u64(input.sequence)
    .u8(input.sigOpCount)
    .bytes(hashWith(KEY_SIGNING, outs.out()))
    .u64(tx.lockTime)
    .bytes(tx.subnetworkId)
    .u64(tx.gas)
    .bytes(payloadHash)
    .u8(SIGHASH_ALL);
  return hashWith(KEY_SIGNING, w.out());
}

function isNative(subnet: Uint8Array): boolean {
  return subnet.length === 20 && subnet.every(b => b === 0);
}

/** The pay-to-public-key script a 32-byte x-only key is spent from. */
export function p2pkScript(xonly: Uint8Array): ScriptPublicKey {
  if (xonly.length !== 32) throw new Error('Expected a 32-byte x-only key.');
  return { version: 0, script: Uint8Array.from([0x20, ...xonly, 0xac]) };
}

const sameScript = (a: ScriptPublicKey, b: ScriptPublicKey) =>
  a.version === b.version && a.script.length === b.script.length && a.script.every((x, i) => x === b.script[i]);

/**
 * Sign one input in place. Refuses unless the coin being spent is locked to
 * exactly this key, and checks the signature before keeping it.
 */
export function signInput(tx: KaspaTx, inputIndex: number, priv: Uint8Array): void {
  const xonly = schnorr.getPublicKey(priv);
  const input = tx.inputs[inputIndex];
  if (!sameScript(input.utxo.script, p2pkScript(xonly))) throw new Error('Refusing to sign: that coin is not locked to this key.');
  const hash = signatureHash(tx, inputIndex);
  const sig  = schnorr.sign(hash, priv, randomBytes(32));
  if (!schnorr.verify(sig, hash, xonly)) throw new Error('Signature check failed.');
  input.signatureScript = Uint8Array.from([0x41, ...sig, SIGHASH_ALL]);
}

/** Transaction id (version 0): the transaction without signature scripts, BLAKE2b keyed "TransactionID". */
export function transactionId(tx: KaspaTx): string {
  const w = new W().u16(tx.version).u64(BigInt(tx.inputs.length));
  for (const i of tx.inputs) w.bytes(txidBytes(i.txid)).u32(i.index).varBytes(new Uint8Array(0)).u64(i.sequence);
  w.u64(BigInt(tx.outputs.length));
  for (const o of tx.outputs) w.u64(o.amount).spk(o.script);
  w.u64(tx.lockTime).bytes(tx.subnetworkId).u64(tx.gas).varBytes(tx.payload);
  return bytesToHex(hashWith(KEY_TXID, w.out()));
}

// ── Mass ────────────────────────────────────────────────────────────────────
// Sizes are the consensus "estimated serialized size". An unsigned input is
// counted with the 66-byte signature it will carry, so the mass of a planned
// transaction equals the mass of the signed one.

export function estimatedSize(tx: KaspaTx): bigint {
  let size = 2n + 8n + 8n + 8n + 20n + 8n + 32n + 8n + BigInt(tx.payload.length);
  for (const i of tx.inputs) size += 32n + 4n + 8n + BigInt(i.signatureScript.length || SIG_SCRIPT_LEN) + 8n;
  for (const o of tx.outputs) size += 8n + 2n + 8n + BigInt(o.script.script.length);
  return size;
}

export function computeMass(tx: KaspaTx): bigint {
  const spkBytes = tx.outputs.reduce((s, o) => s + 2n + BigInt(o.script.script.length), 0n);
  const sigops   = tx.inputs.reduce((s, i) => s + BigInt(i.sigOpCount), 0n);
  return estimatedSize(tx) * MASS_PER_TX_BYTE + spkBytes * MASS_PER_SPK_BYTE + sigops * MASS_PER_SIGOP;
}

/** Transient mass scaled to compute units (block limits 1,000,000 vs 500,000 → ×0.5). */
export function normalizedTransientMass(tx: KaspaTx): bigint {
  const t = estimatedSize(tx) * TRANSIENT_BYTE_TO_MASS;
  return (t + 1n) / 2n;
}

// How many 100-byte storage units a UTXO with this script occupies (1 for every standard script).
const plurality = (scriptLen: number) => BigInt(Math.ceil((63 + scriptLen) / 100));

/**
 * KIP-9 storage mass: C·(Σ p²/out − Σ p²/in) on the relaxed path (one output,
 * one input, or two of each), C·(Σ p²/out − |I|/mean(in)) otherwise. Integer
 * division per term, exactly as consensus does it. Null when incomputable
 * (a zero amount), which callers treat as invalid.
 */
export function storageMass(ins: { amount: bigint; scriptLen: number }[], outs: { amount: bigint; scriptLen: number }[]): bigint | null {
  if (ins.length === 0 || ins.some(i => i.amount <= 0n) || outs.some(o => o.amount <= 0n)) return null;
  const C = STORAGE_MASS_PARAMETER;
  let outsPlurality = 0n, harmonicOuts = 0n;
  for (const o of outs) { const p = plurality(o.scriptLen); outsPlurality += p; harmonicOuts += C * p * p / o.amount; }

  let relaxed = outsPlurality === 1n;
  if (!relaxed && ins.length <= 2) {
    const insPlurality = ins.reduce((s, i) => s + plurality(i.scriptLen), 0n);
    relaxed = insPlurality === 1n || (outsPlurality === 2n && insPlurality === 2n);
  }
  if (relaxed) {
    const harmonicIns = ins.reduce((s, i) => { const p = plurality(i.scriptLen); return s + C * p * p / i.amount; }, 0n);
    return harmonicOuts > harmonicIns ? harmonicOuts - harmonicIns : 0n;
  }
  const insPlurality = ins.reduce((s, i) => s + plurality(i.scriptLen), 0n);
  const sumIns = ins.reduce((s, i) => s + i.amount, 0n);
  let mean = sumIns / insPlurality; if (mean < 1n) mean = 1n;
  const arithmeticIns = insPlurality * (C / mean);
  return harmonicOuts > arithmeticIns ? harmonicOuts - arithmeticIns : 0n;
}

export interface TxMass { compute: bigint; transient: bigint; storage: bigint | null; feeMass: bigint }

/**
 * All mass dimensions, plus the mass the fee is priced on: the largest of
 * them. Pricing all of it at the fee rate matches what Kaspa's own wallet
 * SDK pays, and is always at least the node's relay minimum.
 */
export function transactionMass(tx: KaspaTx): TxMass {
  const compute   = computeMass(tx);
  const transient = normalizedTransientMass(tx);
  const storage   = storageMass(
    tx.inputs.map(i => ({ amount: i.utxo.amount, scriptLen: i.utxo.script.script.length })),
    tx.outputs.map(o => ({ amount: o.amount, scriptLen: o.script.script.length })),
  );
  let feeMass = compute > transient ? compute : transient;
  if (storage != null && storage > feeMass) feeMass = storage;
  return { compute, transient, storage, feeMass };
}

// ── Node (wRPC JSON) form ───────────────────────────────────────────────────
// The shape Kaspa's SDK sends to submitTransaction, field for field (captured
// from its RpcClient). Script keys are the version (u16 big-endian) and the
// script, in hex. Integers are written exactly.

export function toRpcTransactionJson(tx: KaspaTx): string {
  const spkHex = (s: ScriptPublicKey) => s.version.toString(16).padStart(4, '0') + bytesToHex(s.script);
  const inputs = tx.inputs.map(i => {
    if (i.signatureScript.length === 0) throw new Error('Input is not signed.');
    return `{"previousOutpoint":{"transactionId":"${i.txid}","index":${i.index}},"signatureScript":"${bytesToHex(i.signatureScript)}",` +
      `"sequence":${i.sequence},"sigOpCount":${i.sigOpCount},"computeBudget":0,"verboseData":null}`;
  });
  const outputs = tx.outputs.map(o =>
    `{"value":${o.amount},"scriptPublicKey":"${spkHex(o.script)}","verboseData":null,"covenant":null}`);
  return `{"version":${tx.version},"inputs":[${inputs.join(',')}],"outputs":[${outputs.join(',')}],"lockTime":${tx.lockTime},` +
    `"subnetworkId":"${bytesToHex(tx.subnetworkId)}","gas":${tx.gas},"payload":"${bytesToHex(tx.payload)}","mass":0,"storageMass":0,"verboseData":null}`;
}

// ── REST API form ───────────────────────────────────────────────────────────
// Amounts are written as exact integers (JSON.stringify of a Number would round
// anything above 2^53 sompi).

export function toSubmitJson(tx: KaspaTx): string {
  const inputs = tx.inputs.map(i => {
    if (i.signatureScript.length === 0) throw new Error('Input is not signed.');
    return `{"previousOutpoint":{"transactionId":"${i.txid}","index":${i.index}},"signatureScript":"${bytesToHex(i.signatureScript)}","sequence":${i.sequence},"sigOpCount":${i.sigOpCount}}`;
  });
  const outputs = tx.outputs.map(o =>
    `{"amount":${o.amount},"scriptPublicKey":{"version":${o.script.version},"scriptPublicKey":"${bytesToHex(o.script.script)}"}}`);
  return `{"transaction":{"version":${tx.version},"inputs":[${inputs.join(',')}],"outputs":[${outputs.join(',')}],` +
    `"lockTime":${tx.lockTime},"subnetworkId":"${bytesToHex(tx.subnetworkId)}","gas":${tx.gas},"payload":"${bytesToHex(tx.payload)}"},"allowOrphan":false}`;
}
