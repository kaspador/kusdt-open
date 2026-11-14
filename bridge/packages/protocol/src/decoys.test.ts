// Regression tests for the security review's H-1 (2026-11-04). The covenants
// accept a transaction that also carries plain outputs paying to a successor's
// own P2SH script (bridge/kaspa/tests/decoy_outputs.rs), and any kUSDT state
// owned by the pool's covenant ID can pay a sell. The followers must adopt the
// covenant-bound successors anyway, and follow such a sell.

import { describe, expect, it } from 'vitest';
import { schnorr } from '@noble/curves/secp256k1.js';
import { core } from '@kusdt/core';
import { bytesToHex, hexToBytes } from '@kusdt/kaspa';
import { DELEGATOR_TAG, followMinter, followPool, parsePushes, writeInt8, type PoolLayouts, type ProgramLayout } from './index';
import { KAS, POSITION_VALUE, TOKEN_VALUE, offlineChain, secret, xonly } from './testing/chain';

const contracts = core.call('layout', {}).value.contracts;
const minterLayout: ProgramLayout = contracts.BridgeMint;
const template = core.call('template').value;
const layouts: PoolLayouts = { pool: contracts.Pool, position: contracts.Position, template };
const scriptOf = (actor: string, state: unknown) => core.call('script', { actor, state }).value.scriptPublicKey as string;

/** Puts, for each index, a plain output (no covenant binding) paying to that output's script in front. */
function withDecoysFirst(tx: any, ...indices: number[]) {
  const forged = structuredClone(tx);
  const decoys = indices.map((i) => ({ ...forged.outputs[i], value: 100_000_000, covenant: null }));
  forged.outputs.unshift(...decoys);
  // Inputs keep their indices, so every binding still names the same input.
  return forged;
}

const push = (data: Uint8Array): Uint8Array => {
  if (data.length === 0) return Uint8Array.of(0x00);
  if (data.length <= 75) return Uint8Array.of(data.length, ...data);
  if (data.length <= 255) return Uint8Array.of(0x4c, data.length, ...data);
  return Uint8Array.of(0x4d, data.length & 0xff, data.length >> 8, ...data);
};

/** The KCC20 program R for a plain state of `owner` under `scheme`. */
function kcc20Program(amount: bigint, owner: string, scheme: number): Uint8Array {
  const state = Uint8Array.of(
    0x08, ...writeInt8(amount), 0x20, ...hexToBytes(owner), 0x01, scheme, 0x01, 0x00, 0x20, ...new Uint8Array(32), 0x20, ...new Uint8Array(32),
  );
  return Uint8Array.of(...hexToBytes(template.prefix), ...state, ...hexToBytes(template.suffix));
}

