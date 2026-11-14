// Round 15, R15-CL-1: the wallet took the lowest base fee any of its EVM RPCs
// named, so one lying or lagging endpoint naming 1 wei and a tip of 0 had every
// deposit signed at a fee cap of 2 wei, never mined. Now the highest base fee is
// signed (a higher cap costs nothing: only the real base fee and the tip are
// paid), the tip is still the lowest but never under a floor for the chain, and
// endpoints that disagree are named on the screen.

import { describe, expect, it } from 'vitest';
import { EthRpc, MAX_FEE_PER_GAS, minTip, feeSpreadNote } from '@/evm/rpc';
import { depositFeeQuote, prepareTx } from '@/evm/vault';
import { GWEI, fakeEvm } from './fake-evm';

const HONEST = 'http://honest.test', LIAR = 'http://liar.test';
const hex = (n: bigint) => '0x' + n.toString(16);
/** An endpoint that names `baseFee` as the base fee of the latest and the next block, and `tip` everywhere. */
const liar = (baseFee: bigint, tip: bigint) => (url: string, method: string) => {
  if (url !== LIAR) return undefined;
  if (method === 'eth_maxPriorityFeePerGas') return hex(tip);
  if (method === 'eth_feeHistory') return { baseFeePerGas: [hex(baseFee), hex(baseFee)], reward: [[hex(tip)]] };
  if (method === 'eth_getBlockByNumber') return { baseFeePerGas: hex(baseFee) };
  return undefined;
};
const both = [[HONEST, LIAR], [LIAR, HONEST]];
const rpcOf = (evm: ReturnType<typeof fakeEvm>, urls: string[], chainId = 31337) =>
  new EthRpc(urls, chainId, 'Test chain', 'ETH', evm.fetch);
const ETH_LIKE = 31337, BNB_LIKE = 31338;

describe('a lying endpoint naming a low base fee', () => {
  it('does not set the fee cap on an Ethereum-like chain, in either order', async () => {
    const evm = fakeEvm({ baseFee: 30n * GWEI, over: liar(1n, 0n) });
    for (const urls of both) {
      const f = await rpcOf(evm, urls).fees();
      expect(f.baseFee).toBe(30n * GWEI);
      // The lowest tip is still taken (round 10), but never under the floor: a tip of 0 is not signed.
      expect(f.maxPriorityFeePerGas).toBe(minTip(ETH_LIKE));
      expect(f.maxFeePerGas).toBe(60n * GWEI + minTip(ETH_LIKE));
      expect(f.spread?.low.baseFee).toBe(1n);
      expect(f.spread?.high.baseFee).toBe(30n * GWEI);
    }
  });

  it('does not leave a fee cap of 0 on a chain with no base fee (BNB Chain)', async () => {
    const evm = fakeEvm({ baseFee: 0n, tip: GWEI / 10n, chainIdOf: () => BNB_LIKE, over: liar(0n, 0n) });
    for (const urls of both) {
      const f = await rpcOf(evm, urls, BNB_LIKE).fees();
      expect(minTip(BNB_LIKE)).toBe(GWEI / 20n);
      expect(f.maxPriorityFeePerGas).toBe(GWEI / 20n);
      expect(f.maxFeePerGas).toBe(GWEI / 20n);
      // 0 against 0 is no disagreement.
      expect(f.spread).toBeNull();
    }
  });

  it('is not what prepareTx signs', async () => {
    const evm = fakeEvm({ baseFee: 30n * GWEI, over: liar(1n, 0n) });
    for (const urls of both) {
      const p = await prepareTx(rpcOf(evm, urls), '0x' + 'cc'.repeat(20), { to: '0x' + 'aa'.repeat(20), data: '0x' });
      expect(p.tx.maxFeePerGas).toBeGreaterThanOrEqual(60n * GWEI);
      expect(p.tx.maxPriorityFeePerGas).toBeGreaterThan(0n);
    }
  });

  it('is not hidden behind its own fee history: the latest block\'s base fee bounds the next one from below', async () => {
    // One endpoint alone (no other to compare with) whose history ends in a next base fee far under its latest block's.
    const evm = fakeEvm({ over: (_url, method) => (method === 'eth_feeHistory' ? { baseFeePerGas: [hex(30n * GWEI), hex(1n)], reward: [[hex(GWEI)]] } : undefined) });
    expect((await rpcOf(evm, [HONEST]).fees()).baseFee).toBe(30n * GWEI);
  });
});

