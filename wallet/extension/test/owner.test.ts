import { describe, expect, it } from 'vitest';
import { schnorr } from '@noble/curves/secp256k1.js';
import { blake3 } from '@noble/hashes/blake3.js';
import { bytesToHex, encodeKaspaAddress, hexToBytes, KASPA_NETWORKS } from '@kusdt/kaspa';
import { addressOfOwner, ownerOfAddress, OWNER_P2PK_SCHNORR, OWNER_P2PKH_ECDSA, OWNER_P2SH } from '@/kusdt/owner';
import { burnOwner, burnOwnerLocal, burnScript, redeemPayload, evmHex } from '@/kusdt/tokens';
import { core, devKey } from './helpers';

const P = KASPA_NETWORKS['testnet-10'].prefix;

describe('Kaspa addresses → KCC-2 owners (SPEC §4)', () => {
  it('Schnorr P2PK: scheme 0x00, the x-only key, and back', () => {
    // A real key's x: one off the curve names no key, and is refused (run 21 round 2, R21-CRYPTO-5).
    const k = bytesToHex(schnorr.getPublicKey(new Uint8Array(32).fill(0x11)));
    const a = encodeKaspaAddress(P, 0, hexToBytes(k));
    expect(ownerOfAddress(a, P)).toEqual({ ownerScheme: OWNER_P2PK_SCHNORR, owner: k });
    expect(addressOfOwner({ ownerScheme: 0, owner: k }, P)).toBe(a);
  });

  it('ECDSA P2PK: scheme 0x02, BLAKE3 of the compressed key; no address back', () => {
    const key = Uint8Array.from([0x02, ...new Uint8Array(32).fill(0x22)]);
    const o = ownerOfAddress(encodeKaspaAddress(P, 1, key), P);
    expect(o).toEqual({ ownerScheme: OWNER_P2PKH_ECDSA, owner: bytesToHex(blake3(key)) });
    expect(addressOfOwner(o, P)).toBeNull();
  });

  it('P2SH: scheme 0x03, the script hash', () => {
    const h = '33'.repeat(32);
    const a = encodeKaspaAddress(P, 8, hexToBytes(h));
    expect(ownerOfAddress(a, P)).toEqual({ ownerScheme: OWNER_P2SH, owner: h });
    expect(addressOfOwner({ ownerScheme: 3, owner: h }, P)).toBe(a);
  });

  it("refuses another network's address and garbage", () => {
    const a = encodeKaspaAddress('kaspa', 0, hexToBytes('11'.repeat(32)));
    expect(() => ownerOfAddress(a, P)).toThrow(/kaspa:/);
    expect(() => ownerOfAddress('kaspatest:qqqq', P)).toThrow();
    expect(() => ownerOfAddress(a.slice(0, -1) + (a.endsWith('q') ? 'p' : 'q'), 'kaspa')).toThrow();
  });

  it("the wallet's own key gives the owner a deposit names", () => {
    const k = devKey('alice');
    expect(ownerOfAddress(k.address, 'kaspasim')).toEqual({ ownerScheme: 0, owner: k.xonly });
  });
});

describe('burn owners and the redemption payload (SPEC §9)', () => {
  const addr = '0x' + 'ab'.repeat(20);

  it('R(chain, address) is OP_RETURN-led and 40 bytes', () => {
    const r = burnScript(1, evmHex(addr));
    expect(r.length).toBe(40);
    expect(r[0]).toBe(0x6a);
    expect(new TextDecoder().decode(r.slice(2, 17))).toBe('kUSDT/redeem/v1');
    expect(Array.from(r.slice(17, 20))).toEqual([0x01, 0x01, 0x14]);
  });

  it("the local burn owner equals the core's, and differs by chain and address", () => {
    for (const chain of [1, 2] as const) {
      const fromCore = core.call('burn-owner', { chain, address: evmHex(addr) }).value;
      expect(fromCore.owner).toBe(burnOwnerLocal(chain, evmHex(addr)));
      expect(burnOwner({ core }, chain, addr)).toEqual({ ownerScheme: 3, owner: fromCore.owner });
    }
    expect(burnOwnerLocal(1, evmHex(addr))).not.toBe(burnOwnerLocal(2, evmHex(addr)));
    expect(burnOwnerLocal(1, evmHex(addr))).not.toBe(burnOwnerLocal(1, 'ac'.repeat(20)));
  });

  it('refuses the zero address and malformed addresses', () => {
    expect(() => burnOwner({ core }, 1, '0x' + '00'.repeat(20))).toThrow(/zero/);
    expect(() => burnOwner({ core }, 1, '0x1234')).toThrow();
  });

  it('the payload is "KUSDT" ‖ 01 ‖ count ‖ (index ‖ chain ‖ address)', () => {
    const p = redeemPayload([{ outputIndex: 0, chain: 2, address: 'ab'.repeat(20) }]);
    expect(p).toBe(bytesToHex(new TextEncoder().encode('KUSDT')) + '01' + '01' + '00' + '02' + 'ab'.repeat(20));
  });
});
