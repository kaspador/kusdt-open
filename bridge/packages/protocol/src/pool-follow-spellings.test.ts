// The follower against every spelling of a claim the script engine takes, and the TS breaker math against the
// covenant's own split-limb arithmetic (pool.ag), as a third implementation (from the second review of the pool clock,
// 2026-11-10).
//
// Post-Toccata the engine reads script numbers without the minimal-encoding rule (rusty-kaspa txscript data_stack.rs
// pop_items: deserialize(!covenants_enabled)), and a txid does not commit to signature scripts, so anyone (a relay, a
// miner) can respell `age_daa` in a pool input. require(this.ageDaa >= age_daa) compiles to
// <age> OP_DUP 0 2^32 OP_WITHIN OP_VERIFY OP_CHECKSEQUENCEVERIFY, and CSV reads the RAW bytes (little-endian, masked to
// 32 bits), so the spellings that pass are: zero padding (same value for both) and a negative zero (script value 0; raw
// value 0x80·256^(k-1), masked). Every one must decode to the number the covenant's arithmetic used.
import { describe, expect, it } from 'vitest';
import { core } from '@kusdt/core';
import { bytesToHex, hexToBytes } from '@kusdt/kaspa';
import { afterTick, breakerSettled, followPool, minAge, readScriptNum, parsePushes, type PoolLayouts, type PoolState } from './index';
import { KAS, offlineChain } from './testing/chain';

const contracts = core.call('layout', {}).value.contracts;
const layouts: PoolLayouts = { pool: contracts.Pool, position: contracts.Position, template: core.call('template').value };
const scriptOf = (actor: string, state: unknown) => core.call('script', { actor, state }).value.scriptPublicKey as string;

/** Byte length of the first push in `s` (its opcode included). */
function firstPushLength(s: Uint8Array): number {
  const op = s[0];
  if (op === 0x00 || op === 0x4f || (op >= 0x51 && op <= 0x60)) return 1;
  if (op <= 0x4b) return 1 + op;
  if (op === 0x4c) return 2 + s[1];
  if (op === 0x4d) return 3 + (s[1] | (s[2] << 8));
  throw new Error('unexpected first opcode');
}
const push = (data: Uint8Array) => (data.length === 0 ? Uint8Array.of(0x00) : Uint8Array.of(data.length, ...data));

/** What OP_CHECKSEQUENCEVERIFY requires of the input's sequence for these raw bytes (rusty-kaspa opcodes/mod.rs). */
const csvNeeds = (raw: Uint8Array) => {
  const b = new Uint8Array(8);
  b.set(raw);
  let v = 0n;
  for (let k = 7; k >= 0; k--) v = (v << 8n) | BigInt(b[k]);
  return v & 0xffff_ffffn;
};

// The covenant's arithmetic exactly as pool.ag writes it (64-bit split forms), to set against the TS one-liners.
const BPS = 10_000n;
const shareOfSil = (base: bigint, bps: bigint) => (base / BPS) * bps + ((base % BPS) * bps) / BPS;
function advancedRefSil(reference: bigint, reserve: bigint, elapsed: bigint, length: bigint): bigint {
  let next = reserve;
  if (reserve > reference) {
    let gap = reserve - reference;
    if (gap > reference) gap = reference;
    next = reference + gap;
    if (elapsed < length) next = reference + elapsed * (gap / length) + (elapsed * (gap % length)) / length;
  }
  return next;
}
function settledOutSil(used: bigint, elapsed: bigint, cap: bigint, length: bigint): bigint {
  let next = used;
  if (next < -cap) next = -cap;
  const decay = elapsed * (cap / length) + (elapsed * (cap % length)) / length;
  if (next > 0n) { next -= decay; if (next < 0n) next = 0n; } else if (next < 0n) { next += decay; if (next > 0n) next = 0n; }
  return next;
}
function creditLeftSil(credit: bigint, stored: bigint, settled: bigint): bigint {
  let left = credit;
  if (stored < 0n) { const lapsed = settled - stored; left = 0n; if (credit > lapsed) left = credit - lapsed; }
  return left;
}
const I64 = (1n << 63n) - 1n;

