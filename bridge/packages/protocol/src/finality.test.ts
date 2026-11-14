// Amount-scaled burn finality (SPEC §10): larger burns wait deeper.

import { describe, expect, it } from 'vitest';
import { MAINNET_FINALITY_TIERS, burnFinalityDaa, finalityTiersProblem } from './deployment';

const USDT = 1_000_000n;

describe('burn finality', () => {
  const mainnet = { finalityDaa: 1_000, finalityTiers: MAINNET_FINALITY_TIERS };
  it('takes the deepest tier a burn is above, and finalityDaa below every tier', () => {
    expect(burnFinalityDaa(mainnet, 1n)).toBe(1_000);
    expect(burnFinalityDaa(mainnet, 10_000n * USDT)).toBe(1_000);
    expect(burnFinalityDaa(mainnet, 10_000n * USDT + 1n)).toBe(6_000);
    expect(burnFinalityDaa(mainnet, 100_000n * USDT)).toBe(6_000);
    expect(burnFinalityDaa(mainnet, 100_000n * USDT + 1n)).toBe(36_000);
    expect(burnFinalityDaa(mainnet, 250_000n * USDT)).toBe(36_000);
  });
  it('without tiers, every burn waits finalityDaa', () => {
    expect(burnFinalityDaa({ finalityDaa: 300 }, 250_000n * USDT)).toBe(300);
  });
  it('never goes below finalityDaa, even for a shallow tier', () => {
    expect(burnFinalityDaa({ finalityDaa: 500, finalityTiers: [{ above: '0', daa: 100 }] }, 5n)).toBe(500);
  });
  it('refuses malformed tiers', () => {
    expect(finalityTiersProblem(mainnet)).toBeNull();
    expect(finalityTiersProblem({ finalityDaa: 1_000 })).toBeNull();
    expect(finalityTiersProblem({ finalityDaa: 1_000, finalityTiers: [{ above: '10', daa: 900 }] })).toMatch(/deeper/);
    expect(finalityTiersProblem({ finalityDaa: 1_000, finalityTiers: [{ above: '10', daa: 2_000 }, { above: '5', daa: 3_000 }] })).toMatch(/rise/);
    expect(finalityTiersProblem({ finalityDaa: 1_000, finalityTiers: [{ above: 10 as any, daa: 2_000 }] })).toMatch(/string/);
    expect(finalityTiersProblem({ finalityDaa: 1_000, finalityTiers: [{ above: '-1', daa: 2_000 }] })).toMatch(/whole/);
    expect(finalityTiersProblem({ finalityDaa: 1.5 })).toMatch(/whole/);
  });
});
