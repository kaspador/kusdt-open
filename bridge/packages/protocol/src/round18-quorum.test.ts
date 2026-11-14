// Round 18 (13 November 2026), R18-COV-2: the minter follower (hasQuorum) took a quorum larger than the script's exact
// count (`quorum < atLeast || quorum > SIGNERS`), while bridge_mint.ag's require_quorum asks `indices.length == quorum`
// and `signatures.length == quorum`. A body rewritten under a real txid (txids do not commit to signature scripts) with
// an extra valid signature over the same digest, which consensus refuses, still read as a body that proves the move.
// No harm was found (the successor and the minted states are checked against the txid-committed outputs), but the
// follower now asks what the script asks: exactly 3 for a mint and a recovery proposal, 1 for a veto, 4 otherwise.
// Run: npx vitest run bridge/packages/protocol/src/round18-quorum.test.ts
import { describe, expect, it } from 'vitest';
import { schnorr } from '@noble/curves/secp256k1.js';
import { blake2b } from '@noble/hashes/blake2.js';
import { core } from '@kusdt/core';
import { bytesToHex, encodeKaspaAddress, hexToBytes } from '@kusdt/kaspa';
import { decodeMinterSpend, hasQuorum, type MinterSpend, type ProgramLayout } from './index';

const KAS = 100_000_000n;
const layout: ProgramLayout = core.call('layout', {}).value.contracts.BridgeMint;
const secret = (seed: string) => blake2b(new TextEncoder().encode(seed), { dkLen: 32 });
const xonly = (s: Uint8Array) => bytesToHex(schnorr.getPublicKey(s));
const payer = secret('round18-quorum/payer');
const payerAddress = encodeKaspaAddress('kaspasim', 0, schnorr.getPublicKey(payer));
const signers = [0, 1, 2, 3, 4].map((i) => secret(`round18-quorum/signer-${i}`));
const guardian = secret('round18-quorum/guardian');
let coinSeed = 0;
const common = () => ({
  network: 'simnet', changeAddress: payerAddress,
  funding: [{ utxo: { transactionId: (++coinSeed).toString(16).padStart(64, '0'), index: 0, amount: 10_000n * KAS, scriptPublicKey: `000020${xonly(payer)}ac` }, secretKey: bytesToHex(payer) }],
});
const { signerSet } = core.call('signer-set', { signerKeys: signers.map(xonly) }).value;
const genesis = core.call('genesis', {
  ...common(),
  minter: {
    remaining: 1_000_000_000_000_000n, bucket: 400_000_000_000n, capacity: 500_000_000_000n, refillPerDaa: 578_703n,
    nonceEthereum: 0n, nonceBsc: 0n, adminNonce: 0n, paused: false, signerSet, guardian: xonly(guardian),
  },
  minterValue: 5n * KAS, seedOwner: xonly(payer), seedValue: 2n * KAS,
}).value;
const covenantId: string = genesis.covenantId;
type Located = { utxo: any; state: any };
const locate = (built: any, index = 0): Located => ({
  utxo: { transactionId: built.txid, index, amount: built.outputs[index].value, scriptPublicKey: built.outputs[index].scriptPublicKey, covenantId },
  state: built.outputs[index].minter,
});
const minter0 = locate(genesis);
const sign = (digest: string, who: number[]) => who.map((i) => bytesToHex(schnorr.sign(hexToBytes(digest), signers[i])));
const spendOf = (built: any, from: Located) => {
  const input = built.transaction.inputs.find((i: any) => i.previousOutpoint.transactionId === from.utxo.transactionId);
  return decodeMinterSpend(hexToBytes(input.signatureScript), layout) as Extract<MinterSpend, { quorum: unknown }>;
};
/** The same spend with the quorum of `who`, each signing `digest`: what a rewritten body under the same txid would carry. */
const withQuorum = (spend: any, digest: string, who: number[]) => ({
  ...spend, quorum: { ...spend.quorum, indices: Uint8Array.from(who), signatures: hexToBytes(sign(digest, who).join('')) },
});

