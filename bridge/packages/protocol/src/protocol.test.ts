import { describe, expect, it } from 'vitest';
import { schnorr } from '@noble/curves/secp256k1.js';
import { blake2b } from '@noble/hashes/blake2.js';
import { core } from '@kusdt/core';
import { bytesToHex, encodeKaspaAddress, hexToBytes } from '@kusdt/kaspa';
import {
  OWNER_P2PK_SCHNORR, OWNER_P2SH, addressOfOwner, afterAdd, afterBuy, afterRemove, afterTick, breakerAfterRemove, breakerSettled, buyCost, buyQuote, claimFor, clientNowDaa, leastClaim, leastRemoveClaim, minAge, readyAtDaa, SELL_DAA_MARGIN, sellCapacity, windowAfter, decodeKcc20Input, isKcc20Program, ownerOfAddress,
  parsePushes, readInt8, redeemId, sellQuote, stateOfProgram, writeInt8, type PoolState,
} from './index';

const template = core.call('template').value;
const key = (seed: string) => blake2b(new TextEncoder().encode(seed), { dkLen: 32 });
const xonly = (secret: Uint8Array) => bytesToHex(schnorr.getPublicKey(secret));

function tokenState(owner: string, amount: number) {
  return { amount, owner, ownerScheme: 0, borrowScheme: 0, borrowGuard: '00'.repeat(32), extensionCommitment: '00'.repeat(32) };
}

describe('script pushes and ints', () => {
  it('round-trips 8-byte signed-magnitude ints', () => {
    for (const v of [0n, 1n, 600n, 1n << 62n, -5n]) expect(readInt8(writeInt8(v))).toBe(v);
  });
  it('parses small-number and data pushes', () => {
    expect(parsePushes(Uint8Array.from([0x00, 0x51, 0x60, 0x02, 0xaa, 0xbb]))).toEqual([new Uint8Array(0), Uint8Array.of(1), Uint8Array.of(16), Uint8Array.of(0xaa, 0xbb)]);
  });
});

describe('KCC-20 decoding', () => {
  it('reads every successor state back from a real transfer', () => {
    const alice = key('alice');
    const bob = xonly(key('bob'));
    const covenantId = 'cd'.repeat(32);
    const spent = tokenState(xonly(alice), 1_000);
    const spk = core.call('script', { actor: 'KCC20', state: spent }).value.scriptPublicKey;
    const funding = key('funding');
    const fundingSpk = '0000' + '20' + xonly(funding) + 'ac';
    const next = [tokenState(bob, 600), { ...tokenState(xonly(alice), 400), ownerScheme: 0 }];
    const built = core.call('transfer', {
      network: 'simnet',
      changeAddress: encodeKaspaAddress('kaspasim', 0, hexToBytes(xonly(funding))),
      funding: [{ utxo: { transactionId: 'aa'.repeat(32), index: 0, amount: 10_000_000_000, scriptPublicKey: fundingSpk }, secretKey: bytesToHex(funding) }],
      inputs: [{ utxo: { transactionId: 'bb'.repeat(32), index: 1, amount: 150_000_000, scriptPublicKey: spk, covenantId }, state: spent, secretKey: bytesToHex(alice) }],
      outputs: next.map((state) => ({ state, value: 150_000_000 })),
    }).value;
    const leader = decodeKcc20Input(hexToBytes(built.transaction.inputs[0].signatureScript), template);
    expect(leader?.role).toBe('leader');
    expect(leader?.spent.owner).toBe(xonly(alice));
    expect(leader?.spent.amount).toBe(1_000n);
    expect(leader?.nextStates.map((s) => [s.owner, s.amount])).toEqual([[bob, 600n], [xonly(alice), 400n]]);
    // The decoded states are exactly the ones the outputs lock to.
    for (const [i, s] of (leader?.nextStates ?? []).entries()) {
      const expected = core.call('script', { actor: 'KCC20', state: { ...s, amount: Number(s.amount) } }).value.scriptPublicKey;
      expect(built.transaction.outputs[i].scriptPublicKey).toBe(expected);
    }
    // A plain P2PK input is not a KCC20 input.
    expect(decodeKcc20Input(hexToBytes(built.transaction.inputs[1].signatureScript), template)).toBeNull();
  });

  it('recognises the KCC20 program and its state', () => {
    const state = tokenState('11'.repeat(32), 77);
    const prefix = hexToBytes(template.prefix);
    const encoded = Uint8Array.from([0x08, ...writeInt8(77n), 0x20, ...hexToBytes(state.owner), 0x01, 0, 0x01, 0, 0x20, ...new Uint8Array(32), 0x20, ...new Uint8Array(32)]);
    const program = Uint8Array.from([...prefix, ...encoded, ...hexToBytes(template.suffix)]);
    expect(isKcc20Program(program, template)).toBe(true);
    expect(stateOfProgram(program, template).amount).toBe(77n);
    expect(isKcc20Program(program.slice(1), template)).toBe(false);
  });
});

