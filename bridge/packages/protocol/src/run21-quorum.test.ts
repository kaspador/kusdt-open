// Run 21, R21-CRYPTO-2 (round 2, reviewer `crypto2`, info): hasQuorum, the follower's copy of bridge_mint.ag's
// require_quorum, took a mint carrying four or five signatures as one carrying its quorum of three. The covenant takes
// exactly the quorum (`require(indices.length == quorum)`), and so does the builder: a body with more is never valid,
// and the follower's copy must not call it so.
// Run: npx vitest run bridge/packages/protocol/src/run21-quorum.test.ts
import { describe, expect, it } from 'vitest';
import { schnorr } from '@noble/curves/secp256k1.js';
import { core } from '@kusdt/core';
import { bytesToHex, hexToBytes } from '@kusdt/kaspa';
import { decodeMinterSpend, hasQuorum, type ProgramLayout } from './index';
import { offlineChain, secret } from './testing/chain';

const layout: ProgramLayout = core.call('layout', {}).value.contracts.BridgeMint;

describe('R21-CRYPTO-2: the follower takes exactly the quorum the covenant takes', () => {
  it('a mint\'s spend with its three signatures has its quorum; the same with four or five does not', () => {
    const c = offlineChain('run21-quorum');
    const built = c.mint([secret('run21-quorum/holder')], [1_000_000n]);
    const input = built.transaction.inputs.find((i: any) => decodeMinterSpend(hexToBytes(i.signatureScript), layout));
    const spend = decodeMinterSpend(hexToBytes(input.signatureScript), layout)!;
    expect(spend.entry).toBe('mint');
    if (spend.entry !== 'mint') return;
    expect(hasQuorum(spend, c.covenantId)).toBe(true);
    // Every signer's signature over the same mint digest.
    const digest = core.call('mint-digest', { covenantId: c.covenantId, chain: 1, firstNonce: 0n, recipients: spend.recipients }).value.digest;
    const all = c.signers.map((k) => schnorr.sign(hexToBytes(digest), k));
    const signedBy = (who: number[]) => ({ ...spend, quorum: { ...spend.quorum, indices: Uint8Array.from(who), signatures: Uint8Array.from(who.flatMap((i) => [...all[i]])) } });
    expect(hasQuorum(signedBy([0, 2, 4]), c.covenantId)).toBe(true);
    expect(hasQuorum(signedBy([0, 1, 2, 3]), c.covenantId)).toBe(false);
    expect(hasQuorum(signedBy([0, 1, 2, 3, 4]), c.covenantId)).toBe(false);
    expect(hasQuorum(signedBy([0, 1]), c.covenantId)).toBe(false);
    expect(bytesToHex(spend.quorum.signatures).length).toBe(3 * 128);
  });
});
