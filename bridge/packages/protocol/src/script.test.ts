// parsePushes reads signature scripts nobody has validated: a block can carry another body of an accepted transaction with any bytes in them.
// Whatever the bytes, it has to end: a parser that loops stops every follower, for good.
import { describe, expect, it } from 'vitest';
import { ScriptError, parsePushes } from './script';

describe('parsePushes on bytes nobody validated', () => {
  it('a 4-byte length with its top bit set is too long, not negative', () => {
    expect(() => parsePushes(Uint8Array.of(0x4e, 0xfb, 0xff, 0xff, 0xff))).toThrow(ScriptError);
    expect(() => parsePushes(Uint8Array.of(0x4e, 0x00, 0x00, 0x00, 0x80))).toThrow(ScriptError);
  });

  it('reads an honest 4-byte push', () => {
    expect(parsePushes(Uint8Array.of(0x4e, 2, 0, 0, 0, 7, 8))).toEqual([Uint8Array.of(7, 8)]);
  });

  it('ends on every short script of the length opcodes, and on random bytes', () => {
    let seed = 12345;
    const next = () => { seed = (seed * 1_103_515_245 + 12_345) & 0x7fffffff; return seed; };
    const scripts: Uint8Array[] = [];
    for (const op of [0x4c, 0x4d, 0x4e]) for (const a of [0x00, 0x01, 0x7f, 0x80, 0xff]) for (const b of [0x00, 0x80, 0xff]) scripts.push(Uint8Array.of(op, a, b, 0xff, 0xff, a, b));
    for (let k = 0; k < 20_000; k++) scripts.push(Uint8Array.from({ length: next() % 40 }, () => (next() % 3 === 0 ? 0x4c + (next() % 3) : next() % 256)));
    for (const s of scripts) {
      let pushes = 0;
      try { pushes = parsePushes(s).length; } catch (e) { expect(e).toBeInstanceOf(ScriptError); }
      expect(pushes).toBeLessThanOrEqual(s.length);
    }
  }, 30_000);
});