describe('owners and ids', () => {
  it('maps addresses to owners and back', () => {
    const pk = xonly(key('x'));
    const addr = encodeKaspaAddress('kaspatest', 0, hexToBytes(pk));
    expect(ownerOfAddress(addr)).toEqual({ ownerScheme: OWNER_P2PK_SCHNORR, owner: pk });
    expect(addressOfOwner({ ownerScheme: OWNER_P2PK_SCHNORR, owner: pk }, 'kaspatest')).toBe(addr);
    const p2sh = encodeKaspaAddress('kaspatest', 8, hexToBytes('22'.repeat(32)));
    expect(ownerOfAddress(p2sh)?.ownerScheme).toBe(OWNER_P2SH);
    expect(ownerOfAddress('nonsense')).toBeNull();
  });
  it('builds redeem ids from the outpoint', () => {
    const a = redeemId('ab'.repeat(32), 0);
    expect(a).toMatch(/^0x[0-9a-f]{64}$/);
    expect(redeemId('ab'.repeat(32), 1)).not.toBe(a);
  });
});

describe('pool math', () => {
  const pool: PoolState = {
    tokenCovid: '', kasReserve: 1_000_000_000_000n, tokenReserve: 100_000_000n, totalShares: 1_000_000_000_000n, protocolKas: 0n, protocolTokens: 0n, baseValue: 100_000_000n, admin: '',
    maxOutBps: 1_000n, windowLen: 36_000n, windowCredit: 0n, windowRef: 0n, windowOut: 0n, paused: false, guardian: '',
  };
  const wireOf = (p: PoolState) => ({
    ...p, kasReserve: Number(p.kasReserve), tokenReserve: Number(p.tokenReserve), totalShares: Number(p.totalShares), protocolKas: 0, protocolTokens: 0, baseValue: 100_000_000,
    maxOutBps: Number(p.maxOutBps), windowLen: Number(p.windowLen), windowCredit: Number(p.windowCredit), windowRef: Number(p.windowRef), windowOut: Number(p.windowOut),
  });
  it('matches the core quotes', () => {
    const wire = wireOf(pool);
    expect(buyQuote(pool, 5_000_000_000n)).toBe(BigInt(core.call('quote', { kind: 'buy', pool: wire, kasIn: 5_000_000_000 }).value.tokensOut));
    expect(sellQuote(pool, 7_000_000n)).toBe(BigInt(core.call('quote', { kind: 'sell', pool: wire, tokensIn: 7_000_000 }).value.kasOut));
  });
  it('a withdrawal that shrinks the pool cuts the count down to two of its new caps, and no further', () => {
    const big: PoolState = { ...pool, kasReserve: 1_000_000n, windowRef: 1_000_000n, windowOut: 100_000n, windowCredit: 0n };
    // Down to a tenth: the count of the large pool is more than two of the small pool's caps, and is cut to them.
    expect(breakerAfterRemove(big, 900_000n)).toEqual({ windowRef: 100_000n, windowOut: 2n * ((100_000n * pool.maxOutBps) / 10_000n), windowCredit: 0n });
    // A count already within the new cap stays.
    expect(breakerAfterRemove({ ...big, windowOut: 5n }, 900_000n).windowOut).toBe(5n);
    // A withdrawal that leaves the reference where it is cuts nothing.
    expect(breakerAfterRemove({ ...big, kasReserve: 5_000_000n }, 1_000n)).toEqual({ windowRef: 1_000_000n, windowOut: 100_000n, windowCredit: 0n });
    // Credit a withdrawal takes back still lands on the count first.
    expect(breakerAfterRemove({ ...big, windowOut: -50n, windowCredit: 50n }, 900_000n)).toEqual({ windowRef: 100_000n, windowOut: 0n, windowCredit: 0n });
  });

  it("matches the core's circuit breaker: a fresh pool, an allowance in use, partly and fully refilled", () => {
    const used: PoolState = { ...pool, windowRef: pool.kasReserve, windowOut: 30_000_000_000n };
    for (const [p, now, poolDaa] of [[{ ...pool, windowRef: pool.kasReserve }, 1_000_000n, undefined], [used, 1_000_100n, 1_000_100n], [used, 1_000_100n, 1_000_000n], [used, 1_000_000n, 900_000n]] as const) {
      const core1 = core.call('quote', { kind: 'sell', pool: wireOf(p), tokensIn: 7_000_000, nowDaa: Number(now), ...(poolDaa !== undefined && { poolDaa: Number(poolDaa) }) }).value;
      const mine = sellCapacity(p, now, poolDaa);
      expect(BigInt(core1.breaker.maxKasOut)).toBe(mine.maxKasOut);
      expect(BigInt(core1.breaker.windowEndsDaa)).toBe(mine.windowEndsDaa);
    }
    // A fresh pool: 10 % of its reserve. In use: the cap less what is left of the allowance used, at once while at most
    // half of the cap is in use; above half, once the pool UTXO is old enough for a sell to claim the minimum (50 DAA,
    // which refills 50/36 000 of a cap).
    const refill50 = (100_000_000_000n * 50n) / 36_000n;
    const busy: PoolState = { ...used, windowOut: 60_000_000_000n };
    expect(sellCapacity({ ...pool, windowRef: pool.kasReserve }, 1_000_000n, undefined).maxKasOut).toBe(100_000_000_000n);
    expect(sellCapacity(used, 1_000_100n, 1_000_100n)).toMatchObject({ maxKasOut: 100_000_000_000n - 30_000_000_000n, readyAtDaa: 1_000_100n });
    expect(sellCapacity(busy, 1_000_100n, 1_000_100n)).toMatchObject({ maxKasOut: 100_000_000_000n - 60_000_000_000n + refill50, readyAtDaa: 1_000_150n });
    // Half a window refills half a cap: the 30 used are gone (50 back), all of it on the reserve now.
    expect(sellCapacity(used, 1_018_000n, 1_000_000n).maxKasOut).toBe(100_000_000_000n);
    expect(sellCapacity(used, 1_036_000n, 1_000_000n).maxKasOut).toBe(100_000_000_000n);
    // Without a pool DAA score (a pool UTXO only in the mempool) there is no age to claim: at most half in use, a sell
    // can go at once; above half none can until it is accepted (no ready DAA).
    expect(sellCapacity(used, 9_000_000n)).toMatchObject({ maxKasOut: 100_000_000_000n - 30_000_000_000n, readyAtDaa: 0n });
    expect(sellCapacity(busy, 9_000_000n)).toMatchObject({ maxKasOut: 100_000_000_000n - 60_000_000_000n + refill50, readyAtDaa: null });
    const after = windowAfter(used, 5n, 18_000n);
    expect(after.windowCredit).toBe(0n);
    expect(after.windowRef).toBe(used.kasReserve - 5n);
    expect(after.windowOut).toBe(5n);
    // A big reserve does not lift the reference at one moment; it takes claimed time.
    const inflated: PoolState = { ...used, kasReserve: 4n * used.kasReserve };
    expect(windowAfter(inflated, 5n, 0n).windowRef).toBe(used.kasReserve);
    // It follows the reserve by at most its own size per window, so liquidity held for a moment can't lift it further.
    expect(windowAfter(inflated, 5n, 18_000n).windowRef).toBe(used.kasReserve + used.kasReserve / 2n);
    expect(windowAfter(inflated, 5n, 36_000n).windowRef).toBe(2n * used.kasReserve);
    expect(windowAfter({ ...used, kasReserve: used.kasReserve + 7n }, 5n, 36_000n).windowRef).toBe(used.kasReserve + 2n);
    // A positive count is never cut to a smaller cap.
    const over: PoolState = { ...used, windowOut: 200_000_000_000n };
    expect(sellCapacity(over, 1_000_000n).maxKasOut).toBe(0n);
  });
  it('counts the net flow: a buy gives sells room, at most one cap of credit', () => {
    const open: PoolState = { ...pool, windowRef: 1_000_000_000_000n, windowOut: 30_000_000_000n };
    const kasIn = 50_000_000_000n;
    const added = kasIn - (kasIn * 5n) / 10_000n;
    const next = afterBuy(open, kasIn, buyQuote(open, kasIn));
    expect(next.windowOut).toBe(30_000_000_000n - added);
    expect(next.windowOut < 0n).toBe(true);
    const now = 1_000_100n;
    expect(sellCapacity(next, now).maxKasOut).toBe((open.windowRef * 1_000n) / 10_000n - next.windowOut);
    const fromCore = core.call('quote', { kind: 'sell', pool: wireOf(next), tokensIn: 7_000_000, nowDaa: Number(now) }).value;
    expect(BigInt(fromCore.breaker.maxKasOut)).toBe(sellCapacity(next, now).maxKasOut);
    // A huge buy is worth one cap of credit, no more.
    const whale = afterBuy(open, 100_000_000_000_000n, 1n);
    expect(whale.windowOut).toBe(-100_000_000_000n);
  });
  it('the shortest claim: none while at most half of the cap is in use, a 720th of the window above that', () => {
    // The cap is 100 000 000 000 (10 % of the reference): half of it is the threshold, on the stored values.
    const used: PoolState = { ...pool, windowRef: pool.kasReserve, windowOut: 50_000_000_001n };
    expect(minAge(pool)).toBe(50n);
    expect(minAge({ windowLen: 8n })).toBe(1n);
    expect(minAge({ windowLen: 719n })).toBe(1n);
    expect(leastClaim(pool)).toBe(0n);
    expect(leastClaim({ ...pool, windowOut: -1n })).toBe(0n);
    expect(leastClaim({ ...used, windowOut: 30_000_000_000n })).toBe(0n);
    expect(leastClaim({ ...used, windowOut: 50_000_000_000n })).toBe(0n);
    expect(leastClaim(used)).toBe(50n);
    // The stored reference counts, not the reserve: a reserve below it changes nothing until a spend settles it.
    const smallerReserve: PoolState = { ...used, kasReserve: pool.kasReserve / 2n };
    expect(leastClaim(smallerReserve)).toBe(50n);
    expect(leastClaim({ ...used, windowRef: 2n * pool.kasReserve })).toBe(0n);
    // A withdrawal while paused needs nothing; a tick always needs the minimum (claimFor with minAge, below).
    expect(leastRemoveClaim(used)).toBe(50n);
    expect(leastRemoveClaim({ ...used, paused: true })).toBe(0n);
    expect(leastRemoveClaim({ ...pool, paused: true })).toBe(0n);
    // A client's clock: SELL_DAA_MARGIN behind the virtual DAA, never below the least claim, null before the lock allows.
    expect(clientNowDaa(used, 1_049n, 1_000n)).toBeNull();
    expect(clientNowDaa(used, 1_050n, 1_000n)).toBe(1_050n);
    expect(clientNowDaa(used, 1_055n, 1_000n)).toBe(1_050n);
    expect(clientNowDaa(used, 1_070n, 1_000n)).toBe(1_070n - SELL_DAA_MARGIN);
    expect(clientNowDaa(used, 9_000n, null)).toBeNull();
    expect(clientNowDaa(pool, 1_003n, 1_000n)).toBe(1_000n);
    expect(clientNowDaa(pool, 1_200n, 1_000n)).toBe(1_190n);
    expect(clientNowDaa(pool, 1_200n, null)).toBe(1_190n);
    expect(clientNowDaa({ ...used, paused: true }, 1_001n, 1_000n, leastRemoveClaim({ ...used, paused: true }))).toBe(1_000n);
    // Ready: at once with nothing in use (even from the mempool); 50 DAA after acceptance otherwise, never from the mempool.
    expect(readyAtDaa(pool, null)).toBe(0n);
    expect(readyAtDaa(pool, 1_000n)).toBe(1_000n);
    expect(readyAtDaa(used, null)).toBeNull();
    expect(readyAtDaa(used, 1_000n)).toBe(1_050n);
    expect(claimFor(used, 1_049n, 1_000n)).toBeNull();
    expect(claimFor(used, 1_050n, 1_000n)).toBe(50n);
    expect(claimFor(used, 9_000n, null)).toBeNull();
    expect(claimFor(pool, 9_000n, null)).toBe(0n);
    expect(claimFor(used, 100_000n, 1_000n)).toBe(72_000n);
    // A tick always needs the minimum.
    expect(claimFor(pool, 1_049n, 1_000n, minAge(pool))).toBeNull();
    expect(claimFor(pool, 1_050n, 1_000n, minAge(pool))).toBe(50n);
  });
  it('add, remove and tick settle the breaker as the core builders do', () => {
    const used: PoolState = { ...pool, windowRef: pool.kasReserve, windowOut: 30_000_000_000n, windowCredit: 0n };
    // A tick of half a window: the count falls by half a cap, nothing else moves.
    const ticked = afterTick(used, 18_000n);
    expect(ticked).toEqual({ ...used, windowOut: 0n });
    expect(breakerSettled(used, 18_000n)).toEqual({ windowRef: used.windowRef, windowOut: 0n, windowCredit: 0n });
    // An add settles at the reserve it stood at, and leaves the reference there: new liquidity lifts it only with later time.
    const added = afterAdd(used, 1_000_000_000_000n, 100_000_000n, 1_000_000_000_000n, 3_600n);
    expect(added.windowRef).toBe(used.windowRef);
    expect(added.windowOut).toBe(30_000_000_000n - 10_000_000_000n);
    expect(added.kasReserve).toBe(2_000_000_000_000n);
    // The reference rises toward a larger reserve with the claim, before the withdrawal cuts it.
    const big: PoolState = { ...added, windowCredit: 0n };
    const removed = afterRemove(big, 1_000_000_000_000n, 1_000_000_000_000n, 100_000_000n, 3_600n);
    expect(removed.windowRef).toBe(1_000_000_000_000n);
    expect(removed.windowOut).toBe(20_000_000_000n - 11_000_000_000n);
    expect(breakerAfterRemove(big, 1_000_000_000_000n, 3_600n)).toEqual({ windowRef: removed.windowRef, windowOut: removed.windowOut, windowCredit: 0n });
    // The settle uses the advanced reference: 3 600 of 36 000 DAA lift it a tenth of the way (at most its own size).
    expect(breakerSettled(big, 3_600n).windowRef).toBe(1_100_000_000_000n);
  });
  it('finds the smallest KAS for a wanted amount', () => {
    const cost = buyCost(pool, 1_000_000n);
    expect(buyQuote(pool, cost)).toBeGreaterThanOrEqual(1_000_000n);
    expect(buyQuote(pool, cost - 1n)).toBeLessThan(1_000_000n);
  });
  // Run 20, ONC-1: the search stopped at 1,000 times the KAS reserve and answered that bound, though it bought less
  // than asked, and it could answer more than one swap may take in (pool.ag's MAX_SWAP_INPUT).
  it('never answers an amount that buys less than asked, or more than one swap takes', () => {
    const MOST = 230_584_300_921_369n;
    // A thin KAS side: 1,000 sompi against 10^12 base units, most of the tokens asked for.
    const thin: PoolState = { ...pool, kasReserve: 1_000n, tokenReserve: 1_000_000_000_000n };
    const cost = buyCost(thin, 999_000_000_000n);
    expect(buyQuote(thin, cost)).toBeGreaterThanOrEqual(999_000_000_000n);
    expect(cost).toBeGreaterThan(thin.kasReserve * 1_000n);
    // Needing more than one swap may take: refused, not answered.
    const deep: PoolState = { ...pool, kasReserve: 1_000_000_000_000n, tokenReserve: 1_000_000_000_000n };
    const enough = deep.tokenReserve * 999n / 1_000n;
    expect(() => buyCost(deep, enough)).toThrow(/one swap cannot buy/);
    // The largest that can be bought is still found, within the bound.
    const most = buyQuote(deep, MOST);
    const atMost = buyCost(deep, most);
    expect(atMost).toBeLessThanOrEqual(MOST);
    expect(buyQuote(deep, atMost)).toBeGreaterThanOrEqual(most);
    expect(() => buyCost(deep, most + 1n)).toThrow(/one swap cannot buy/);
  });
});
