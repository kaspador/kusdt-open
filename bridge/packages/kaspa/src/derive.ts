// Kaspa keys from the wallet's BIP-39 recovery phrase, on the path every
// mainstream Kaspa wallet uses (Kaspa NG, Kaspium, KasWare, Tangem):
//
//   m/44'/111111'/<account>'/<chain>/<index>      chain 0 = receive, 1 = change
//
// Addresses are version 0 (Schnorr): the 32-byte x-only public key. The seed
// is the same one the Pearl side derives from, so one phrase backs up both.

import type { HDKey } from '@scure/bip32';
import { schnorr } from '@noble/curves/secp256k1.js';
import { encodeKaspaAddress } from './address';
import { KASPA_COIN_TYPE, type KaspaNetworkParams } from './network';

export interface KaspaKey {
  account: number;
  chain:   0 | 1;
  index:   number;
  path:    string;
  address: string;
  xonly:   Uint8Array;   // 32-byte x-only public key (the address payload)
}

export const kaspaAccountPath = (account: number) => `m/44'/${KASPA_COIN_TYPE}'/${account}'`;
export const kaspaKeyPath = (account: number, chain: 0 | 1, index: number) => `${kaspaAccountPath(account)}/${chain}/${index}`;

/** The account node (m/44'/111111'/account'). Hardened, so it needs the private master key. */
export function kaspaAccountNode(master: HDKey, account: number): HDKey {
  if (!Number.isInteger(account) || account < 0 || account >= 0x80000000) throw new Error('Bad Kaspa account index.');
  return master.derive(kaspaAccountPath(account));
}

export function xonlyFromCompressed(pub: Uint8Array): Uint8Array {
  if (pub.length !== 33) throw new Error('Expected a 33-byte compressed public key.');
  return pub.slice(1);
}

/** Address (and public key) at chain/index under an account node. Public derivation only. */
export function kaspaKeyAt(accountNode: HDKey, account: number, chain: 0 | 1, index: number, net: KaspaNetworkParams): KaspaKey {
  const child = accountNode.deriveChild(chain).deriveChild(index);
  if (!child.publicKey) throw new Error('No public key.');
  const xonly = xonlyFromCompressed(child.publicKey);
  return { account, chain, index, path: kaspaKeyPath(account, chain, index), address: encodeKaspaAddress(net.prefix, 0, xonly), xonly };
}

/** The private key at chain/index. Callers must not keep it longer than one signing. */
export function kaspaPrivateKeyAt(accountNode: HDKey, chain: 0 | 1, index: number): Uint8Array {
  const child = accountNode.deriveChild(chain).deriveChild(index);
  if (!child.privateKey) throw new Error('No private key (watch-only account node).');
  return child.privateKey;
}

/** The Kaspa address a raw private key controls (version 0, x-only). */
export function kaspaAddressForPrivateKey(priv: Uint8Array, net: KaspaNetworkParams): string {
  return encodeKaspaAddress(net.prefix, 0, schnorr.getPublicKey(priv));
}

/** The BIP-32 master key of a BIP-39 recovery phrase (no passphrase). */
export async function mnemonicToHDKey(mnemonic: string): Promise<HDKey> {
  const { mnemonicToSeed } = await import('@scure/bip39');
  const { HDKey: HD } = await import('@scure/bip32');
  return HD.fromMasterSeed(await mnemonicToSeed(mnemonic.trim()));
}
