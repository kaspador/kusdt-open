// Audit 3, Ethereum: the wallet's own approve against the live gas schedule.
// Run: npx vitest run test/audit3-eth.test.ts (in wallet/extension).
// Tests marked "// BUG:" fail on purpose: each proves a defect (see audit/ethereum.md).
import { describe, expect, it } from 'vitest';
import { Transaction } from 'ethers';
import { deposit } from '@/evm/vault';

const word = (v: bigint) => '0x' + v.toString(16).padStart(64, '0');

describe('deposit(): the approve step', () => {
  // BUG: wallet/extension/src/evm/vault.ts sends every approve with a fixed gas limit of 100 000. Glamsterdam (EIP-8037, live on Sepolia
  // since 2026-10-06, activation on mainnet undecided) charges 97 920 state gas for a new storage slot. A live estimate of approve on
  // Sepolia today answers 129 370, and eth_call of it with gas 100 000 answers "out of gas: gas required exceeds: 100000" (audit/ethereum.md).
  // The first approve of every deposit creates that slot, so once the fork is on mainnet the wallet's approve reverts, the fee is
  // spent and the deposit never starts. The fix: use the estimate like every other transaction (`rpc.estimateGas(...) * 125n / 100n`).
  it('an approve is sent with the gas it needs, not a fixed 100 000', async () => {
    const raws: string[] = [];
    const rpc: any = {
      chainId: 1,
      name: 'test',
      gasSymbol: 'ETH',
      assertChain: async () => {},
      fees: async () => ({ maxFeePerGas: 100n, maxPriorityFeePerGas: 1n, baseFee: 1n }),
      nonce: async () => 0,
      balance: async () => 10n ** 18n,
      estimateGas: async () => 129_370n, // the live answer on Sepolia, the Amsterdam rules of EIP-8037
      ethCall: async (_to: string, data: string) => (data.startsWith('0x70a08231') ? word(10n ** 12n) : word(0n)), // balanceOf: plenty; allowance: none
      sendRaw: async (raw: string) => { raws.push(raw); throw new Error('stop after the first transaction'); },
      knows: async () => false,
    };
    await expect(deposit({
      rpc, vault: '0x' + 'bb'.repeat(20), token: '0x' + 'aa'.repeat(20), decimals: 6, resetAllowanceFirst: true,
      from: '0x' + 'cc'.repeat(20), key: new Uint8Array(32).fill(7), units: 100n * 10n ** 6n, ownerScheme: 0, ownerHex: 'dd'.repeat(32), minMinted: 0n, maxNetworkFee: 10n ** 18n,
    })).rejects.toThrow('stop after the first transaction');
    expect(raws).toHaveLength(1);
    expect(Transaction.from(raws[0]).gasLimit).toBeGreaterThanOrEqual(129_370n);
  });

  // USDT refuses approve(x) over a non-zero allowance, so the second step's estimate needs the first step's block.
  it('the step after a mined approval waits out an RPC a block behind', async () => {
    const raws: string[] = [];
    let estimates = 0;
    const rpc: any = {
      chainId: 1, name: 'test', gasSymbol: 'ETH', assertChain: async () => {},
      fees: async () => ({ maxFeePerGas: 100n, maxPriorityFeePerGas: 1n, baseFee: 1n }),
      nonce: async () => raws.length, balance: async () => 10n ** 18n,
      estimateGas: async () => { estimates += 1; if (estimates === 2) throw new Error('execution reverted'); return 60_000n; },
      ethCall: async (_to: string, data: string) => (data.startsWith('0x70a08231') ? word(10n ** 12n) : word(5n)), // an old allowance of 5
      sendRaw: async (raw: string) => { raws.push(raw); if (raws.length === 2) throw new Error('stop at the second approval'); return Transaction.from(raw).hash; },
      knows: async () => false, receipt: async () => ({ ok: true, logs: [] }),
    };
    await expect(deposit({
      rpc, vault: '0x' + 'bb'.repeat(20), token: '0x' + 'aa'.repeat(20), decimals: 6, resetAllowanceFirst: true,
      from: '0x' + 'cc'.repeat(20), key: new Uint8Array(32).fill(7), units: 100n * 10n ** 6n, ownerScheme: 0, ownerHex: 'dd'.repeat(32), minMinted: 0n, maxNetworkFee: 10n ** 18n,
    })).rejects.toThrow('stop at the second approval');
    expect(raws).toHaveLength(2);
    expect(estimates).toBe(3);
  }, 10_000);
});
