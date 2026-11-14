// The wallet's claim against a pool UTXO whose acceptance DAA moved (from the second review of the pool clock, 2026-11-10).
//
// A reorg can make a different chain block accept the pool UTXO, so its blockDaaScore on the node changes while its
// outpoint stays. The wallet read the old score and claimed age from it; the node refuses the lock. Before, LOCK_RETRY
// sent the same stale claim again until it gave up. Now a lock refusal makes the wallet verify the pool again: the same
// outpoint with a new score is taken as the node shows it now, and the swap is built again on it and goes through.
import { describe, expect, it } from 'vitest';
import { FakeNode, COVENANT, POOL, devKey, fakeApi, testCtx, signerFor, kasCoin, lastBuilt } from './helpers';
import { p2shAddressOf, scriptOf, reserveStateOf, poolValue } from '@/kusdt/verify';
import { LOCK_RETRY, POOL_WAIT, quoteBuy, swap } from '@/kusdt/pool';
import { NodeRejected } from '@/kaspa/node';
import type { PoolState } from '@/kusdt/types';

POOL_WAIT.ms = 0;
POOL_WAIT.perDaaMs = 0;
LOCK_RETRY.ms = 0;

const alice = devKey('lock-retry-alice');
const KAS = 100_000_000n;
/** 15 of a 20 KAS cap in use: above half, so every pool transaction claims at least 50 DAA. */
const inUse: PoolState = {
  tokenCovid: COVENANT, kasReserve: 200n * KAS, tokenReserve: 20_000_000n, totalShares: 200n * KAS, protocolKas: 0n, protocolTokens: 0n, baseValue: KAS,
  admin: '11'.repeat(32), maxOutBps: 1_000n, windowLen: 36_000n, windowCredit: 0n, windowRef: 200n * KAS, windowOut: 15n * KAS, paused: false, guardian: '22'.repeat(32),
};
const LOCK_TEXT = 'Rejected transaction {id}: one of the transaction sequence locks conditions was not met';

/** A chain with the pool accepted at `d` and a coin of the wallet's (`coin`: its txid's digit; the wallet remembers spent coins). */
function chainWithPool(d: bigint, coin = '8') {
  const node = new FakeNode();
  const ctx = testCtx(node, fakeApi({ pool: async () => answer }));
  const txid = '7'.repeat(64);
  const pspk = scriptOf(ctx, 'Pool', inUse);
  const poolUtxo = { address: p2shAddressOf(pspk, 'kaspasim'), transactionId: txid, index: 0, amount: poolValue(inUse), scriptPublicKey: pspk, blockDaaScore: d, isCoinbase: false, covenantId: POOL };
  const reserve = reserveStateOf(POOL, inUse);
  const rspk = scriptOf(ctx, 'KCC20', reserve);
  node.utxoSet.push(poolUtxo, { address: p2shAddressOf(rspk, 'kaspasim'), transactionId: txid, index: 1, amount: 150_000_000n, scriptPublicKey: rspk, blockDaaScore: d, isCoinbase: false, covenantId: COVENANT });
  node.utxoSet.push(kasCoin(alice, coin.repeat(64), 1_000n * KAS));
  const answer = { pool: { utxo: { transactionId: txid, index: 0 }, state: inUse }, reserve: { utxo: { transactionId: txid, index: 1 }, state: reserve } };
  let clock = d + 60n;
  node.virtualDaa = async () => (clock += 1n);
  // The node checks the relative lock as consensus does (rusty-kaspa check_sequence_lock): pov >= the UTXO's DAA + sequence.
  node.submitImpl = async (json: string) => {
    const seq = BigInt(JSON.parse(json).inputs[0].sequence);
    if (poolUtxo.blockDaaScore + seq > clock) throw new NodeRejected(LOCK_TEXT);
    return lastBuilt.txid;
  };
  return { node, ctx, poolUtxo, now: () => clock };
}

describe("the wallet after a reorg moved the pool UTXO's acceptance DAA", () => {
  it('verifies the pool again after the lock refusal and goes through on the moved score', async () => {
    const d = 5_000_000n;
    const { node, ctx, poolUtxo, now } = chainWithPool(d);
    let first = true;
    const submit = node.submitImpl;
    node.submitImpl = async (json) => {
      // Between the wallet's read and its submission a reorg re-accepts the pool UTXO 30 DAA later (same outpoint).
      if (first) { first = false; poolUtxo.blockDaaScore = d + 30n; }
      return submit(json);
    };
    const out = quoteBuy(ctx, inUse, KAS);
    const r = await swap(ctx, signerFor(alice), [alice.address], { side: 'buy', amountIn: KAS, minOut: out, quoted: out });
    expect(r.txid).toBeTruthy();
    // The first submission claimed from the stale score and was refused; the next, built on the moved one, went in.
    expect(node.submitted).toHaveLength(2);
    const seq = BigInt(JSON.parse(node.submitted[1]).inputs[0].sequence);
    expect(seq).toBeGreaterThanOrEqual(50n);
    expect(poolUtxo.blockDaaScore + seq).toBeLessThanOrEqual(now());
  });

  it('a node that keeps refusing the lock on an unchanged pool gives up after LOCK_RETRY, nothing sent but the tries', async () => {
    const d = 6_000_000n;
    const { node, ctx } = chainWithPool(d, '9');
    node.submitImpl = async () => { throw new NodeRejected(LOCK_TEXT); };
    const out = quoteBuy(ctx, inUse, KAS);
    await expect(swap(ctx, signerFor(alice), [alice.address], { side: 'buy', amountIn: KAS, minOut: out, quoted: out })).rejects.toThrow();
    expect(node.submitted).toHaveLength(1 + LOCK_RETRY.tries);
  });
});
