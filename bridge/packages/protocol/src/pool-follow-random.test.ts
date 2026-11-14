// The follower against the core's builders on random breaker states (from the 2026-11-10 review of the pool clock).
//
// A pool spend the follower can't verify is a monitor alarm, and any open alarm pauses the whole bridge (monitor.ts
// pauseAll). So for every valid tick, add and remove the follower must compute exactly the successor the covenant forces.
// The builders' successors are checked against the script engine in the Rust tests; here the follower is checked against
// the builders on random breaker states: negative and positive counts, credit, a reference below the reserve, claims from
// the least to two windows (none at or below half of the cap, and none for a withdrawal while paused), withdrawals that
// shrink the pool below its reference (the two-cap cut) and ones that don't.
import { describe, expect, it } from 'vitest';
import { core } from '@kusdt/core';
import { bytesToHex } from '@kusdt/kaspa';
import { MIN_LIQUIDITY, afterAdd, afterRemove, afterTick, followPool, leastClaim, leastRemoveClaim, minAge, reserveOf, type PoolLayouts, type PoolState } from './index';
import { KAS, POSITION_VALUE, TOKEN_VALUE, offlineChain, secret, xonly } from './testing/chain';

const contracts = core.call('layout', {}).value.contracts;
const layouts: PoolLayouts = { pool: contracts.Pool, position: contracts.Position, template: core.call('template').value };
const scriptOf = (actor: string, state: unknown) => core.call('script', { actor, state }).value.scriptPublicKey as string;
const poolOf = (j: any): PoolState => ({
  tokenCovid: j.tokenCovid, kasReserve: BigInt(j.kasReserve), tokenReserve: BigInt(j.tokenReserve), totalShares: BigInt(j.totalShares),
  protocolKas: BigInt(j.protocolKas), protocolTokens: BigInt(j.protocolTokens), baseValue: BigInt(j.baseValue), admin: j.admin,
  maxOutBps: BigInt(j.maxOutBps), windowLen: BigInt(j.windowLen), windowCredit: BigInt(j.windowCredit), windowRef: BigInt(j.windowRef),
  windowOut: BigInt(j.windowOut), paused: Boolean(j.paused), guardian: j.guardian,
});

/** A deterministic generator. */
function rng(seed: number) {
  let s = BigInt(seed) * 6364136223846793005n + 1442695040888963407n;
  const next = () => { s = (s * 6364136223846793005n + 1442695040888963407n) & ((1n << 64n) - 1n); return s >> 11n; };
  return { below: (n: bigint) => (n <= 0n ? 0n : next() % n), pick: <T>(xs: T[]) => xs[Number(next() % BigInt(xs.length))] };
}

