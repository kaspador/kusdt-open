// Run 21, outside review (Daybreak [27]): the core's `transfer` builder, as every TypeScript caller reaches it
// (core.call), makes only redemptions the signers pay. It signed burns to a chain with no vault, burns carrying a borrow
// guard or an extension, empty burns and burns to the zero address, each lost for good with nothing paid; it refuses
// them now. The reviewer's reproduction (run 21, agents/ident, r21-ident-builder.test.ts), with the rest of the rule.
import { describe, expect, it } from 'vitest';
import { schnorr } from '@noble/curves/secp256k1.js';
import { blake2b } from '@noble/hashes/blake2.js';
import { core, CoreError } from '@kusdt/core';
import { bytesToHex, encodeKaspaAddress, hexToBytes } from '@kusdt/kaspa';
import { decodeKcc20Input } from './index';

const template = core.call('template').value;
const key = (seed: string) => blake2b(new TextEncoder().encode(seed), { dkLen: 32 });
const xonly = (secret: Uint8Array) => bytesToHex(schnorr.getPublicKey(secret));
const ZERO32 = '00'.repeat(32);
const ADDRESS = '5a'.repeat(20);
const alice = key('alice');
const funding = key('funding');

/** Alice's 5 kUSDT (carrying the extension commitment `extension`), spent whole into `outputs`, naming `redeem`. */
function transfer(outputs: unknown[], redeem: unknown[], extension = ZERO32) {
  const spent = { amount: 5_000_000, owner: xonly(alice), ownerScheme: 0, borrowScheme: 0, borrowGuard: ZERO32, extensionCommitment: extension };
  const spk = core.call('script', { actor: 'KCC20', state: spent }).value.scriptPublicKey;
  return core.call('transfer', {
    network: 'simnet',
    changeAddress: encodeKaspaAddress('kaspasim', 0, hexToBytes(xonly(funding))),
    funding: [{ utxo: { transactionId: 'aa'.repeat(32), index: 0, amount: 10_000_000_000, scriptPublicKey: '000020' + xonly(funding) + 'ac' }, secretKey: bytesToHex(funding) }],
    inputs: [{ utxo: { transactionId: 'bb'.repeat(32), index: 1, amount: 150_000_000, scriptPublicKey: spk, covenantId: 'cd'.repeat(32) }, state: spent, secretKey: bytesToHex(alice) }],
    outputs,
    redeem,
  }).value;
}

const burnState = (chain: number, amount = 5_000_000, address = ADDRESS) =>
  ({ amount, owner: core.call('burn-owner', { chain, address }).value.owner, ownerScheme: 3, borrowScheme: 0, borrowGuard: ZERO32, extensionCommitment: ZERO32 });
/** Everything burned into `state` with 0.3 KAS, named for `chain` and `address`. */
const burnAll = (chain: number, state = burnState(chain), address = ADDRESS) => transfer([{ state, value: 30_000_000 }], [{ outputIndex: 0, chain, address }]);

describe('Daybreak [27]: the core builds no redemption the signers would not pay', () => {
  const cases: [string, () => unknown, RegExp][] = [
    ['chain 3, which has no vault', () => burnAll(3), /chain 3/],
    ['chain 0', () => burnAll(0), /chain 0/],
    ['chain 1, borrow guard 77..77', () => burnAll(1, { ...burnState(1), borrowGuard: '77'.repeat(32) }), /no signer would pay/],
    [
      'chain 1, extension 77..77 carried over from the spent state',
      () => transfer([{ state: { ...burnState(1), extensionCommitment: '77'.repeat(32) }, value: 30_000_000 }], [{ outputIndex: 0, chain: 1, address: ADDRESS }], '77'.repeat(32)),
      /no signer would pay/,
    ],
    [
      'chain 1, a burn of nothing beside change of everything',
      () => transfer([{ state: burnState(1, 0), value: 30_000_000 }, { state: { ...burnState(1), owner: xonly(alice), ownerScheme: 0 }, value: 150_000_000 }], [{ outputIndex: 0, chain: 1, address: ADDRESS }]),
      /no signer would pay/,
    ],
    ['chain 2, the zero address', () => burnAll(2, burnState(2, 5_000_000, ZERO32.slice(0, 40)), ZERO32.slice(0, 40)), /zero address/],
  ];
  for (const [name, build, why] of cases) {
    it(`${name}: refused`, () => {
      expect(build).toThrow(CoreError);
      expect(build).toThrow(why);
    });
  }

  it('an honest redemption on either chain builds as before, payload and all', () => {
    for (const chain of [1, 2]) {
      const built = burnAll(chain);
      expect(decodeKcc20Input(hexToBytes(built.transaction.inputs[0].signatureScript), template)!.role).toBe('leader');
      expect(built.transaction.payload).toBe(`4b55534454010100${chain.toString(16).padStart(2, '0')}${ADDRESS}`);
    }
  });
});
