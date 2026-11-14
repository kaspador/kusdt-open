// Kaspa addresses ⇄ KCC-2 owners (SPEC §4).

import { blake3 } from '@noble/hashes/blake3.js';
import { bytesToHex, decodeKaspaAddress, encodeKaspaAddress, hexToBytes } from '@kusdt/kaspa';

export const OWNER_P2PK_SCHNORR = 0x00;
export const OWNER_P2PKH_SCHNORR = 0x01;
export const OWNER_P2PKH_ECDSA = 0x02;
export const OWNER_P2SH = 0x03;
export const OWNER_COVENANT_ID = 0x04;

export interface Owner { ownerScheme: number; owner: string }

/** The KCC-2 owner a deposit names for a Kaspa address, or null if it isn't one. */
export function ownerOfAddress(address: string): Owner | null {
  const decoded = decodeKaspaAddress(address);
  if (!decoded) return null;
  if (decoded.version === 0 && decoded.payload.length === 32) return { ownerScheme: OWNER_P2PK_SCHNORR, owner: bytesToHex(decoded.payload) };
  if (decoded.version === 1 && decoded.payload.length === 33) return { ownerScheme: OWNER_P2PKH_ECDSA, owner: bytesToHex(blake3(decoded.payload)) };
  if (decoded.version === 8 && decoded.payload.length === 32) return { ownerScheme: OWNER_P2SH, owner: bytesToHex(decoded.payload) };
  return null;
}

/** The address of an owner when it has one (p2pk-schnorr and p2sh). */
export function addressOfOwner(owner: Owner, prefix: string): string | null {
  if (owner.ownerScheme === OWNER_P2PK_SCHNORR) return encodeKaspaAddress(prefix, 0, hexToBytes(owner.owner));
  if (owner.ownerScheme === OWNER_P2SH) return encodeKaspaAddress(prefix, 8, hexToBytes(owner.owner));
  return null;
}

/** The prefix an address carries ("kaspa", "kaspatest", …). */
export function prefixOf(address: string): string {
  return address.split(':')[0];
}