const recipients = [{ ownerScheme: 0, owner: xonly(secret('round18-quorum/holder')), amount: 1_000_000n }];
const mintDigest: string = core.call('mint-digest', { covenantId, chain: 1, firstNonce: 0n, ageDaa: 0n, recipients }).value.digest;
const buildMint = (who: number[]) => core.call('mint', {
  ...common(), minter: minter0, chain: 1, firstNonce: 0n, ageDaa: 0, recipients,
  signerKeys: signers.map(xonly), signerIndices: who, signatures: sign(mintDigest, who), tokenValue: 150_000_000n,
}).value;

function govern(from: Located, action: any, who: number[]) {
  const nonce = action.kind === 'proposeRecovery' || action.kind === 'vetoRecovery' ? from.state.recoveryNonce : from.state.adminNonce;
  const digest: string = core.call('govern-digest', { covenantId, adminNonce: nonce, ageDaa: 0, action, outpoint: { transactionId: from.utxo.transactionId, index: from.utxo.index } }).value.digest;
  const built = core.call('govern', { ...common(), minter: from, action, ageDaa: 0, signerKeys: signers.map(xonly), signerIndices: who, signatures: sign(digest, who) }).value;
  return { built, digest };
}

describe('R18-COV-2: the follower takes exactly the quorum the covenant takes', () => {
  const spent = { transactionId: minter0.utxo.transactionId, index: minter0.utxo.index };

  it('a mint: three signatures are its quorum; the same body with a fourth valid one is none, as the script refuses it (da864f6: taken)', () => {
    const mint = buildMint([0, 2, 4]);
    const spend = spendOf(mint, minter0);
    expect(hasQuorum(spend, covenantId, spent)).toBe(true);
    // The covenant's count, as the core's builder applies it before it runs the script: a mint with four is refused.
    expect(() => buildMint([0, 1, 2, 4])).toThrow(/needs exactly 3 signatures/);
    // The follower, given that body under the mint's txid: four and five signatures over the same digest are no quorum.
    expect(hasQuorum(withQuorum(spend, mintDigest, [0, 1, 2, 4]), covenantId, spent)).toBe(false);
    expect(hasQuorum(withQuorum(spend, mintDigest, [0, 1, 2, 3, 4]), covenantId, spent)).toBe(false);
    // Fewer stays none, and another three is a quorum again.
    expect(hasQuorum(withQuorum(spend, mintDigest, [0, 2]), covenantId, spent)).toBe(false);
    expect(hasQuorum(withQuorum(spend, mintDigest, [1, 3, 4]), covenantId, spent)).toBe(true);
  });

  it('a governance action takes exactly 4: a fifth valid signature is no quorum (da864f6: taken)', () => {
    const { built, digest } = govern(minter0, { kind: 'setLimits', capacity: 300_000_000_000n, refillPerDaa: 347_222n }, [0, 1, 2, 4]);
    const spend = spendOf(built, minter0);
    expect(hasQuorum(spend, covenantId, spent)).toBe(true);
    expect(hasQuorum(withQuorum(spend, digest, [0, 1, 2, 3, 4]), covenantId, spent)).toBe(false);
    expect(hasQuorum(withQuorum(spend, digest, [0, 1, 2]), covenantId, spent)).toBe(false);
  });

  it('a recovery proposal takes exactly 3 and a veto exactly 1 (da864f6: 4 and 2 taken)', () => {
    const newSigners = [5, 6, 7, 8, 9].map((i) => xonly(secret(`round18-quorum/signer-${i}`)));
    const proposal = govern(minter0, { kind: 'proposeRecovery', signerKeys: newSigners, guardian: xonly(payer) }, [0, 1, 2]);
    const propose = spendOf(proposal.built, minter0);
    expect(hasQuorum(propose, covenantId, spent)).toBe(true);
    expect(hasQuorum(withQuorum(propose, proposal.digest, [0, 1, 2, 3]), covenantId, spent)).toBe(false);
    const proposed = locate(proposal.built);
    const veto = govern(proposed, { kind: 'vetoRecovery' }, [3]);
    const vetoSpend = spendOf(veto.built, proposed);
    const vetoSpent = { transactionId: proposed.utxo.transactionId, index: proposed.utxo.index };
    expect(hasQuorum(vetoSpend, covenantId, vetoSpent)).toBe(true);
    expect(hasQuorum(withQuorum(vetoSpend, veto.digest, [3, 4]), covenantId, vetoSpent)).toBe(false);
  });
});
