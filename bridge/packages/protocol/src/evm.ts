// The EVM side of the protocol (SPEC §7): ids, EIP-712 messages, units.

import { keccak_256 } from '@noble/hashes/sha3.js';
import { bytesToHex, concatBytes, hexToBytes } from '@kusdt/kaspa';

export const CHAIN_ETHEREUM = 1;
export const CHAIN_BSC = 2;

/**
 * Token blocklists the bridge honours (SPEC §9), by the view each token answers.
 * USDT's blacklist stops only senders, so the vault would still pay a blocked
 * address (where the USDT is frozen); the signers refuse to sign it instead.
 */
export const BLOCKLISTS = {
  isBlackListed: 'function isBlackListed(address) view returns (bool)',
} as const;
export type Blocklist = keyof typeof BLOCKLISTS;

/** `keccak256(abi.encodePacked("kusdt/redeem/v1", bytes32 kaspaTxId, uint32 outputIndex))`. */
export function redeemId(kaspaTxId: string, outputIndex: number): string {
  const index = new Uint8Array(4);
  new DataView(index.buffer).setUint32(0, outputIndex, false);
  return '0x' + bytesToHex(keccak_256(concatBytes(new TextEncoder().encode('kusdt/redeem/v1'), hexToBytes(kaspaTxId), index)));
}

export function domain(chainId: number, vault: string) {
  return { name: 'kUSDT Vault', version: '1', chainId, verifyingContract: vault };
}

export const RELEASE_TYPES = {
  Release: [
    { name: 'redeemId', type: 'bytes32' },
    { name: 'recipient', type: 'address' },
    { name: 'units', type: 'uint256' },
  ],
};

export const REFUND_TYPES = {
  Refund: [
    { name: 'nonce', type: 'uint64' },
    { name: 'recipient', type: 'address' },
    { name: 'units', type: 'uint256' },
  ],
};

/** `fee = max(minFee, ceil(units × feeBps / 10⁴))` (SPEC §7). */
export function feeOf(units: bigint, feeBps: bigint, minFee: bigint): bigint {
  const prop = (units * feeBps + 9_999n) / 10_000n;
  return prop > minFee ? prop : minFee;
}

/** Token amount (smallest unit) of `units` base units for a token with `decimals`. */
export function tokenAmount(units: bigint, decimals: number): bigint {
  return units * 10n ** BigInt(decimals - 6);
}

/** Lowercase 0x-less 20-byte hex of an EVM address, after a format check. */
export function evmAddressHex(address: string): string {
  if (!/^0x[0-9a-fA-F]{40}$/.test(address)) throw new Error(`not an EVM address: ${address}`);
  return address.slice(2).toLowerCase();
}
