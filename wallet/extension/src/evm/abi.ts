// Minimal Solidity ABI encoding (from Pearl Wallet's eth/abi.ts) for the calls
// the wallet makes: ERC-20 and KusdtVault. bytes32 added for the vault's owner.
//

import { keccak_256 } from '@noble/hashes/sha3.js';
import { bytesToHex, hexToBytes } from '@kusdt/kaspa';

export type AbiType = 'address' | 'uint' | 'bytes32' | 'bool' | 'bytes' | 'string' | 'bytes[]' | { tuple: AbiType[] };
export type AbiValue = string | bigint | number | boolean | Uint8Array | AbiValue[];

/** 4-byte selector of a canonical signature such as "transfer(address,uint256)". */
export const selector = (sig: string): string => '0x' + bytesToHex(keccak_256(new TextEncoder().encode(sig)).slice(0, 4));

const isDynamic = (t: AbiType): boolean =>
  t === 'bytes' || t === 'string' || t === 'bytes[]' || (typeof t === 'object' && t.tuple.some(isDynamic));

function word(n: bigint): Uint8Array {
  if (n < 0n || n >= 1n << 256n) throw new Error('Integer out of range');
  return hexToBytes(n.toString(16).padStart(64, '0'));
}

const concat = (parts: Uint8Array[]): Uint8Array => {
  const out = new Uint8Array(parts.reduce((s, p) => s + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
};

function padRight(b: Uint8Array): Uint8Array {
  const out = new Uint8Array(Math.ceil(b.length / 32) * 32);
  out.set(b);
  return out;
}

const toBytes = (v: AbiValue): Uint8Array => {
  if (v instanceof Uint8Array) return v;
  if (typeof v === 'string' && /^0x([0-9a-fA-F]{2})*$/.test(v)) return hexToBytes(v.slice(2));
  throw new Error('Expected bytes');
};

function encodeOne(t: AbiType, v: AbiValue): Uint8Array {
  if (t === 'address') {
    if (typeof v !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(v)) throw new Error('Expected an address');
    return word(BigInt(v));
  }
  if (t === 'uint') return word(BigInt(v as bigint | number));
  if (t === 'bytes32') {
    const b = toBytes(v);
    if (b.length !== 32) throw new Error('Expected 32 bytes');
    return b;
  }
  if (t === 'bool') return word(v ? 1n : 0n);
  if (t === 'bytes') { const b = toBytes(v); return concat([word(BigInt(b.length)), padRight(b)]); }
  if (t === 'string') { const b = new TextEncoder().encode(String(v)); return concat([word(BigInt(b.length)), padRight(b)]); }
  if (t === 'bytes[]') {
    const items = v as AbiValue[];
    return concat([word(BigInt(items.length)), encodeList(items.map(() => 'bytes' as AbiType), items)]);
  }
  return encodeList(t.tuple, v as AbiValue[]);
}

/** Head/tail encoding of a list of values (function arguments, a tuple, an array's items). */
function encodeList(types: AbiType[], values: AbiValue[]): Uint8Array {
  if (types.length !== values.length) throw new Error('Argument count mismatch');
  const heads: Uint8Array[] = [], tails: Uint8Array[] = [];
  let offset = types.length * 32;
  types.forEach((t, i) => {
    const enc = encodeOne(t, values[i]);
    if (isDynamic(t)) { heads.push(word(BigInt(offset))); tails.push(enc); offset += enc.length; }
    else heads.push(enc);
  });
  return concat([...heads, ...tails]);
}

/** Calldata: selector of `sig` followed by the encoded arguments, as 0x… hex. */
export function encodeCall(sig: string, types: AbiType[], values: AbiValue[]): string {
  return selector(sig) + bytesToHex(encodeList(types, values));
}

/** The n-th 32-byte word of returned data as an unsigned integer. */
export function wordAt(ret: string, n = 0): bigint {
  const h = ret.startsWith('0x') ? ret.slice(2) : ret;
  const w = h.slice(n * 64, n * 64 + 64);
  if (w.length !== 64) throw new Error('Short return data');
  return BigInt('0x' + w);
}