describe('a lying endpoint naming a high base fee', () => {
  it('raises only the cap, never the tip, and the screen names the endpoints that disagree', async () => {
    const evm = fakeEvm({ baseFee: 30n * GWEI, over: liar(200n * GWEI, 100n * GWEI) });
    for (const urls of both) {
      const f = await rpcOf(evm, urls).fees();
      expect(f.baseFee).toBe(200n * GWEI);
      expect(f.maxPriorityFeePerGas).toBe(GWEI);
      const note = feeSpreadNote('Test chain', f.spread);
      expect(note).toMatch(/liar\.test names a base fee of 200 gwei, honest\.test 30 gwei/);
      expect(note).toMatch(/only the real base fee/);
      expect(note).not.toMatch(new RegExp(String.fromCharCode(0x2014)));
    }
  });

  it('does not lift the tip cap: with the honest endpoint naming no tip, the liar\'s tip is held to the honest base fee', async () => {
    const evm = fakeEvm({ baseFee: 30n * GWEI, over: (url, method) => {
      if (url === HONEST && method === 'eth_maxPriorityFeePerGas') throw new Error('method not found');
      if (url === HONEST && method === 'eth_feeHistory') return { baseFeePerGas: [hex(30n * GWEI), hex(30n * GWEI)] };
      return liar(200n * GWEI, 200n * GWEI)(url, method);
    } });
    for (const urls of both) {
      const f = await rpcOf(evm, urls).fees();
      expect(f.baseFee).toBe(200n * GWEI);
      expect(f.maxPriorityFeePerGas).toBe(30n * GWEI);
    }
  });

  it('above what the wallet ever signs is refused, naming both endpoints, and nothing lower is used instead', async () => {
    const evm = fakeEvm({ baseFee: 30n * GWEI, over: liar(MAX_FEE_PER_GAS, GWEI) });
    for (const urls of both) {
      await expect(rpcOf(evm, urls).fees()).rejects.toThrow(/liar\.test names a base fee of 500 gwei, honest\.test 30 gwei/);
    }
  });

  it('is told in the deposit quote, and the balance refusal names it too', async () => {
    const evm = fakeEvm({ baseFee: 30n * GWEI, over: (url, method, params) => {
      if (method === 'eth_getBalance') return hex(5n * 10n ** 15n); // 0.005 ETH: enough at 30 gwei, not at 200
      return liar(200n * GWEI, GWEI)(url, method);
    } });
    const rpc = rpcOf(evm, [HONEST, LIAR]);
    const q = await depositFeeQuote({
      rpc, vault: '0x' + 'bb'.repeat(20), token: '0x' + 'aa'.repeat(20), decimals: 6, resetAllowanceFirst: false,
      from: '0x' + 'cc'.repeat(20), units: 100_000_000n, ownerScheme: 0, ownerHex: 'dd'.repeat(32), minMinted: 0n,
    });
    expect(q.note).toMatch(/disagree/);
    await expect(prepareTx(rpc, '0x' + 'cc'.repeat(20), { to: '0x' + 'aa'.repeat(20), data: '0x' })).rejects.toThrow(/Not enough ETH .*liar\.test names a base fee of 200 gwei/);
  });
});

describe('honest endpoints', () => {
  it('a little apart (one a few blocks behind) are not called a disagreement, and the higher is signed', async () => {
    const evm = fakeEvm({ baseFee: 30n * GWEI, over: liar(20n * GWEI, GWEI) });
    const f = await rpcOf(evm, [HONEST, LIAR]).fees();
    expect(f.baseFee).toBe(30n * GWEI);
    expect(f.spread).toBeNull();
    expect(feeSpreadNote('Test chain', f.spread)).toBeNull();
  });

  it('naming a tip above the floor keep their own', async () => {
    const f = await rpcOf(fakeEvm({ tip: GWEI / 2n }), [HONEST]).fees();
    expect(f.maxPriorityFeePerGas).toBe(GWEI / 2n);
  });
});
