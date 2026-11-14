// Round 10, finding 2: one lying EVM RPC of the wallet's two could set the
// priority fee, up to the 500 gwei cap, and the screen never showed a fee.
// Now every endpoint is asked and the lowest tip is taken, the tip is capped
// against the base fee, and a deposit is held to the maximum the screen showed.

import { describe, expect, it } from 'vitest';
import { EthRpc, TIP_FLOOR, tipCap } from '@/evm/rpc';
import { APPROVE_GAS_ALLOWANCE, DEPOSIT_GAS_ALLOWANCE, FeeAboveShown, deposit, depositFeeMax, feeMaxText } from '@/evm/vault';
import { GWEI, fakeEvm } from './fake-evm';

const HONEST = 'http://honest.test', LIAR = 'http://liar.test';
const hex = (n: bigint) => '0x' + n.toString(16);
/** An endpoint that answers every tip question with `tip`. */
const lyingTip = (tip: bigint) => (url: string, method: string) => {
  if (url !== LIAR) return undefined;
  if (method === 'eth_maxPriorityFeePerGas') return hex(tip);
  if (method === 'eth_feeHistory') return { baseFeePerGas: [hex(GWEI), hex(GWEI)], reward: [[hex(tip)], [hex(tip)], [hex(tip)]] };
  return undefined;
};
const rpcOf = (evm: ReturnType<typeof fakeEvm>, urls = [HONEST, LIAR]) => new EthRpc(urls, 31337, 'Test chain', 'ETH', evm.fetch);

const what = (rpc: EthRpc) => ({
  rpc, vault: '0x' + 'bb'.repeat(20), token: '0x' + 'aa'.repeat(20), decimals: 6, resetAllowanceFirst: true,
  from: '0x' + 'cc'.repeat(20), units: 100_000_000n, ownerScheme: 0, ownerHex: 'dd'.repeat(32), minMinted: 0n,
});

describe('the priority fee', () => {
  it('is not the one a single lying endpoint names, whichever of the two it is', async () => {
    const evm = fakeEvm({ over: lyingTip(498n * GWEI) });
    // Asked many times: before, the rotation gave the liar its turn and the higher tip won.
    for (const urls of [[HONEST, LIAR], [LIAR, HONEST]]) {
      const rpc = rpcOf(evm, urls);
      for (let i = 0; i < 4; i++) {
        const f = await rpc.fees();
        expect(f.maxPriorityFeePerGas).toBe(GWEI);
        expect(f.maxFeePerGas).toBe(3n * GWEI);
      }
    }
  });

  it('is capped against the base fee even when every endpoint names a high one', async () => {
    expect(tipCap(GWEI)).toBe(TIP_FLOOR);
    expect(tipCap(0n)).toBe(3n * GWEI); // BNB Chain: no base fee
    expect(tipCap(40n * GWEI)).toBe(40n * GWEI);
    const low = await rpcOf(fakeEvm({ tip: 498n * GWEI })).fees();
    expect(low.maxPriorityFeePerGas).toBe(3n * GWEI);
    expect(low.maxFeePerGas).toBe(5n * GWEI);
    const busy = await rpcOf(fakeEvm({ baseFee: 40n * GWEI, tip: 100n * GWEI })).fees();
    expect(busy.maxPriorityFeePerGas).toBe(40n * GWEI);
  });

  it('takes the higher base fee but not its tip, and an endpoint that is down or on another chain does not stop it', async () => {
    // Round 15 (R15-CL-1): this asked for the lower base fee, which let one endpoint naming a low one leave every
    // transaction unmined. A higher cap costs nothing on EIP-1559; the tip, which is paid, is still the lowest.
    const higher = fakeEvm({ over: (url, method) => (url === LIAR && method === 'eth_feeHistory' ? { baseFeePerGas: [hex(200n * GWEI)], reward: [[hex(GWEI)]] } : undefined) });
    const f = await rpcOf(higher).fees();
    expect(f.baseFee).toBe(200n * GWEI);
    expect(f.maxPriorityFeePerGas).toBe(GWEI);
    const down = fakeEvm({ over: (url) => { if (url === LIAR) throw new Error('down'); return undefined; } });
    expect((await rpcOf(down).fees()).maxPriorityFeePerGas).toBe(GWEI);
    const elsewhere = fakeEvm({ chainIdOf: (url) => (url === LIAR ? 1 : 31337), over: lyingTip(498n * GWEI) });
    expect((await rpcOf(elsewhere).fees()).maxPriorityFeePerGas).toBe(GWEI);
    const none = fakeEvm({ over: () => { throw new Error('down'); } });
    await expect(rpcOf(none).fees()).rejects.toThrow(/Could not reach Test chain/);
  });

  it('keeps a tip when one endpoint names none', async () => {
    const silent = fakeEvm({ over: (url, method) => {
      if (url !== LIAR) return undefined;
      if (method === 'eth_maxPriorityFeePerGas') throw new Error('method not found');
      if (method === 'eth_feeHistory') return { baseFeePerGas: [hex(GWEI)] };
      return undefined;
    } });
    expect((await rpcOf(silent).fees()).maxPriorityFeePerGas).toBe(GWEI);
  });
});

