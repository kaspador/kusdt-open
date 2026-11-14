// Kaspa addresses: "<prefix>:<payload>", a CashAddr-style bech32 with a 40-bit
// checksum over the prefix, a version byte and the payload. Ported from
// rusty-kaspa crypto/addresses (bech32.rs, lib.rs) and checked against the
// official SDK in kaspa.test.ts.
//
// Versions (payload length):
//   0 PubKey       32-byte Schnorr x-only key   kaspa:q…   (what every wallet hands out)
//   1 PubKeyECDSA  33-byte compressed ECDSA key kaspa:q…   (rare)
//   8 ScriptHash   32-byte script hash          kaspa:p…   (multisig, exchanges)
// The wallet's own addresses are always version 0; it can SEND to all three.

import { secp256k1 } from '@noble/curves/secp256k1.js';

export type KaspaAddressVersion = 0 | 1 | 8;

export interface DecodedKaspaAddress {
  prefix:  string;
  version: KaspaAddressVersion;
  payload: Uint8Array;
}

const CHARSET = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';
const PAYLOAD_LEN: Record<KaspaAddressVersion, number> = { 0: 32, 1: 33, 8: 32 };
const PREFIXES = new Set(['kaspa', 'kaspatest', 'kaspasim', 'kaspadev']);

// 40-bit BCH checksum. JS bitwise operators are 32-bit, so this runs on BigInt.
const GEN = [0x98f2bc8e61n, 0x79b76d99e2n, 0xf33e5fb3c4n, 0xae2eabe2a8n, 0x1e4f43e470n];
function polymod(values: number[]): bigint {
  let c = 1n;
  for (const d of values) {
    const c0 = c >> 35n;
    c = ((c & 0x07ffffffffn) << 5n) ^ BigInt(d);
    for (let i = 0; i < 5; i++) if ((c0 >> BigInt(i)) & 1n) c ^= GEN[i];
  }
  return c ^ 1n;
}

function checksum(prefix: string, data5: number[]): bigint {
  const pre = Array.from(prefix, ch => ch.charCodeAt(0) & 0x1f);
  return polymod([...pre, 0, ...data5, 0, 0, 0, 0, 0, 0, 0, 0]);
}

// 8-bit → 5-bit with right zero padding, and back ignoring the padding (as in bech32.rs).
function conv8to5(bytes: Uint8Array): number[] {
  const out: number[] = [];
  let buff = 0, bits = 0;
  for (const b of bytes) {
    buff = (buff << 8) | b; bits += 8;
    while (bits >= 5) { bits -= 5; out.push((buff >> bits) & 31); buff &= (1 << bits) - 1; }
  }
  if (bits > 0) out.push((buff << (5 - bits)) & 31);
  return out;
}
function conv5to8(data: number[]): Uint8Array {
  const out: number[] = [];
  let buff = 0, bits = 0;
  for (const d of data) {
    buff = (buff << 5) | d; bits += 5;
    while (bits >= 8) { bits -= 8; out.push((buff >> bits) & 0xff); buff &= (1 << bits) - 1; }
  }
  return Uint8Array.from(out);
}

export function encodeKaspaAddress(prefix: string, version: KaspaAddressVersion, payload: Uint8Array): string {
  if (payload.length !== PAYLOAD_LEN[version]) throw new Error('Wrong payload length for this address version.');
  const data5 = conv8to5(Uint8Array.from([version, ...payload]));
  const sum = checksum(prefix, data5);
  const sumBytes = new Uint8Array(5);
  for (let i = 0; i < 5; i++) sumBytes[i] = Number((sum >> BigInt(8 * (4 - i))) & 0xffn);
  return `${prefix}:${[...data5, ...conv8to5(sumBytes)].map(d => CHARSET[d]).join('')}`;
}

/**
 * Strict decode. Rejects: no or unknown prefix, uppercase or mixed case,
 * characters outside the charset, a bad checksum, an unknown version, or a
 * payload of the wrong length. Returns null instead of throwing.
 */
