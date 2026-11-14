// Run 21 round 2, R21-CRYPTO-5 (the wallet's part), from reviewer "crypto2": a Kaspa address whose payload is no key
// decodes and was taken as a recipient. A Schnorr address (version 0) carries a key's x: an x that is not on the curve
// (x = 5) names no key at all; an ECDSA address (version 1) carries a compressed key: 33 bytes that are not one (a first
// byte of 04) name none either. Both decoded, gave owners and payment scripts, and anything sent there can never move
// (the node refuses such a key at spend time: "malformed public key"). The checksum stops typos only, so such an
// address is made on purpose. Now the wallet refuses it where a recipient is typed or a site names one: ownerOfAddress,
// which the Send screen and a site's kusdt_send go through.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { blake3 } from '@noble/hashes/blake3.js';
import { bytesToHex, encodeKaspaAddress } from '@kusdt/kaspa';
import { button, cleanup, fakeWindow, mount, until } from './fake-dom';
import { fixture, noNetwork, resetStores } from './screen-fixture';
import { devKey } from './helpers';
import { ownerOfAddress, OWNER_P2PK_SCHNORR, OWNER_P2PKH_ECDSA, OWNER_P2SH } from '@/kusdt/owner';
import { session } from '@/lib/storage';
import { REQUEST_KEY, type PendingRequest } from '@/provider/protocol';
import { Approve, ARM_MS } from '@/screens/Approve';

const h = vi.hoisted(() => ({ wallet: null as unknown }));
vi.mock('@/popup/state', () => ({ useWallet: () => h.wallet }));

/** A Schnorr address whose x is 5: not on the curve. */
const OFF_CURVE = encodeKaspaAddress('kaspasim', 0, Uint8Array.from({ length: 32 }, (_, i) => (i === 31 ? 5 : 0)));
/** An ECDSA address whose 33 bytes start 04: no compressed key. */
const NOT_COMPRESSED = encodeKaspaAddress('kaspasim', 1, Uint8Array.from({ length: 33 }, (_, i) => (i === 0 ? 4 : i)));

beforeEach(async () => {
  await resetStores(); vi.stubGlobal('fetch', noNetwork);
  vi.stubGlobal('chrome', { tabs: { sendMessage: (_t: number, _m: unknown, cb?: () => void) => cb?.() }, runtime: {} });
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe('R21-CRYPTO-5: an address that names no key is refused as a recipient', () => {
  it('a Schnorr address whose x is off the curve, and an ECDSA address that is no compressed key', () => {
    expect(() => ownerOfAddress(OFF_CURVE, 'kaspasim')).toThrow(/names no key that could ever sign/);
    expect(() => ownerOfAddress(NOT_COMPRESSED, 'kaspasim')).toThrow(/names no key that could ever sign/);
  });

  it('honest addresses still give their owners: a Schnorr key, an ECDSA key and a script', () => {
    const alice = devKey('r21-crypto5');
    expect(ownerOfAddress(alice.address, 'kaspasim')).toEqual({ ownerScheme: OWNER_P2PK_SCHNORR, owner: alice.xonly });
    const ecdsa = secp256k1.getPublicKey(secp256k1.utils.randomSecretKey(), true);
    expect(ownerOfAddress(encodeKaspaAddress('kaspasim', 1, ecdsa), 'kaspasim')).toEqual({ ownerScheme: OWNER_P2PKH_ECDSA, owner: bytesToHex(blake3(ecdsa)) });
    // A script hash is no key, and is not asked to be one.
    const script = new Uint8Array(32).fill(7);
    expect(ownerOfAddress(encodeKaspaAddress('kaspasim', 8, script), 'kaspasim')).toEqual({ ownerScheme: OWNER_P2SH, owner: bytesToHex(script) });
  });

  it('a site\'s kusdt_send to such an address: the window says so and nothing can be approved', async () => {
    const fx = fixture('c9');
    h.wallet = fx.wallet;
    const id = 'window-crypto5-1';
    const params = { method: 'kusdt_send', to: OFF_CURVE, amount: '1000000' } as PendingRequest['params'];
    await session.set({ [REQUEST_KEY]: { id, method: params.method, params, origin: 'https://site.example', tabId: 7, at: 1, network: 'simnet' } as PendingRequest });
    fakeWindow.location.hash = `#request=${id}`;
    const { root } = await mount(createElement(Approve));
    await until('the refusal', () => /names no key that could ever sign/.test(root.textContent));
    await new Promise((r) => setTimeout(r, ARM_MS + 200));
    expect(button(root, 'Approve').disabled).toBe(true);
    expect(fx.node.submitted).toEqual([]);
  });
});
