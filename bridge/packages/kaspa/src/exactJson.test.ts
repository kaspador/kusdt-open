// Numbers stay exact in every notation, strings are never touched, and against
// JSON.parse it differs only where a number would have been rounded.
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { parseExactJson, stringifyExact } from './exactJson';

describe('parseExactJson', () => {
  it('keeps an integer exact in whichever notation it came', () => {
    const want = '12345678901234567';
    for (const text of ['12345678901234567', '12345678901234567.0', '12345678901234567.000', '1.2345678901234567e16', '1.2345678901234567E+16', '123456789012345670e-1']) {
      expect(parseExactJson(text)).toBe(want);
      expect(parseExactJson(`{"a":${text}}`)).toEqual({ a: want });
      expect(parseExactJson(`[1, ${text} ,2]`)).toEqual([1, want, 2]);
    }
    expect(parseExactJson('-12345678901234567.0')).toBe('-12345678901234567');
    expect(parseExactJson('1e30')).toBe('1000000000000000000000000000000');
    expect(BigInt(parseExactJson('1.5e20'))).toBe(150000000000000000000n);
  });

  it('leaves as numbers what a number holds exactly, and real fractions', () => {
    expect(parseExactJson('{"a":123456789012345,"b":1.5,"c":-3,"d":0,"e":0.0,"f":1e3,"g":100000000000000.0}'))
      .toEqual({ a: 123456789012345, b: 1.5, c: -3, d: 0, e: 0, f: 1000, g: 100000000000000 });
    expect(parseExactJson('1234567890123456.5')).toBe(1234567890123456.5);
    expect(parseExactJson('1e-7')).toBe(1e-7);
  });

  it('a number too large to be any amount can\'t round or expand: it stays text, which BigInt refuses', () => {
    expect(parseExactJson('1e400')).toBe('1e400');
    expect(() => BigInt(parseExactJson('1e400'))).toThrow();
    expect(parseExactJson('1e999999999')).toBe('1e999999999');
  });

  it('leaves strings alone', () => {
    const s = 'x: 12345678901234567, y [1.5e20] "quoted" \\ end 12345678901234567.0';
    expect(parseExactJson(JSON.stringify({ [s]: s, list: [s] }))).toEqual({ [s]: s, list: [s] });
  });

  it('refuses what isn\'t JSON', () => {
    for (const bad of ['{"a":', '"open', '0123456789012345678', '12345678901234567.', '1e', '-', '1.2.3', '12345678901234567 1', '{"a":1e}']) {
      expect(() => parseExactJson(bad), bad).toThrow();
    }
  });

  it('agrees with JSON.parse on everything a number holds exactly (random documents)', () => {
    let seed = 20261107;
    const rnd = (n: number) => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed % n; };
    const str = () => Array.from({ length: rnd(12) }, () => 'ab1 ,:[]{}"\\/\n.-e7'[rnd(19)]).join('');
    const num = () => [rnd(1000), -rnd(1000), rnd(100000) / 100, rnd(1e9), 0, 1e15 - 1][rnd(6)];
    const value = (depth: number): unknown => {
      const k = rnd(depth > 3 ? 4 : 6);
      if (k === 0) return num();
      if (k === 1) return str();
      if (k === 2) return rnd(2) === 0;
      if (k === 3) return null;
      if (k === 4) return Array.from({ length: rnd(4) }, () => value(depth + 1));
      return Object.fromEntries(Array.from({ length: rnd(4) }, () => [str(), value(depth + 1)]));
    };
    for (let i = 0; i < 2_000; i++) {
      const text = JSON.stringify(value(0), null, rnd(2) * 2);
      expect(parseExactJson(text)).toEqual(JSON.parse(text));
    }
  });
});

describe('stringifyExact', () => {
  it('writes BigInt values as bare digits', () => {
    expect(stringifyExact({ a: 12345678901234567890n, b: [-5n, 1n] })).toBe('{"a":12345678901234567890,"b":[-5,1]}');
    expect(stringifyExact(7n)).toBe('7');
  });

  it('a string that looks like the old marker stays that string', () => {
    expect(JSON.parse(stringifyExact({ a: '@@bigint:123', '@@bigint:5': 1 })!)).toEqual({ a: '@@bigint:123', '@@bigint:5': 1 });
  });

  it('writes what JSON.stringify writes for everything else', () => {
    const samples: unknown[] = [
      { a: 1, b: 'x"y\n', c: null, d: undefined, e: [undefined, () => 1, 2], f: { g: true } },
      [], {}, 'text', 0, -1.5, true, null, new Date(0), { toJSON: () => ({ h: 1 }) }, [NaN, Infinity], { z: 1, a: 2 },
    ];
    for (const s of samples) expect(stringifyExact(s)).toBe(JSON.stringify(s));
    expect(stringifyExact(undefined)).toBeUndefined();
  });

  it('reads back exactly', () => {
    const v = { units: 12345678901234567890n, note: '@@bigint:1, 12345678901234567,' };
    expect(parseExactJson(stringifyExact(v)!)).toEqual({ units: '12345678901234567890', note: v.note });
  });
});

describe('the two copies', () => {
  it('core\'s and kaspa\'s are the same file', () => {
    const copy = (p: string) => readFileSync(new URL(p, import.meta.url), 'utf8');
    expect(copy('../../core/src/exactJson.ts')).toBe(copy('./exactJson.ts'));
  });
});
