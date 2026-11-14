// EIP-1559 (type 2) transactions for Ethereum and BNB Chain: RLP encoding and
// signing (from Pearl Wallet's eth/tx.ts).
//
// Small on purpose: only what the wallet sends (calls and plain transfers, no
// access lists). Checked byte for byte against viem in eth.test.ts.

import { secp256k1 } from '@noble/curves/secp256k1.js';
import { keccak_256 } from '@noble/hashes/sha3.js';
import { bytesToHex, hexToBytes } from '@kusdt/kaspa';

export interface Eip1559Tx {
  chainId:              number;
  nonce:                number;
  maxPriorityFeePerGas: bigint;
  maxFeePerGas:         bigint;
  gas:                  bigint;
  to:                   string;     // 0x… (a call or a transfer; never a contract deployment)
  value:                bigint;
  data:                 string;     // 0x… calldata, "0x" for none
}

type RlpItem = Uint8Array | RlpItem[];

const concat = (parts: Uint8Array[]): Uint8Array => {
  const out = new Uint8Array(parts.reduce((s, p) => s + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
};

/** Big-endian bytes of a non-negative integer, no leading zeros (0 → empty). */
export function intBytes(v: bigint | number): Uint8Array {
  let n = BigInt(v);
  if (n < 0n) throw new Error('Negative integer');
  const out: number[] = [];
  while (n > 0n) { out.unshift(Number(n & 0xffn)); n >>= 8n; }
  return Uint8Array.from(out);
}

function lengthPrefix(len: number, offset: number): Uint8Array {
  if (len < 56) return Uint8Array.of(offset + len);
  const l = intBytes(len);
  return concat([Uint8Array.of(offset + 55 + l.length), l]);
}

export function rlp(item: RlpItem): Uint8Array {
  if (item instanceof Uint8Array) {
    if (item.length === 1 && item[0] < 0x80) return item;
    return concat([lengthPrefix(item.length, 0x80), item]);
  }
  const body = concat(item.map(rlp));
  return concat([lengthPrefix(body.length, 0xc0), body]);
}

const hexData = (h: string): Uint8Array => {
  if (!/^0x([0-9a-fA-F]{2})*$/.test(h)) throw new Error('Invalid hex data');
  return hexToBytes(h.slice(2));
};

/** Chains the wallet signs for: those of its configured deployment, set by the caller. */
let signable: ReadonlySet<number> = new Set();
export function setSignableChains(ids: number[]): void { signable = new Set(ids); }
export const canSignFor = (chainId: number): boolean => signable.has(chainId);

function fields(tx: Eip1559Tx): RlpItem[] {
  if (!canSignFor(tx.chainId)) throw new Error(`The wallet signs only for the chains of its deployment, and chain ${tx.chainId} isn't one of them. Nothing was signed.`);
  if (!/^0x[0-9a-fA-F]{40}$/.test(tx.to)) throw new Error('Invalid recipient');
  return [
    intBytes(tx.chainId), intBytes(tx.nonce), intBytes(tx.maxPriorityFeePerGas), intBytes(tx.maxFeePerGas),
    intBytes(tx.gas), hexData(tx.to), intBytes(tx.value), hexData(tx.data), [],
  ];
}

/** The bytes that get signed: 0x02 ‖ rlp(fields). */
export function unsignedTx(tx: Eip1559Tx): Uint8Array {
  return concat([Uint8Array.of(2), rlp(fields(tx))]);
}

/** Sign: returns the raw transaction to broadcast (0x…) and its hash. */
export function signTx(tx: Eip1559Tx, priv: Uint8Array): { raw: string; hash: string } {
  if (tx.maxPriorityFeePerGas > tx.maxFeePerGas) throw new Error('Priority fee above the fee cap');
  const digest = keccak_256(unsignedTx(tx));
  // 'recovered' = [recovery bit, r(32), s(32)]; low-s by default, as Ethereum requires.
  const sig = secp256k1.sign(digest, priv, { prehash: false, format: 'recovered' });
  const yParity = sig[0], r = sig.slice(1, 33), s = sig.slice(33, 65);
  const strip = (b: Uint8Array) => { let i = 0; while (i < b.length && b[i] === 0) i++; return b.slice(i); };
  const raw = concat([Uint8Array.of(2), rlp([...fields(tx), intBytes(yParity), strip(r), strip(s)])]);
  return { raw: '0x' + bytesToHex(raw), hash: '0x' + bytesToHex(keccak_256(raw)) };
}