export function decodeKaspaAddress(address: string): DecodedKaspaAddress | null {
  if (typeof address !== 'string' || address !== address.toLowerCase()) return null;
  const sep = address.indexOf(':');
  if (sep <= 0 || address.indexOf(':', sep + 1) !== -1) return null;
  const prefix = address.slice(0, sep);
  const body   = address.slice(sep + 1);
  if (!PREFIXES.has(prefix) || body.length < 9) return null;

  const data: number[] = [];
  for (const ch of body) {
    const v = CHARSET.indexOf(ch);
    if (v < 0) return null;
    data.push(v);
  }
  const payload5 = data.slice(0, -8);
  const sum5     = data.slice(-8);
  const sumBytes = conv5to8(sum5);
  let sum = 0n;
  for (const b of sumBytes) sum = (sum << 8n) | BigInt(b);
  if (checksum(prefix, payload5) !== sum) return null;

  const bytes = conv5to8(payload5);
  const version = bytes[0] as KaspaAddressVersion;
  if (!(version in PAYLOAD_LEN)) return null;
  const payload = bytes.slice(1);
  if (payload.length !== PAYLOAD_LEN[version]) return null;
  return { prefix, version, payload };
}

/** True only for a well-formed address on the given network (e.g. 'kaspa'). */
export function isValidKaspaAddress(address: string, prefix: string): boolean {
  const d = decodeKaspaAddress(address);
  return !!d && d.prefix === prefix;
}

/**
 * Whether the key a decoded address holds is a point on secp256k1, so that
 * what is paid there can ever be spent: a version-0 payload is an x-only key
 * (valid exactly when 02 ‖ x is a compressed one), a version-1 payload a
 * compressed key. The checksum stops typos, not an address made up to hold no
 * key, and the node and the covenants take payments to one all the same. A
 * script hash (version 8) has no point to check. Every form that takes a
 * recipient's address asks this after decoding it.
 */
export function addressKeyIsOnCurve(d: DecodedKaspaAddress): boolean {
  if (d.version === 8) return true;
  return secp256k1.utils.isValidPublicKey(d.version === 0 ? Uint8Array.from([0x02, ...d.payload]) : d.payload, true);
}

// ── Locking scripts ─────────────────────────────────────────────────────────
// What an output to each address type must contain (script version 0):
//   PubKey       OP_DATA_32 <key> OP_CHECKSIG          20 <32> ac
//   PubKeyECDSA  OP_DATA_33 <key> OP_CHECKSIGECDSA     21 <33> ab
//   ScriptHash   OP_BLAKE2B OP_DATA_32 <hash> OP_EQUAL aa 20 <32> 87

export interface ScriptPublicKey { version: number; script: Uint8Array }

export function scriptForAddress(address: string, prefix: string): ScriptPublicKey {
  const d = decodeKaspaAddress(address);
  if (!d) throw new Error('Invalid Kaspa address.');
  if (d.prefix !== prefix) throw new Error(`That is a ${d.prefix}: address, not ${prefix}:.`);
  switch (d.version) {
    case 0: return { version: 0, script: Uint8Array.from([0x20, ...d.payload, 0xac]) };
    case 1: return { version: 0, script: Uint8Array.from([0x21, ...d.payload, 0xab]) };
    case 8: return { version: 0, script: Uint8Array.from([0xaa, 0x20, ...d.payload, 0x87]) };
  }
}

/** The address a standard locking script pays to, or null for anything else. */
export function addressForScript(spk: ScriptPublicKey, prefix: string): string | null {
  const s = spk.script;
  if (spk.version !== 0) return null;
  if (s.length === 34 && s[0] === 0x20 && s[33] === 0xac) return encodeKaspaAddress(prefix, 0, s.slice(1, 33));
  if (s.length === 35 && s[0] === 0x21 && s[34] === 0xab) return encodeKaspaAddress(prefix, 1, s.slice(1, 34));
  if (s.length === 35 && s[0] === 0xaa && s[1] === 0x20 && s[34] === 0x87) return encodeKaspaAddress(prefix, 8, s.slice(2, 34));
  return null;
}
