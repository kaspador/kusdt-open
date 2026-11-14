// Audit 3 (Kaspa rules): the node's fee estimate is an f64 (rusty-kaspa
// mining/src/feerate/mod.rs: `high = time_to_feerate(..).max(min)`, the normal
// and low buckets come from `quantile` and powf: a whole number only while the
// mempool is nearly empty). The wallet's clampFeerate keeps the fraction
// (bridge/packages/kaspa/src/build.ts:34) and passes it to every covenant
// builder, whose `feerate` field is an integer (bridge/kaspa/src/tx.rs:92), so
// every swap, burn, transfer and liquidity move fails to build at any
// non-whole estimate, i.e. whenever the mempool has a backlog.
//
// `proof_*` is expected to FAIL while the finding is open.

import { describe, expect, it } from 'vitest';
import { clampFeerate } from '@kusdt/kaspa';
import { FakeNode, COVENANT, POOL, devKey, fakeApi, testCtx, signerFor, kasCoin, lastBuilt } from './helpers';
import { p2shAddressOf, poolValue, reserveStateOf, scriptOf } from '@/kusdt/verify';
import { POOL_WAIT, minimumFor, quoteBuy, swap } from '@/kusdt/pool';
import type { PoolState } from '@/kusdt/types';

const alice = devKey('alice');
POOL_WAIT.ms = 0;
POOL_WAIT.perDaaMs = 0;
const KAS = 100_000_000n;
const pool: PoolState = {
  tokenCovid: COVENANT, kasReserve: 200n * KAS, tokenReserve: 20_000_000n, totalShares: 200n * KAS, protocolKas: 0n, protocolTokens: 0n,
  baseValue: KAS, admin: '11'.repeat(32), maxOutBps: 1_000n, windowLen: 36_000n, windowCredit: 0n, windowRef: 0n, windowOut: 0n, paused: false, guardian: '22'.repeat(32),
};

function setup(feerate: number) {
  const node = new FakeNode();
  node.feerate = async () => feerate;
  const txid = '77'.repeat(32);
  const ctx = testCtx(node, fakeApi({
    pool: async () => {
      const pspk = scriptOf(ctx, 'Pool', pool);
      if (!node.utxoSet.some(u => u.transactionId === txid)) {
        node.utxoSet.push({ address: p2shAddressOf(pspk, 'kaspasim'), transactionId: txid, index: 0, amount: poolValue(pool), scriptPublicKey: pspk, blockDaaScore: 999_990n, isCoinbase: false, covenantId: POOL });
        const reserve = reserveStateOf(POOL, pool);
        const rspk = scriptOf(ctx, 'KCC20', reserve);
        node.utxoSet.push({ address: p2shAddressOf(rspk, 'kaspasim'), transactionId: txid, index: 1, amount: 150_000_000n, scriptPublicKey: rspk, blockDaaScore: 1n, isCoinbase: false, covenantId: COVENANT });
      }
      return { pool: { utxo: { transactionId: txid, index: 0 }, state: pool }, reserve: { utxo: { transactionId: txid, index: 1 }, state: reserveStateOf(POOL, pool) } };
    },
  }));
  node.utxoSet.push(kasCoin(alice, 'e1'.repeat(32), 1_000n * KAS), kasCoin(alice, 'e2'.repeat(32), 1_000n * KAS));
  return { node, ctx };
}

async function buy(feerate: number) {
  const { node, ctx } = setup(feerate);
  const kasIn = 10n * KAS;
  const seen = quoteBuy(ctx, pool, kasIn);
  const result = await swap(ctx, signerFor(alice), [alice.address], { side: 'buy', amountIn: kasIn, minOut: minimumFor(seen, 100), quoted: seen });
  return { node, result };
}

describe('the wallet and fractional fee estimates', () => {
  it('builds a swap at a whole-number fee estimate (control)', async () => {
    const { result } = await buy(120);
    expect(result.txid).toBe(lastBuilt.txid);
  });

  it('clampFeerate rounds a fee estimate up to a whole number between the floor and the cap', () => {
    // The estimator's own arithmetic gives values like these; 100 ≤ x ≤ 2 000 is passed through.
    expect(clampFeerate(104.37)).toBe(105);
  });

  it('proof_a_fractional_fee_estimate_still_builds_a_swap', async () => {
    // The estimate a mainnet node would answer with any backlog in its mempool.
    await expect(buy(104.37)).resolves.toBeDefined();
  });
});
