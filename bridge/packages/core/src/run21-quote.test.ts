// Run 21, outside review (Daybreak [41]): a quote or a pool transaction on a state with no price or no breaker window,
// or of an amount below zero, answers an error. The core divided by zero there, which in WebAssembly is a trap
// (`unreachable`), not an answer: a page or a wallet that quoted such public data lost its core call with it.
import { describe, expect, it } from 'vitest';
import { core, CoreError } from './index';

const opened = {
  tokenCovid: '11'.repeat(32), kasReserve: 1_000_000_000_000, tokenReserve: 1_000_000_000, totalShares: 1_000_000_000_000, protocolKas: 0, protocolTokens: 0,
  baseValue: 100_000_000, admin: '33'.repeat(32), maxOutBps: 1_000, windowLen: 36_000, windowCredit: 0, windowRef: 1_000_000_000_000, windowOut: 0, paused: false,
  guardian: '44'.repeat(32),
};
/** What pool genesis leaves: no shares, no reserves. */
const never = { ...opened, kasReserve: 0, tokenReserve: 0, totalShares: 0, windowRef: 0 };
/** Below zero, and 1 000 000 000 000 (the KAS reserve) once the 0.50 % fee is taken: the buy quote's denominator is zero. */
const CANCELS_KAS = -1_005_025_125_629;

describe('Daybreak [41]: the core answers an error where it trapped', () => {
  const cases: [string, string, unknown, RegExp][] = [
    ['buy 1 sompi, a pool before its first deposit', 'quote', { kind: 'buy', pool: never, kasIn: 1 }, /no liquidity/],
    ['add, a pool before its first deposit', 'quote', { kind: 'add', pool: never, kasIn: 1_000, tokensIn: 1_000 }, /no liquidity/],
    ['remove, a pool before its first deposit', 'quote', { kind: 'remove', pool: never, shares: 1 }, /no liquidity/],
    ['sell with a clock, windowLen 0', 'quote', { kind: 'sell', pool: { ...opened, windowLen: 0 }, tokensIn: 1_000, nowDaa: 10, poolDaa: 5 }, /windowLen 0/],
    ['buy, kasIn below zero that cancels the reserve', 'quote', { kind: 'buy', pool: opened, kasIn: CANCELS_KAS }, /below zero/],
  ];
  for (const [name, command, request, why] of cases) {
    it(`${name}: an error, not a trap`, () => {
      expect(() => core.call(command, request)).toThrow(CoreError);
      expect(() => core.call(command, request)).toThrow(why);
    });
  }

  it('and goes on answering: an opened pool is quoted as before', () => {
    const effective = (1_000_000_000n * 9_950n) / 10_000n;
    expect(BigInt(core.call('quote', { kind: 'buy', pool: opened, kasIn: 1_000_000_000 }).value.tokensOut)).toBe((1_000_000_000n * effective) / (1_000_000_000_000n + effective));
    expect(BigInt(core.call('quote', { kind: 'buy', pool: opened, kasIn: 0 }).value.tokensOut)).toBe(0n);
  });
});
