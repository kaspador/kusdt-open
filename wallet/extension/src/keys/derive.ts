// Keys from the BIP-39 recovery phrase.
//
//   Kaspa  m/44'/111111'/0'/0/0   (receive), the path Kaspa NG, KasWare and
//          Kaspium use; the wallet also finds KAS on the first 20 receive and
//          change addresses of account 0, so a phrase from another wallet shows
//          its coins. kUSDT is always owned by the first key (SPEC §4: scheme
//          0x00, its x-only public key).
//   EVM    m/44'/60'/0'/0/0, MetaMask's first account, for deposits.

import { generateMnemonic, validateMnemonic, mnemonicToSeedSync } from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english.js';
import { HDKey } from '@scure/bip32';
import { secp256k1, schnorr } from '@noble/curves/secp256k1.js';
import { keccak_256 } from '@noble/hashes/sha3.js';
import { bytesToHex, encodeKaspaAddress, kaspaAccountNode, kaspaKeyAt, kaspaPrivateKeyAt, type KaspaKey, type KaspaNetworkParams } from '@kusdt/kaspa';

/** A new 24-word phrase (256 bits). */
export const newMnemonic = (): string => generateMnemonic(wordlist, 256);

/** Normalizes spacing and case; null unless it is a valid English BIP-39 phrase. */
export function cleanMnemonic(input: string): string | null {
  const m = input.trim().toLowerCase().split(/\s+/).join(' ');
  const n = m.split(' ').length;
  if (![12, 15, 18, 21, 24].includes(n)) return null;
  return validateMnemonic(m, wordlist) ? m : null;
}

export const hdFromMnemonic = (mnemonic: string): HDKey => HDKey.fromMasterSeed(mnemonicToSeedSync(mnemonic));

export const KASPA_ACCOUNT = 0;
/** How many receive and change addresses are looked at for KAS. */
export const KAS_SCAN = 20;

export interface WalletKeys {
  /** The main Kaspa key: receive address, change address and kUSDT owner. */
  main: KaspaKey;
  /** Every address KAS is looked for on (main first). */
  scan: KaspaKey[];
  /** The x-only key of the main address, hex: the kUSDT owner (scheme 0x00). */
  ownerHex: string;
  evmAddress: string;
}

/** Public keys only: safe to keep while the wallet is unlocked. */
export function walletKeys(hd: HDKey, net: KaspaNetworkParams): WalletKeys {
  const account = kaspaAccountNode(hd, KASPA_ACCOUNT);
  const main = kaspaKeyAt(account, KASPA_ACCOUNT, 0, 0, net);
  const scan: KaspaKey[] = [main];
  for (const chain of [0, 1] as const) {
    for (let i = 0; i < KAS_SCAN; i++) if (chain !== 0 || i !== 0) scan.push(kaspaKeyAt(account, KASPA_ACCOUNT, chain, i, net));
  }
  return { main, scan, ownerHex: bytesToHex(main.xonly), evmAddress: evmAddressOf(evmPrivateKey(hd)) };
}

/** The private key of one of the scanned Kaspa addresses. Callers wipe it after use. */
export function kaspaPrivateKey(hd: HDKey, key: Pick<KaspaKey, 'chain' | 'index'>): Uint8Array {
  return kaspaPrivateKeyAt(kaspaAccountNode(hd, KASPA_ACCOUNT), key.chain, key.index);
}

export const EVM_PATH = "m/44'/60'/0'/0/0";

export function evmPrivateKey(hd: HDKey): Uint8Array {
  const child = hd.derive(EVM_PATH);
  if (!child.privateKey) throw new Error('No private key.');
  return child.privateKey;
}

/** EIP-55 address of a secp256k1 private key. */
export function evmAddressOf(priv: Uint8Array): string {
  const pub = secp256k1.getPublicKey(priv, false);
  return toChecksumAddress('0x' + bytesToHex(keccak_256(pub.slice(1)).slice(12)));
}

export function toChecksumAddress(a: string): string {
  if (!/^0x[0-9a-fA-F]{40}$/.test(a)) throw new Error('Not an EVM address.');
  const body = a.slice(2).toLowerCase();
  const hash = bytesToHex(keccak_256(new TextEncoder().encode(body)));
  let out = '0x';
  for (let i = 0; i < 40; i++) out += parseInt(hash[i], 16) >= 8 ? body[i].toUpperCase() : body[i];
  return out;
}

/** A well-formed EVM address: one-case, or mixed case with a valid EIP-55 checksum. */
export function isEvmAddressStrict(a: string): boolean {
  if (!/^0x[0-9a-fA-F]{40}$/.test(a)) return false;
  const body = a.slice(2);
  if (body === body.toLowerCase() || body === body.toUpperCase()) return true;
  return toChecksumAddress(a) === a;
}

/** The address a raw Kaspa private key controls (tests and the devnet flow). */
export const kaspaAddressOfKey = (priv: Uint8Array, net: KaspaNetworkParams): string =>
  encodeKaspaAddress(net.prefix, 0, schnorr.getPublicKey(priv));
