import { describe, expect, it } from 'vitest';
import { KASPA_NETWORKS, bytesToHex } from '@kusdt/kaspa';
import V from '../../../bridge/packages/kaspa/src/fixtures/kaspa-vectors.json';
import { cleanMnemonic, evmAddressOf, evmPrivateKey, hdFromMnemonic, kaspaPrivateKey, newMnemonic, walletKeys, isEvmAddressStrict } from '@/keys/derive';

const ABANDON = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';

describe('key derivation', () => {
  it('matches the rusty-kaspa SDK vectors (packages/kaspa fixtures) for every phrase', () => {
    for (const d of V.derivation) {
      const hd = hdFromMnemonic(d.phrase);
      const acc = d.accounts.find(a => a.account === 0)!;
      const main = walletKeys(hd, KASPA_NETWORKS.mainnet);
      const test = walletKeys(hd, KASPA_NETWORKS['testnet-10']);
      expect(main.main.address).toBe(acc.receive[0].address);
      expect(test.main.address).toBe(acc.receive[0].testnet);
      // Every vector address of account 0 is among the scanned ones, with its key.
      for (const r of acc.receive) {
        const k = main.scan.find(s => s.address === r.address)!;
        expect(k).toBeTruthy();
        expect(bytesToHex(kaspaPrivateKey(hd, k))).toBe(r.priv);
      }
      for (const c of acc.change) expect(main.scan.some(s => s.address === c.address && s.chain === 1)).toBe(true);
      expect(main.ownerHex).toBe(bytesToHex(main.main.xonly));
    }
  });

  it('derives MetaMask\'s first EVM account (m/44\'/60\'/0\'/0/0)', () => {
    expect(evmAddressOf(evmPrivateKey(hdFromMnemonic(ABANDON)))).toBe('0x9858EfFD232B4033E47d90003D41EC34EcaEda94');
  });

  it('makes 24-word phrases and checks typed ones', () => {
    const m = newMnemonic();
    expect(m.split(' ')).toHaveLength(24);
    expect(cleanMnemonic(`  ${m.toUpperCase()}  `)).toBe(m);
    expect(cleanMnemonic(ABANDON.replace('about', 'abandon'))).toBeNull();
    expect(cleanMnemonic('hello world')).toBeNull();
  });

  it('accepts EVM addresses only with a valid checksum when mixed case', () => {
    expect(isEvmAddressStrict('0x9858EfFD232B4033E47d90003D41EC34EcaEda94')).toBe(true);
    expect(isEvmAddressStrict('0x9858effd232b4033e47d90003d41ec34ecaeda94')).toBe(true);
    expect(isEvmAddressStrict('0x9858EfFD232B4033E47d90003D41EC34EcaEda95')).toBe(false);
  });
});