describe('the maximum network fee of a deposit', () => {
  it('counts the steps the deposit needs now, at the fees of now, with half as much again', async () => {
    // No allowance yet: an approval (estimated: 60 000 × 1.25) and the deposit (its allowance), at 2 × 1 + 1 gwei.
    const fresh = await depositFeeMax(what(rpcOf(fakeEvm())));
    expect(fresh).toBe(((75_000n + DEPOSIT_GAS_ALLOWANCE) * 3n * GWEI * 3n) / 2n);
    // An old allowance on Ethereum: reset (estimated), approval and deposit (their allowances).
    const old = await depositFeeMax(what(rpcOf(fakeEvm({ allowance: 5n }))));
    expect(old).toBe(((75_000n + APPROVE_GAS_ALLOWANCE + DEPOSIT_GAS_ALLOWANCE) * 3n * GWEI * 3n) / 2n);
    // Enough allowance: the deposit alone, on its real estimate.
    const ready = await depositFeeMax(what(rpcOf(fakeEvm({ allowance: 10n ** 20n, gas: 140_000n }))));
    expect(ready).toBe((175_000n * 3n * GWEI * 3n) / 2n);
  });

  it('is what a lying endpoint cannot raise', async () => {
    expect(await depositFeeMax(what(rpcOf(fakeEvm({ over: lyingTip(498n * GWEI) }))))).toBe(await depositFeeMax(what(rpcOf(fakeEvm()))));
  });

  it('is shown rounded up, never under what the deposit is held to', () => {
    expect(feeMaxText(0n)).toBe('0');
    expect(feeMaxText(1n)).toBe('0.000001');
    expect(feeMaxText(1_500_000_000_000_000n)).toBe('0.0015');
    expect(feeMaxText(1_500_000_000_000_001n)).toBe('0.001501');
    expect(feeMaxText(2n * 10n ** 18n)).toBe('2');
    expect(feeMaxText(12n * 10n ** 18n + 10n ** 12n)).toBe('12.000001');
  });

  it('holds the deposit: a step that would pass it is not signed', async () => {
    const evm = fakeEvm();
    const rpc = rpcOf(evm);
    const key = new Uint8Array(32).fill(7);
    // The approval alone costs at most 75 000 × 3 gwei: one wei under that, and nothing is signed.
    await expect(deposit({ ...what(rpc), key, maxNetworkFee: 75_000n * 3n * GWEI - 1n })).rejects.toBeInstanceOf(FeeAboveShown);
    expect(evm.sent).toHaveLength(0);
    // Room for the approval only: it is sent, and the deposit after it is not.
    await expect(deposit({ ...what(rpc), key, maxNetworkFee: 75_000n * 3n * GWEI })).rejects.toThrow(/rose above the maximum shown, so nothing more was signed/);
    expect(evm.sent).toHaveLength(1);
  });

  it('lets a deposit through at the maximum the screen showed', async () => {
    const evm = fakeEvm();
    const rpc = rpcOf(evm);
    const r = await deposit({ ...what(rpc), key: new Uint8Array(32).fill(7), maxNetworkFee: await depositFeeMax(what(rpc)) });
    expect(evm.sent).toHaveLength(2);
    expect(r.event.units).toBe(100_000_000n);
  });
});