describe("the follower against claim spellings, and the breaker math against the covenant's forms", () => {
  const c = offlineChain('pool-follow-spellings');
  const base = c.at(c.poolGenesis, 0, 'pool', c.poolId).state;
  let n = 0;
  const pool = (s: PoolState, daa: bigint) => ({
    utxo: { transactionId: (++n).toString(16).padStart(64, 'c'), index: 0, amount: s.baseValue + s.kasReserve + s.protocolKas, scriptPublicKey: scriptOf('Pool', s), covenantId: c.poolId, blockDaaScore: daa },
    state: s,
  });
  const used: PoolState = {
    tokenCovid: c.covenantId, kasReserve: 1_000n * KAS, tokenReserve: 50_000_000n, totalShares: 1_000n * KAS, protocolKas: 0n, protocolTokens: 0n,
    baseValue: KAS, admin: base.admin, maxOutBps: 1_000n, windowLen: 36_000n, windowCredit: 0n, windowRef: 1_000n * KAS, windowOut: 90n * KAS, paused: false, guardian: base.guardian,
  };

  it('decodes every age spelling the engine accepts in a tick to the number the covenant used', () => {
    const d = 5_000_000n;
    let checked = 0;
    for (const age of [50n, 127n, 128n, 255n, 256n, 32_767n, 32_768n, 35_999n, 36_000n, 71_999n, 72_000n]) {
      const p = pool(used, d);
      const tick = core.call('pool-tick', { ...c.common(), pool: p, nowDaa: d + age }).value;
      const current = { transactionId: p.utxo.transactionId, index: 0, scriptPublicKey: p.utxo.scriptPublicKey };
      const sig = hexToBytes(tick.transaction.inputs[0].signatureScript);
      const len = firstPushLength(sig);
      const minimal = parsePushes(sig.slice(0, len))[0];
      expect(readScriptNum(minimal)).toBe(age);
      expect(csvNeeds(minimal)).toBe(age);
      // Zero padding up to 8 bytes: the same number to the script and to CSV.
      const spellings: Uint8Array[] = [];
      for (let k = minimal.length + 1; k <= 8; k++) { const b = new Uint8Array(k); b.set(minimal); spellings.push(b); }
      for (const spelled of [minimal, ...spellings]) {
        expect(csvNeeds(spelled)).toBe(age);
        const rewritten = { ...tick.transaction, inputs: tick.transaction.inputs.map((i: any, k: number) => (k === 0 ? { ...i, signatureScript: bytesToHex(new Uint8Array([...push(spelled), ...sig.slice(len)])) } : i)) };
        const move = followPool(tick.txid, rewritten, current, c.poolId, layouts, scriptOf)!;
        expect(move.spend.entry).toBe('tick');
        expect((move.spend as any).ageDaa).toBe(age);
        expect(move.pool.state).toEqual(afterTick(used, age));
        checked++;
      }
    }
    // A negative zero is 0 to the script (and to the follower); CSV then asks for 128, 32 768, 8 388 608 or 2^31 (or 0 once
    // the sign byte is past the 32 masked bits): never less than the claim, so a respelling can only make a lock stricter.
    for (const k of [1, 2, 3, 4, 5, 8]) {
      const negZero = new Uint8Array(k);
      negZero[k - 1] = 0x80;
      expect(readScriptNum(negZero)).toBe(0n);
      expect(csvNeeds(negZero) >= 0n).toBe(true);
    }
    expect(checked).toBeGreaterThan(50);
  });

  it('the TS one-line breaker math equals the covenant\'s split-limb forms on random states up to the operand limit', () => {
    let s = 0x9e3779b97f4a7c15n;
    const next = () => { s ^= (s << 13n) & ((1n << 64n) - 1n); s ^= s >> 7n; s ^= (s << 17n) & ((1n << 64n) - 1n); return s; };
    const below = (m: bigint) => (m <= 0n ? 0n : next() % m);
    const MAX = (1n << 61n) - 1n;
    let compared = 0, skipped = 0;
    for (let i = 0; i < 20_000; i++) {
      const length = [36_000n, 720n, 719n, 1n, 100_000n][i % 5];
      const bps = [1_000n, 10_000n, 1n, 9_999n][i % 4];
      const x = 1n + below([MAX, 1n << 40n, 10_000n][i % 3]);
      const ref = 1n + below(x);
      const cap0 = shareOfSil(ref, bps);
      const out = below(4n * cap0 + 3n) - 2n * cap0 - 1n;
      const credit = below(3n * cap0 + 1n);
      const age = below(2n * length + 1n);
      const p: PoolState = { ...used, kasReserve: x, windowRef: ref, windowOut: out, windowCredit: credit, maxOutBps: bps, windowLen: length };
      // The covenant aborts on any 64-bit overflow: such a spend never exists, so nothing to follow.
      const nref = advancedRefSil(ref, x, age, length);
      const cap = shareOfSil(nref, bps);
      const decayTerm = age * (cap / length) + age * (cap % length);
      if (nref > I64 || decayTerm > I64 || age * (((x - ref) < ref ? x - ref : ref) % length) > I64) { skipped++; continue; }
      const settled = settledOutSil(out, age, cap, length);
      const sil = { windowRef: nref, windowOut: settled, windowCredit: creditLeftSil(credit, out, settled) };
      expect(breakerSettled(p, age)).toEqual(sil);
      expect(minAge(p)).toBe(length / 720n < 1n ? 1n : length / 720n);
      compared++;
    }
    console.log(`breaker math: ${compared} random states equal, ${skipped} the covenant could not compute`);
    expect(compared).toBeGreaterThan(15_000);
  });
});
