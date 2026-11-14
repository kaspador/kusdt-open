import { describe, expect, it } from 'vitest';
import { keccak_256 } from '@noble/hashes/sha3.js';
import { bytesToHex } from '@kusdt/kaspa';
import artifact from '../../../bridge/evm/artifacts/contracts/KusdtVault.sol/KusdtVault.json';
import { approvalSteps, approveData, depositData, depositEventOf, minMintedOf, DEPOSIT_TOPIC, tokenAmount, unitsOf, DEPOSIT_SIGNATURE, DEPOSIT_EVENT } from '@/evm/vault';
import { selector } from '@/evm/abi';
import { chainFees, feeOf } from '@/kusdt/api';

const sig = (item: { name: string; inputs: { type: string }[] }) => `${item.name}(${item.inputs.map(i => i.type).join(',')})`;

describe('KusdtVault calls', () => {
  it('deposit() and the Deposit event are the ones in the vault ABI', () => {
    const abi = artifact.abi as any[];
    expect(abi.some(i => i.type === 'function' && sig(i) === DEPOSIT_SIGNATURE)).toBe(true);
    expect(abi.some(i => i.type === 'event' && sig(i) === DEPOSIT_EVENT)).toBe(true);
    expect(DEPOSIT_TOPIC).toBe('0x' + bytesToHex(keccak_256(new TextEncoder().encode(DEPOSIT_EVENT))));
  });

  it('encodes depositAtLeast(units, ownerScheme, owner, minMinted) word by word', () => {
    const owner = '11'.repeat(32);
    const data = depositData(25_000_000n, 0, owner, 24_800_000n);
    expect(data.slice(0, 10)).toBe(selector(DEPOSIT_SIGNATURE));
    const words = data.slice(10).match(/.{64}/g)!;
    expect(words).toEqual([(25_000_000n).toString(16).padStart(64, '0'), '0'.repeat(64), owner, (24_800_000n).toString(16).padStart(64, '0')]);
    expect(() => depositData(25_000_000n, 0, owner, 25_000_000n)).toThrow();
    expect(minMintedOf(24_875_000n, 25_000_000n)).toBe(24_875_000n - 62_500n);
    expect(minMintedOf(10n, 25_000_000n)).toBe(0n);
    expect(() => depositData(1n, 0, '00'.repeat(32), 0n)).toThrow();
    expect(() => depositData(1n, 9, owner, 0n)).toThrow();
  });

  it("Ethereum USDT: a non-zero allowance is reset to 0 first; approvals are exact, never unlimited", () => {
    const t = '0x' + 'aa'.repeat(20), v = '0x' + 'bb'.repeat(20);
    expect(approvalSteps(t, v, 0n, 100n, true)).toEqual([{ to: t, data: approveData(v, 100n) }]);
    expect(approvalSteps(t, v, 5n, 100n, true)).toEqual([{ to: t, data: approveData(v, 0n) }, { to: t, data: approveData(v, 100n) }]);
    expect(approvalSteps(t, v, 5n, 100n, false)).toEqual([{ to: t, data: approveData(v, 100n) }]);
    expect(approvalSteps(t, v, 100n, 100n, true)).toEqual([]);
  });

  it('converts units to token amounts by decimals (SPEC §3)', () => {
    expect(tokenAmount(1_500_000n, 6)).toBe(1_500_000n);
    expect(tokenAmount(1_500_000n, 18)).toBe(1_500_000_000_000_000_000n);
    expect(unitsOf(1_500_000_999_999_999_999n, 18)).toBe(1_500_000n);
  });

  it("reads the Deposit event of the vault's receipt", () => {
    const vault = '0x' + 'cd'.repeat(20);
    const w = (n: bigint) => n.toString(16).padStart(64, '0');
    const log = {
      address: vault.toUpperCase().replace('0X', '0x'),
      topics: [DEPOSIT_TOPIC, '0x' + w(7n), '0x' + '00'.repeat(12) + 'ef'.repeat(20)],
      data: '0x' + w(0n) + '22'.repeat(32) + w(10_000_000n) + w(500_000n) + w(9_500_000n),
    };
    expect(depositEventOf([log], vault)).toEqual({ nonce: 7n, sender: '0x' + 'ef'.repeat(20), ownerScheme: 0, owner: '22'.repeat(32), units: 10_000_000n, fee: 500_000n, minted: 9_500_000n });
    expect(depositEventOf([{ ...log, address: '0x' + '00'.repeat(20) }], vault)).toBeNull();
  });
});

describe('fees from /status', () => {
  it('reads the shapes a coordinator may give, and computes SPEC §7 fees', () => {
    expect(chainFees({ fees: { ethereum: { feeBps: 20, minDepositFee: 500000, minReleaseFee: 5000000 } } }, 'ethereum')).toEqual({ feeBps: 20n, minDepositFee: 500000n, minReleaseFee: 5000000n });
    expect(chainFees({ fees: { feeBps: 20, minDepositFee: 500000, minReleaseFee: { ethereum: 5000000, bsc: 500000 } } }, 'bsc')).toEqual({ feeBps: 20n, minDepositFee: 500000n, minReleaseFee: 500000n });
    expect(chainFees({ chains: [{ chain: 2, fees: { feeBps: 20, minDepositFee: '1', minReleaseFee: '2' } }] }, 'bsc')).toEqual({ feeBps: 20n, minDepositFee: 1n, minReleaseFee: 2n });
    expect(chainFees({}, 'bsc')).toBeNull();
    expect(feeOf(100_000_000n, 20n, 5_000_000n)).toBe(5_000_000n);
    expect(feeOf(10_000_000_000n, 20n, 500_000n)).toBe(20_000_000n);
    expect(feeOf(1_000_001n, 20n, 0n)).toBe(2_001n); // rounded up
  });
});
