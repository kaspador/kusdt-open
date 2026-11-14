import { describe, expect, it } from 'vitest';
import { core } from '@kusdt/core';
import { bytesToHex, hexToBytes } from '@kusdt/kaspa';
import { followMinter, parsePushes, type ProgramLayout } from './index';
import { offlineChain, secret } from './testing/chain';

const layout: ProgramLayout = core.call('layout', {}).value.contracts.BridgeMint;
const scriptOf = (actor: string, state: unknown) => core.call('script', { actor, state }).value.scriptPublicKey as string;
function encodePushes(pushes: Uint8Array[]): string {
  const out: number[] = [];
  for (const p of pushes) {
    if (p.length === 0) out.push(0x00);
    else if (p.length === 1 && p[0] >= 1 && p[0] <= 16) out.push(0x50 + p[0]);
    else if (p.length <= 0x4b) out.push(p.length, ...p);
    else if (p.length <= 0xff) out.push(0x4c, p.length, ...p);
    else out.push(0x4d, p.length & 0xff, p.length >> 8, ...p);
  }
  return bytesToHex(Uint8Array.from(out));
}

describe('review', () => {
  it('a mint body replaying an older identical mint is refused: its nonce is not the one the minter holds', () => {
    const c = offlineChain('review/replay');
    const a = secret('review/a');
    const first = c.mint([a], [1_000_000n]);
    const held = c.minter();
    const second = c.mint([a], [1_000_000n]);
    const at = (tx: any, u: any) => tx.inputs.findIndex((i: any) => i.previousOutpoint.transactionId === u.transactionId && i.previousOutpoint.index === u.index);
    const i2 = at(second.transaction, held.utxo);
    const p1 = parsePushes(hexToBytes(first.transaction.inputs[at(first.transaction, first.transaction.inputs[0].previousOutpoint)].signatureScript));
    const p2 = parsePushes(hexToBytes(second.transaction.inputs[i2].signatureScript));
    const forged = structuredClone(second.transaction);
    p2[1] = p1[1]; p2[10] = p1[10]; p2[11] = p1[11];
    forged.inputs[i2].signatureScript = encodePushes(p2);
    const real = followMinter(second.txid, second.transaction, held.utxo, layout, scriptOf as any, c.covenantId)!;
    expect((real.spend as any).firstNonce).toBe(1n);
    // The body proof and the quorum both pass (the signatures are real, over nonce 0): the nonce check is what stops it.
    expect(() => followMinter(second.txid, forged, held.utxo, layout, scriptOf as any, c.covenantId)).toThrow(/nonce 0 of chain 1, the minter holds 1/);
  });
});
