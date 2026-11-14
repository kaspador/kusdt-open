// Kaspa addresses ⇄ KCC-2 owners (SPEC §4), and the token states the wallet
// creates.
//
//   kaspa:q… Schnorr (32-byte key)   0x00 p2pk-schnorr  the x-only key
//   kaspa:q… ECDSA (33-byte key)     0x02 p2pkh-ecdsa   BLAKE3(compressed key)
//   kaspa:p… P2SH                     0x03 p2sh          the script hash
//
// Only 0x00 owners can be spent by this wallet (the core signs Schnorr owners).

import { blake3 } from '@noble/hashes/blake3.js';
import { addressKeyIsOnCurve, bytesToHex, decodeKaspaAddress, encodeKaspaAddress, hexToBytes } from '@kusdt/kaspa';
import { ZERO32, isHex32 } from '../lib/bigint';

export const OWNER_P2PK_SCHNORR = 0x00;
export const OWNER_P2PKH_SCHNORR = 0x01;
export const OWNER_P2PKH_ECDSA = 0x02;
export const OWNER_P2SH = 0x03;
export const OWNER_COVENANT_ID = 0x04;

export interface Owner { ownerScheme: number; owner: string }

/**
 * The KCC-2 owner a Kaspa address stands for, on the network with `prefix`. Throws on anything else, and on a key
 * address whose bytes are no key (run 21 round 2, R21-CRYPTO-5): a Schnorr address's 32 bytes must be the x of a point
 * of the curve, an ECDSA address's 33 bytes a compressed point. Such an address decodes and its checksum holds, but
 * nothing could ever spend what is sent to it: it is made on purpose, never by a typo.
 */
export function ownerOfAddress(address: string, prefix: string): Owner {
  const d = decodeKaspaAddress(address.trim());
  if (!d) throw new Error('That is not a valid Kaspa address.');
  if (d.prefix !== prefix) throw new Error(`That is a ${d.prefix}: address; this network uses ${prefix}:.`);
  if (!addressKeyIsOnCurve(d)) {
    throw new Error('That address names no key that could ever sign: anything sent to it could never be moved again. Check it, or use the address the recipient\'s wallet shows.');
  }
  switch (d.version) {
    case 0: return { ownerScheme: OWNER_P2PK_SCHNORR, owner: bytesToHex(d.payload) };
    case 1: return { ownerScheme: OWNER_P2PKH_ECDSA, owner: bytesToHex(blake3(d.payload)) };
    case 8: return { ownerScheme: OWNER_P2SH, owner: bytesToHex(d.payload) };
  }
}

/** The address an owner can be written as, or null (hashed keys and covenants have none). */
export function addressOfOwner(o: Owner, prefix: string): string | null {
  if (!isHex32(o.owner)) return null;
  if (o.ownerScheme === OWNER_P2PK_SCHNORR) return encodeKaspaAddress(prefix, 0, hexToBytes(o.owner));
  if (o.ownerScheme === OWNER_P2SH) return encodeKaspaAddress(prefix, 8, hexToBytes(o.owner));
  return null;
}

/** A KCC-20 state as the core takes it (SPEC §5: borrow disabled, extension 0³²). */
export interface TokenState {
  amount: bigint;
  owner: string;
  ownerScheme: number;
  borrowScheme: number;
  borrowGuard: string;
  extensionCommitment: string;
}

export const plainState = (o: Owner, amount: bigint): TokenState => ({
  amount, owner: o.owner, ownerScheme: o.ownerScheme, borrowScheme: 0, borrowGuard: ZERO32, extensionCommitment: ZERO32,
});

/**
 * The wallet's own spendable state shape: p2pk-schnorr, its key, nothing borrowed. An empty one (amount 0, a pool
 * deposit's change when it used a whole state) counts too: it holds KAS the wallet frees (sweepEmptyStates).
 */
export const isPlainStateOf = (s: TokenState, ownerHex: string): boolean =>
  s.ownerScheme === OWNER_P2PK_SCHNORR && s.owner === ownerHex && s.borrowScheme === 0 &&
  s.borrowGuard === ZERO32 && s.extensionCommitment === ZERO32 && s.amount >= 0n;

/** What to say about sending kUSDT to this owner, when it may not simply be able to spend it. */
export function ownerWarningOf(o: Owner): string | null {
  if (o.ownerScheme === OWNER_P2SH) return 'This is a script address. Only send kUSDT to it if you know its owner can spend KCC-20 tokens; otherwise they are lost.';
  if (o.ownerScheme === OWNER_P2PKH_ECDSA) return 'This is an ECDSA address. Its owner needs a wallet that spends KCC-20 tokens with ECDSA keys.';
  return null;
}

/**
 * The same for a send a site asked for (the approval window). The site chose the address, and a script address
 * can't be told from a redemption to someone else's EVM address, so that case has its own words. Every other owner
 * gets the Send screen's warning: a send is never approved with less said than when the user types the address
 * themselves (round 12, R12-WW-6).
 */
export function siteSendWarningOf(o: Owner): string | null {
  if (o.ownerScheme === OWNER_P2SH) return 'This is a script address, not a wallet. Only that script can spend what you send, and if it is a redemption address the USDT goes to someone else\'s EVM address. Send only if you trust this site.';
  return ownerWarningOf(o);
}