describe('the follower against the builders on random breaker states', () => {
  const c = offlineChain('pool-follow-random');
  const alice = secret('pool-follow-random/alice');
  const base = c.at(c.poolGenesis, 0, 'pool', c.poolId).state;
  let txno = 0;
  const outpoint = () => (++txno).toString(16).padStart(64, 'e');
  const located = (actor: 'Pool' | 'Position' | 'KCC20', state: any, amount: bigint, covenantId: string, daa: bigint) =>
    ({ utxo: { transactionId: outpoint(), index: 0, amount, scriptPublicKey: scriptOf(actor, state), covenantId, blockDaaScore: daa }, state });

  function randomState(r: ReturnType<typeof rng>): PoolState {
    const x = r.pick([10n * KAS, 1_000n * KAS, 100_000n * KAS, 50_000_000n * KAS]) + r.below(KAS);
    const y = r.pick([1_000_000n, 1_000_000_000n, 5_000_000_000_000n]) + r.below(1_000n);
    const cap = x / 10n;
    const ref = r.pick([x, x, x / 2n, x / 3n + 1n, 1n + r.below(x)]);
    const out = r.pick([-cap, -(cap / 2n), -1n, 0n, 1n, cap / 3n, ref / 20n, ref / 20n + 1n, cap, 2n * cap, 3n * cap, r.below(3n * cap) - cap]);
    const credit = r.pick([0n, 0n, cap / 2n, cap, 2n * cap + 7n, out < 0n ? -out : r.below(cap)]);
    return {
      tokenCovid: c.covenantId, kasReserve: x, tokenReserve: y, totalShares: x + r.below(x), protocolKas: r.below(KAS), protocolTokens: r.below(1_000n),
      baseValue: KAS, admin: base.admin, maxOutBps: 1_000n, windowLen: 36_000n, windowCredit: credit, windowRef: ref, windowOut: out, paused: r.below(4n) === 0n, guardian: base.guardian,
    };
  }

  const value = (p: PoolState) => p.baseValue + p.kasReserve + p.protocolKas;

  it('ticks, withdrawals and deposits at every claim are followed to exactly the builder\'s successor', () => {
    const r = rng(20261110);
    let ticks = 0, pausedTicks = 0, removes = 0, cuts = 0, adds = 0, unclaimed = 0;
    for (let i = 0; i < 400; i++) {
      const s = randomState(r);
      const d = 5_000_000n;
      const least = leastClaim(s);
      const age = r.pick([least, leastRemoveClaim(s), minAge(s), minAge(s) + 1n, 18_000n, 35_999n, 36_000n, 72_000n, minAge(s) + r.below(72_000n - minAge(s))]);
      if (age === 0n) unclaimed++;
      const pool = located('Pool', s, value(s), c.poolId, d);
      const current = { transactionId: pool.utxo.transactionId, index: 0, scriptPublicKey: pool.utxo.scriptPublicKey };
      const reserveState = reserveOf(s, c.poolId);
      const reserve = located('KCC20', reserveState, TOKEN_VALUE, c.covenantId, d);

      // A tick (always at least the minimum; refused while paused).
      const tickAge = age < minAge(s) ? minAge(s) : age;
      if (s.paused) {
        expect(() => core.call('pool-tick', { ...c.common(), pool, nowDaa: d + tickAge })).toThrow(/paused/);
        pausedTicks++;
      } else {
        const tick = core.call('pool-tick', { ...c.common(), pool, nowDaa: d + tickAge }).value;
        const tm = followPool(tick.txid, tick.transaction, current, c.poolId, layouts, scriptOf)!;
        expect(tm.spend.entry).toBe('tick');
        expect(tm.pool.state).toEqual(poolOf(tick.outputs[0].pool));
        expect(tm.pool.state).toEqual(afterTick(s, tickAge));
        ticks++;
      }

      // A withdrawal of a random position, all of its share or less KAS.
      const shares = 1n + r.below(s.totalShares - 1_000n);
      const posState = { tokenCovid: c.covenantId, shares, owner: xonly(alice) };
      const position = located('Position', posState, POSITION_VALUE, c.poolId, d);
      const q = core.call('quote', { kind: 'remove', pool: s, shares }).value;
      const kasOut = r.pick([BigInt(q.kasOut), BigInt(q.kasOut) / 2n, 0n]);
      let removed: any;
      try {
        removed = core.call('pool-remove', {
          ...c.common(), pool, reserve, position, positionSecretKey: bytesToHex(alice), kasOut, tokensOut: BigInt(q.tokensOut), receiver: xonly(alice), tokenValue: TOKEN_VALUE, nowDaa: d + age,
        }).value;
      } catch (e) {
        // Only what the covenant refuses too (a pool left empty).
        expect(String(e)).toMatch(/next|empty|at least|MIN_LIQUIDITY|shares|reserve/i);
        continue;
      }
      const rm = followPool(removed.txid, removed.transaction, current, c.poolId, layouts, scriptOf)!;
      expect(rm.spend.entry).toBe('remove');
      expect(rm.pool.state).toEqual(poolOf(removed.outputs[0].pool));
      expect(rm.pool.state).toEqual(afterRemove(s, shares, kasOut, BigInt(q.tokensOut), age));
      if (rm.pool.state.windowRef < afterTick(s, age).windowRef) cuts++;
      removes++;

      // A deposit of a tenth of the reserve (none while paused, nor under the least claim).
      if (s.paused || age < least) continue;
      const kasIn = (s.kasReserve / 10n < 10_000n * KAS ? s.kasReserve / 10n : 10_000n * KAS) + 1n;
      const tokensIn = (kasIn * s.tokenReserve + s.kasReserve - 1n) / s.kasReserve;
      const addShares = BigInt(core.call('quote', { kind: 'add', pool: s, kasIn, tokensIn }).value.shares);
      if (addShares <= 0n) continue;
      const provider = { ...located('KCC20', { amount: tokensIn + 5n, owner: xonly(alice), ownerScheme: 0, borrowScheme: 0, borrowGuard: '00'.repeat(32), extensionCommitment: '00'.repeat(32) }, TOKEN_VALUE, c.covenantId, d), secretKey: bytesToHex(alice) };
      const add = core.call('pool-add', {
        ...c.common(), pool, reserve, provider, kasIn, tokensIn, shares: addShares, positionOwner: xonly(alice), tokenValue: TOKEN_VALUE, positionValue: POSITION_VALUE, nowDaa: d + age,
      }).value;
      const am = followPool(add.txid, add.transaction, current, c.poolId, layouts, scriptOf)!;
      expect(am.spend.entry).toBe('add');
      expect(am.pool.state).toEqual(poolOf(add.outputs[0].pool));
      expect(am.pool.state).toEqual(afterAdd(s, kasIn, tokensIn, addShares, age));
      adds++;
    }
    console.log(`followed ${ticks} ticks (${pausedTicks} refused while paused), ${removes} withdrawals (${cuts} cut below the settled reference) and ${adds} deposits exactly; ${unclaimed} states with a claim of nothing`);
    expect(ticks + pausedTicks).toBe(400);
    expect(pausedTicks).toBeGreaterThan(50);
    expect(removes).toBeGreaterThan(300);
    expect(cuts).toBeGreaterThan(50);
    expect(adds).toBeGreaterThan(150);
    expect(unclaimed).toBeGreaterThan(40);
  }, 120_000);

  it("the admin's first deposit into an emptied pool is followed, its reference the new reserve; anyone else's is not built", () => {
    // Emptied: only the MIN_LIQUIDITY unowned shares, a dust reserve and a dust reference, the count cut to two of its caps.
    const s: PoolState = {
      tokenCovid: c.covenantId, kasReserve: 300n, tokenReserve: 40n, totalShares: MIN_LIQUIDITY, protocolKas: 0n, protocolTokens: 0n,
      baseValue: KAS, admin: base.admin, maxOutBps: 1_000n, windowLen: 36_000n, windowCredit: 0n, windowRef: 300n, windowOut: 60n, paused: false, guardian: base.guardian,
    };
    const d = 5_000_000n;
    const pool = located('Pool', s, value(s), c.poolId, d);
    const current = { transactionId: pool.utxo.transactionId, index: 0, scriptPublicKey: pool.utxo.scriptPublicKey };
    const reserve = located('KCC20', reserveOf(s, c.poolId), TOKEN_VALUE, c.covenantId, d);
    const kasIn = 1_000n * KAS;
    const tokensIn = (kasIn * s.tokenReserve + s.kasReserve - 1n) / s.kasReserve;
    const shares = BigInt(core.call('quote', { kind: 'add', pool: s, kasIn, tokensIn }).value.shares);
    const provider = { ...located('KCC20', { amount: tokensIn + 5n, owner: xonly(alice), ownerScheme: 0, borrowScheme: 0, borrowGuard: '00'.repeat(32), extensionCommitment: '00'.repeat(32) }, TOKEN_VALUE, c.covenantId, d), secretKey: bytesToHex(alice) };
    const req = { ...c.common(), pool, reserve, provider, kasIn, tokensIn, shares, positionOwner: xonly(alice), tokenValue: TOKEN_VALUE, positionValue: POSITION_VALUE, nowDaa: d + 50n };
    expect(() => core.call('pool-add', req)).toThrow(/emptied/);
    expect(() => core.call('pool-add', { ...req, adminSecretKey: bytesToHex(alice) })).toThrow(/admin/);
    const add = core.call('pool-add', { ...req, adminSecretKey: bytesToHex(c.admin) }).value;
    const moved = followPool(add.txid, add.transaction, current, c.poolId, layouts, scriptOf)!;
    expect(moved.spend.entry).toBe('add');
    expect(moved.pool.state).toEqual(poolOf(add.outputs[0].pool));
    expect(moved.pool.state).toEqual(afterAdd(s, kasIn, tokensIn, shares, 50n));
    expect(moved.pool.state.windowRef).toBe(s.kasReserve + kasIn);
  });

  it('a withdrawal while paused claims 0, whatever its clock, and settles nothing; the follower agrees', () => {
    const s: PoolState = { ...randomState(rng(7)), paused: true, windowOut: 80_000n * KAS, windowRef: 1_000_000n * KAS, kasReserve: 1_000_000n * KAS, totalShares: 1_000_000n * KAS, windowCredit: 0n };
    const d = 5_000_000n;
    const pool = located('Pool', s, value(s), c.poolId, d);
    const current = { transactionId: pool.utxo.transactionId, index: 0, scriptPublicKey: pool.utxo.scriptPublicKey };
    const reserve = located('KCC20', reserveOf(s, c.poolId), TOKEN_VALUE, c.covenantId, d);
    const shares = s.totalShares / 10n;
    const position = located('Position', { tokenCovid: c.covenantId, shares, owner: xonly(alice) }, POSITION_VALUE, c.poolId, d);
    const q = core.call('quote', { kind: 'remove', pool: s, shares }).value;
    const removed = core.call('pool-remove', {
      ...c.common(), pool, reserve, position, positionSecretKey: bytesToHex(alice), kasOut: BigInt(q.kasOut), tokensOut: BigInt(q.tokensOut), receiver: xonly(alice), tokenValue: TOKEN_VALUE, nowDaa: d + 30_000n,
    }).value;
    expect(Number(removed.transaction.inputs[0].sequence)).toBe(0);
    const moved = followPool(removed.txid, removed.transaction, current, c.poolId, layouts, scriptOf)!;
    expect((moved.spend as any).ageDaa).toBe(0n);
    expect(moved.pool.state).toEqual(afterRemove(s, shares, BigInt(q.kasOut), BigInt(q.tokensOut), 0n));
    expect(moved.pool.state.windowOut).toBe(s.windowOut);
    expect(() => core.call('pool-tick', { ...c.common(), pool, nowDaa: d + 30_000n })).toThrow(/paused/);
  });
});