describe('followers and decoy outputs', () => {
  it('the minter follower ignores a decoy placed before the successor, and sees the next mint', () => {
    const c = offlineChain('decoy-minter');
    const alice = secret('decoy/alice');
    const genesisMinter = c.minter();
    const mint = c.mint([alice], [1_000_000n]);
    const forged = withDecoysFirst(mint.transaction, 0);
    expect(forged.outputs[0].covenant).toBeNull();

    const move = followMinter(mint.txid, forged, genesisMinter.utxo, minterLayout, scriptOf as any, c.covenantId)!;
    expect(move.minter.utxo.index).toBe(1);
    expect(move.minted.map((m) => m.index)).toEqual([2]);

    // A later mint signed by 3 keys, from the real successor, is seen.
    const real = { utxo: { ...move.minter.utxo, covenantId: c.covenantId }, state: mint.outputs[0].minter };
    const recipients = [{ ownerScheme: 0, owner: xonly(secret('decoy/thief')), amount: 400_000_000_000n }];
    const firstNonce = BigInt(real.state.nonceEthereum);
    const digest = core.call('mint-digest', { covenantId: c.covenantId, chain: 1, firstNonce, recipients }).value.digest;
    const signatures = [0, 1, 2].map((i) => bytesToHex(schnorr.sign(hexToBytes(digest), c.signers[i])));
    const next = core.call('mint', {
      ...c.common(), minter: { utxo: { ...real.utxo, index: 0 }, state: real.state }, chain: 1, firstNonce, ageDaa: 0, recipients,
      signerKeys: c.signers.map(xonly), signerIndices: [0, 1, 2], signatures, tokenValue: TOKEN_VALUE,
    }).value;
    expect(followMinter(next.txid, next.transaction, { transactionId: mint.txid, index: 0, scriptPublicKey: mint.outputs[0].scriptPublicKey }, minterLayout, scriptOf as any, c.covenantId)?.spend.entry).toBe('mint');
  });

  it('the pool follower ignores decoys for the pool and its reserve', () => {
    const c = offlineChain('decoy-pool');
    const alice = secret('decoy/alice');
    const bob = secret('decoy/bob');
    const minted = c.mint([alice], [60_000_000n]);
    const pool0 = c.at(c.poolGenesis, 0, 'pool', c.poolId);
    const init = core.call('pool-init', {
      ...c.common(), adminSecretKey: bytesToHex(c.admin), pool: pool0, provider: c.owned(c.at(minted, 1, 'token'), alice), kasIn: 1_000n * KAS, tokensIn: 50_000_000n,
      positionOwner: xonly(alice), tokenValue: TOKEN_VALUE, positionValue: POSITION_VALUE,
    }).value;
    const pool1 = c.at(init, init.outputs.findIndex((o: any) => o.kind === 'pool'), 'pool', c.poolId);
    const reserve1 = c.at(init, init.outputs.findIndex((o: any) => o.kind === 'reserve'), 'token');
    const kasIn = 10n * KAS;
    const tokensOut = BigInt(core.call('quote', { kind: 'buy', pool: pool1.state, kasIn }).value.tokensOut);
    const buy = core.call('pool-buy', { ...c.common(), pool: pool1, reserve: reserve1, kasIn, tokensOut, buyer: xonly(bob), tokenValue: TOKEN_VALUE }).value;
    const p = buy.outputs.findIndex((o: any) => o.kind === 'pool');
    const r = buy.outputs.findIndex((o: any) => o.kind === 'reserve');

    const move = followPool(buy.txid, withDecoysFirst(buy.transaction, p, r), pool1.utxo, c.poolId, layouts, scriptOf)!;
    expect(move.pool.utxo.index).toBe(p + 2);
    expect(move.reserve!.utxo.index).toBe(r + 2);
  });

  it('the pool follower follows a sell paid by a pool-owned state', () => {
    const c = offlineChain('decoy-stray');
    const alice = secret('decoy/alice');
    const bob = secret('decoy/bob');
    const minted = c.mint([alice, bob], [60_000_000n, 40_000_000n]);
    const pool0 = c.at(c.poolGenesis, 0, 'pool', c.poolId);
    const init = core.call('pool-init', {
      ...c.common(), adminSecretKey: bytesToHex(c.admin), pool: pool0, provider: c.owned(c.at(minted, 1, 'token'), alice), kasIn: 1_000n * KAS, tokensIn: 50_000_000n,
      positionOwner: xonly(alice), tokenValue: TOKEN_VALUE, positionValue: POSITION_VALUE,
    }).value;
    const pool1 = c.at(init, init.outputs.findIndex((o: any) => o.kind === 'pool'), 'pool', c.poolId);
    const reserve1 = c.at(init, init.outputs.findIndex((o: any) => o.kind === 'reserve'), 'token');
    const bobToken = c.at(minted, 2, 'token');
    const tokensIn = 5_000_000n;
    const kasOut = BigInt(core.call('quote', { kind: 'sell', pool: pool1.state, tokensIn }).value.kasOut);
    const sell = core.call('pool-sell', { ...c.common(), pool: pool1, reserve: reserve1, payer: c.owned(bobToken, bob), tokensIn, kasOut, tokenValue: TOKEN_VALUE, nowDaa: 5_000 }).value;

    // The same sell, paid by a pool-owned state of the same amount (a delegator
    // with an empty witness over a scheme-0x04 program).
    const forged = structuredClone(sell.transaction);
    const payer = forged.inputs.find((i: any) => i.previousOutpoint.transactionId === bobToken.utxo.transactionId && i.previousOutpoint.index === bobToken.utxo.index);
    const program = kcc20Program(BigInt(bobToken.state.amount), c.poolId, 0x04);
    payer.signatureScript = bytesToHex(Uint8Array.of(...push(new Uint8Array()), ...push(hexToBytes(DELEGATOR_TAG)), ...push(program)));
    expect(parsePushes(hexToBytes(payer.signatureScript)).length).toBe(3);
    expect(followPool(sell.txid, forged, pool1.utxo, c.poolId, layouts, scriptOf)?.spend.entry).toBe('sell');
  });
});
