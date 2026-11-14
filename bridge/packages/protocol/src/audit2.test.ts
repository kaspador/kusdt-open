// Audit 2: the followers refuse number spellings the covenant accepts.
//
// The covenant takes a padded (up to 8 bytes) or negative-zero `first_nonce` and `now_daa`:
// bridge/kaspa/tests/audit2_mint.rs proves it in the script engine. Those bytes are unsigned and
// outside the transaction id. These tests pass when the attack WORKS: the only body of a real,
// correctly signed mint or set_limits cannot be followed, so a follower stays on a spent minter.
import { describe, expect, it } from 'vitest';
import { schnorr } from '@noble/curves/secp256k1.js';
import { core } from '@kusdt/core';
import { bytesToHex, hexToBytes } from '@kusdt/kaspa';
import { MinterFollowError, followMinter, parsePushes, type ProgramLayout } from './index';
import { offlineChain, secret, xonly } from './testing/chain';

const layout: ProgramLayout = core.call('layout', {}).value.contracts.BridgeMint;
const scriptOf = (actor: string, state: unknown) => core.call('script', { actor, state }).value.scriptPublicKey as string;

function encodePushes(pushes: Uint8Array[]): string {
  const out: number[] = [];
  for (const p of pushes) {
    if (p.length === 0) out.push(0x00);
    else if (p.length <= 0x4b) out.push(p.length, ...p);
    else if (p.length <= 0xff) out.push(0x4c, p.length, ...p);
    else out.push(0x4d, p.length & 0xff, p.length >> 8, ...p);
  }
  return bytesToHex(Uint8Array.from(out));
}

function rewrite(tx: any, input: number, argument: number, value: Uint8Array) {
  const forged = structuredClone(tx);
  const pushes = parsePushes(hexToBytes(tx.inputs[input].signatureScript));
  pushes[argument] = value;
  forged.inputs[input].signatureScript = encodePushes(pushes);
  return forged;
}

const inputOf = (tx: any, utxo: { transactionId: string; index: number }) =>
  tx.inputs.findIndex((i: any) => i.previousOutpoint.transactionId === utxo.transactionId && i.previousOutpoint.index === utxo.index);

function mintedAtNonce(first: boolean, name: string) {
  const c = offlineChain(name);
  if (!first) c.mint([secret(`${name}/a`)], [1_000_000n]);
  const held = c.minter();
  const real = c.mint([secret(`${name}/b`)], [1_000_000n]);
  const follow = (tx: any) => followMinter(real.txid, tx, held.utxo, layout, scriptOf as any, c.covenantId);
  return { real, held, follow, input: inputOf(real.transaction, held.utxo) };
}

describe('audit 2: a real body the followers cannot read', () => {
  it('a mint with a padded first_nonce is the same mint to a follower', () => {
    const { real, follow, input } = mintedAtNonce(false, 'audit2/nonce');
    expect(follow(real.transaction)!.step.minted).toHaveLength(1);
    for (const padded of [Uint8Array.of(1, 0), Uint8Array.of(1, 0, 0, 0, 0, 0, 0, 0)]) {
      const forged = rewrite(real.transaction, input, 1, padded);
      expect(follow(forged)!.step.minted).toHaveLength(1);
    }
  });

  it('a mint at nonce 0 spelled as a negative zero', () => {
    const { real, follow, input } = mintedAtNonce(true, 'audit2/zero');
    expect(follow(real.transaction)).not.toBeNull();
    expect(follow(rewrite(real.transaction, input, 1, Uint8Array.of(0x80)))).not.toBeNull();
  });

  it('a mint with a padded now_daa', () => {
    const { real, follow, input } = mintedAtNonce(false, 'audit2/now');
    const honest = parsePushes(hexToBytes(real.transaction.inputs[input].signatureScript))[2];
    const forged = rewrite(real.transaction, input, 2, Uint8Array.of(...honest, 0));
    expect(follow(forged)).not.toBeNull();
  });

  it('a set_limits with a padded now_daa', () => {
    const c = offlineChain('audit2/limits');
    const held = c.minter();
    const action = { kind: 'setLimits', capacity: 300_000_000_000n, refillPerDaa: 347_222n };
    const digest = core.call('govern-digest', { covenantId: c.covenantId, adminNonce: held.state.adminNonce, action }).value.digest;
    const who = [0, 1, 2, 4];
    const real = core.call('govern', {
      ...c.common(), minter: held, action, ageDaa: 0, signerKeys: c.signers.map(xonly), signerIndices: who,
      signatures: who.map((i) => bytesToHex(schnorr.sign(hexToBytes(digest), c.signers[i]))),
    }).value;
    const follow = (tx: any) => followMinter(real.txid, tx, held.utxo, layout, scriptOf as any, c.covenantId);
    expect(follow(real.transaction)).not.toBeNull();
    const input = inputOf(real.transaction, held.utxo);
    const honest = parsePushes(hexToBytes(real.transaction.inputs[input].signatureScript))[2];
    expect(follow(rewrite(real.transaction, input, 2, Uint8Array.of(...honest, 0)))).not.toBeNull();
  });
});
