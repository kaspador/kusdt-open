// Round 17 (12 November 2026, on rc.22), R17-CL-1: rc.22's input cap (8 inputs, 6 funding coins for a buy) kept
// buildFunded from adding the coin that let the change be kept (rc.21 added it). With KAS spread over more coins than
// that, up to about 0.22 KAS a pool transaction (more at high feerates) went to the network fee, and the screens had
// shown about 0.08 KAS. Now the wallet tries other coins within the cap, says to merge first when none keep the
// change, holds a build that would still leave more than 0.05 KAS of change to the network to the fee the user was
// shown (Max keeps FEE_KEEP for it, and says so), and takes one more coin when the core's fee does not settle.

import { describe, expect, it } from 'vitest';
import { FakeNode, COVENANT, POOL, devKey, fakeApi, testCtx, signerFor, kasCoin, core, lastBuilt } from './helpers';
import { p2shAddressOf, scriptOf, reserveStateOf, poolValue } from '@/kusdt/verify';
import { FEE_KEEP, POOL_WAIT, addLiquidity, maxKasIn, quoteAdd, quoteBuy, swap, trimToShares } from '@/kusdt/pool';
import { buildFunded, feeNeeded, kasCoins, toCoreUtxo } from '@/kusdt/build';
import { isMergeCoinsFirst } from '@/kusdt/inputs';
import { plainState } from '@/kusdt/owner';
import type { NodeUtxo } from '@/kaspa/node';
import type { Built, PoolState } from '@/kusdt/types';

const alice = devKey('alice');
POOL_WAIT.ms = 0;
POOL_WAIT.perDaaMs = 0;
const KAS = 100_000_000n;
/** The most of a transaction's change the wallet lets go to the network unasked (kusdt/build.ts ABSORB_LIMIT, 0.05 KAS). */
const LIMIT = 5_000_000n;
const base: PoolState = { tokenCovid: COVENANT, kasReserve: 200n * KAS, tokenReserve: 20_000_000n, totalShares: 200n * KAS, protocolKas: 0n, protocolTokens: 0n, baseValue: KAS, admin: '11'.repeat(32), maxOutBps: 1_000n, windowLen: 36_000n, windowCredit: 0n, windowRef: 0n, windowOut: 0n, paused: false, guardian: '22'.repeat(32) };

let no = 0;
/** A fresh txid: the count in a fixed width, so that no two are alike however many this file makes (a sent one's coins stay pending). */
const uniq = (c: string) => (++no).toString(16).padStart(8, '0').padStart(64, c);

/** A pool, alice's KAS in coins of `coins` sompi each (in that order on the node), a 3 kUSDT state of hers, and the feerate. */
function scenario(coins: bigint[], feerate = 100) {
  const node = new FakeNode();
  const listed: any[] = [];
  let answer: any = null;
  const ctx = testCtx(node, fakeApi({ pool: async () => answer, tokens: async () => ({ states: listed }) }));
  const asked: { command: string; request: any }[] = [];
  ctx.core = { ...ctx.core, call: ((command: string, request: any) => { asked.push({ command, request }); return core.call(command, request); }) as typeof core.call };
  const txid = uniq('1');
  const reserve = reserveStateOf(POOL, base);
  const pspk = scriptOf(ctx, 'Pool', base), rspk = scriptOf(ctx, 'KCC20', reserve);
  const poolUtxo: NodeUtxo = { address: p2shAddressOf(pspk, 'kaspasim'), transactionId: txid, index: 0, amount: poolValue(base), scriptPublicKey: pspk, covenantId: POOL, blockDaaScore: 999_000n, isCoinbase: false };
  const reserveUtxo: NodeUtxo = { address: p2shAddressOf(rspk, 'kaspasim'), transactionId: txid, index: 1, amount: 150_000_000n, scriptPublicKey: rspk, covenantId: COVENANT, blockDaaScore: 999_000n, isCoinbase: false };
  node.utxoSet.push(poolUtxo, reserveUtxo);
  answer = { pool: { utxo: { transactionId: txid, index: 0 }, state: base }, reserve: { utxo: { transactionId: txid, index: 1 }, state: reserve } };
  for (const amount of coins) node.utxoSet.push(kasCoin(alice, uniq('e'), amount));
  const state = plainState({ ownerScheme: 0, owner: alice.xonly }, 3_000_000n);
  const spk = scriptOf(ctx, 'KCC20', state);
  const t = uniq('d');
  node.utxoSet.push({ address: p2shAddressOf(spk, 'kaspasim'), transactionId: t, index: 0, amount: 150_000_000n, scriptPublicKey: spk, blockDaaScore: 5n, isCoinbase: false, covenantId: COVENANT });
  listed.push({ utxo: { transactionId: t, index: 0 }, state: { ...state, amount: '3000000' } });
  node.feerate = async () => feerate;
  return { node, ctx, asked, poolUtxo, reserveUtxo, reserve };
}

/** What of a build's fee is change left to the network: what it pays beyond what its size needs. */
const lostOf = (built: Built, feerate: number) => built.fee - feeNeeded(built, feerate);
/** The funding coins (sompi) the core was last asked to build a pool transaction with. */
const fundingOf = (asked: { command: string; request: any }[], command: string) => asked.filter(a => a.command === command).at(-1)!.request.funding.map((f: any) => BigInt(f.utxo.amount));

type Outcome = { sent: number; built?: Built; lost?: bigint; funding?: bigint[]; error?: any };

/** A buy of `kasIn` with the fee shown at `shown` (the feerate by default; null: no fee shown). */
async function buy(coins: bigint[], kasIn: bigint, opts: { feerate?: number; shown?: number | null; acceptedFee?: bigint } = {}): Promise<Outcome> {
  const feerate = opts.feerate ?? 100;
  const { node, ctx, asked } = scenario(coins, feerate);
  const shownFeerate = opts.shown === null ? undefined : (opts.shown ?? feerate);
  try {
    const r = await swap(ctx, signerFor(alice), [alice.address], { side: 'buy', amountIn: kasIn, minOut: 1n, quoted: quoteBuy(ctx, base, kasIn), shownFeerate, acceptedFee: opts.acceptedFee });
    return { sent: node.submitted.length, built: r.built, lost: lostOf(r.built, feerate), funding: fundingOf(asked, 'pool-buy') };
  } catch (error) {
    return { sent: node.submitted.length, error };
  }
}

describe('R17-CL-1: the cap and the change', () => {
  it('with 12 coins of 1 KAS, no buy gives change to the network: where the 6 coins the cap allows cannot keep it, the wallet says to merge, and nothing is sent', async () => {
    let merges = 0;
    for (let c = 400n; c <= 446n; c += 2n) {
      const kasIn = c * 1_000_000n;
      const r = await buy(Array(12).fill(KAS), kasIn);
      if (r.error) {
        expect(isMergeCoinsFirst(r.error), `${kasIn}: ${r.error?.message}`).toBe(true);
        expect(r.sent).toBe(0);
        if (r.error.lost != null) merges++;
      } else {
        // rc.22: from 4.22 to 4.38 KAS every build used 8 inputs and paid 5.3 to 21.3 million sompi of change to the network.
        expect(r.lost, `a buy of ${kasIn} sompi`).toBeLessThanOrEqual(LIMIT);
        expect(r.sent).toBe(1);
      }
    }
    expect(merges).toBeGreaterThanOrEqual(8);
    const e = (await buy(Array(12).fill(KAS), 430_000_000n)).error;
    expect(e).toMatchObject({ cap: 6, coins: 12 });
    expect(e.lost).toBeGreaterThan(LIMIT);
    expect(e.message).toMatch(/^Your KAS is in 12 coins, and a pool transaction takes at most 8 inputs, 2 of them the pool's own: the 6 it can take would leave about 0\.1\d* KAS of change, too little for the network to keep, and it would go to the network fee\. Merge your KAS first/);
    expect(e.message).toMatch(/Nothing was sent\.$/);
    expect(e.message).not.toMatch(new RegExp(String.fromCharCode(0x2014)));
    // At exactly 4.20 KAS the core's fee did not settle (rc.22 said so in the core's words): now it is a merge too.
    expect(isMergeCoinsFirst((await buy(Array(12).fill(KAS), 420_000_000n)).error)).toBe(true);
  });

  it('a coin of the wallet\'s swapped within the cap keeps the KAS from the network', async () => {
    // 6 coins of 1 KAS and 6 of 0.8: the 6 largest leave 0.2 KAS of change, too little to keep; one 0.8 in the place of
    // a 1 leaves nothing worth keeping, and nothing is lost.
    const coins = [...Array(6).fill(KAS), ...Array(6).fill(80_000_000n)];
    const r = await buy(coins, 423_000_000n);
    expect(r.error).toBeUndefined();
    expect(r.lost).toBeLessThanOrEqual(LIMIT);
    expect(r.funding).toHaveLength(6);
    expect(r.funding).toContain(80_000_000n);
    expect(r.sent).toBe(1);
  });

  it('the coin a lost try spent stays in the next build: the swap takes another', async () => {
    const { ctx, poolUtxo, reserveUtxo, reserve } = scenario([...Array(6).fill(KAS), ...Array(6).fill(80_000_000n)]);
    const coins = await kasCoins(ctx, [alice.address]);
    const first = `${coins[0].utxo.transactionId}:${coins[0].utxo.index}`;
    const kasIn = 423_000_000n, tokenValue = BigInt(ctx.config.tokenValue);
    const request = (funding: unknown[], feerate: number) => ({
      network: ctx.network, feerate, changeAddress: alice.address, funding,
      pool: { utxo: toCoreUtxo({ ...poolUtxo, confirmed: true }), state: base }, reserve: { utxo: toCoreUtxo({ ...reserveUtxo, confirmed: true }), state: reserve },
      kasIn, tokensOut: quoteBuy(ctx, base, kasIn), buyer: alice.xonly, tokenValue, nowDaa: 1_000_000n,
    });
    const built = buildFunded(ctx, signerFor(alice), coins, 'pool-buy', kasIn + tokenValue, request, 100, new Set([first]));
    expect(lostOf(built, 100)).toBeLessThanOrEqual(LIMIT);
    expect(lastBuilt.value.transaction.inputs.map((i: any) => `${i.previousOutpoint.transactionId}:${i.previousOutpoint.index}`)).toContain(first);
  });

  it('a deposit that the 5 coins the cap allows cannot keep the change of is told to merge as well', async () => {
    let merges = 0;
    for (let c = 250n; c <= 300n; c += 5n) {
      const kasIn = c * 1_000_000n;
      const { node, ctx } = scenario(Array(12).fill(KAS));
      const tokensIn = (kasIn * base.tokenReserve) / base.kasReserve + 1n;
      const used = trimToShares(base, kasIn, tokensIn);
      const shares = quoteAdd(ctx, base, used.kasIn, used.tokensIn);
      const r = await addLiquidity(ctx, signerFor(alice), [alice.address], { kasIn, tokensIn, minShares: shares, quoted: shares, shownFeerate: 100 }).catch(e => e);
      if (r instanceof Error) {
        expect(isMergeCoinsFirst(r), `${kasIn}: ${r.message}`).toBe(true);
        expect(node.submitted).toHaveLength(0);
        if ((r as any).lost != null) merges++;
      } else {
        expect(lostOf(r.built, 100), `a deposit of ${kasIn} sompi`).toBeLessThanOrEqual(LIMIT);
      }
    }
    expect(merges).toBeGreaterThan(0);
  });
});

describe('R17-CL-1: the fee a build pays is the fee shown', () => {
  it('with every coin in the build, change too small to keep is not paid unasked: the build is not sent, and the fee is named', async () => {
    // One coin of 10 KAS: a buy of 8.22 leaves 0.28 KAS, which the network does not keep as change.
    const r = await buy([10n * KAS], 822_000_000n);
    expect(r.sent).toBe(0);
    expect(r.error?.kind).toBe('fee-takes-change');
    expect(r.error.fee).toBe(28_000_000n);
    expect(r.error.lost).toBeGreaterThan(LIMIT);
    expect(r.error.message).toMatch(/^This would pay 0\.28 KAS to the network, not the about 0\.08 KAS shown: 0\.2\d* KAS of it is change too small for the network to keep\. Nothing was sent\./);
    expect(r.error.message).not.toMatch(new RegExp(String.fromCharCode(0x2014)));
    // Less, and the change comes back.
    const kept = await buy([10n * KAS], 800_000_000n);
    expect(kept.sent).toBe(1);
    expect(kept.lost).toBe(0n);
  });

  it('Max, whose screen says it keeps FEE_KEEP for the network fee, is sent with that fee; without it the same build is not', async () => {
    const ctx = { config: { tokenValue: '150000000', positionValue: '200000000' } } as Parameters<typeof maxKasIn>[0];
    const max = maxKasIn(ctx, 'buy', 10n * KAS);
    const r = await buy([10n * KAS], max, { acceptedFee: FEE_KEEP });
    expect(r.sent).toBe(1);
    expect(r.built!.fee).toBeLessThanOrEqual(FEE_KEEP);
    expect((await buy([10n * KAS], max)).error?.kind).toBe('fee-takes-change');
    // An accepted fee is a ceiling: one above it is not sent.
    expect((await buy([10n * KAS], 822_000_000n, { acceptedFee: 20_000_000n })).error?.kind).toBe('fee-takes-change');
  });

  it('at the wallet\'s highest feerate too, where change under about 0.8 KAS is not kept', async () => {
    const r = await buy([20n * KAS], 1_700_000_000n, { feerate: 2_000 });
    expect(r.sent).toBe(0);
    expect(r.error?.kind).toBe('fee-takes-change');
    const kept = await buy([20n * KAS], 1_640_000_000n, { feerate: 2_000 });
    expect(kept.sent).toBe(1);
    expect(kept.lost).toBe(0n);
  });

  it('a caller that shows no fee is not held to one (as before)', async () => {
    const r = await buy([10n * KAS], 822_000_000n, { shown: null });
    expect(r.sent).toBe(1);
  });
});

describe('R17-CL-1: a fee the core cannot settle', () => {
  it('takes one more coin when there is one; with every coin in it, the wallet says what to do, in its words', async () => {
    // At 2000 sompi a gram, a buy of 16.55 KAS on coins of 16, 2 and 2 KAS leaves change at the edge of what the core
    // keeps, and its fee went back and forth (rc.22: "the fee did not settle", with a coin of 1 KAS unused).
    const more = await buy([16n * KAS, 2n * KAS, 2n * KAS, KAS], 1_655_000_000n, { feerate: 2_000 });
    expect(more.error).toBeUndefined();
    expect(more.funding).toHaveLength(4);
    expect(more.lost).toBeLessThanOrEqual(LIMIT);
    expect(more.sent).toBe(1);
    const all = await buy([20n * KAS], 1_650_000_000n, { feerate: 2_000 });
    expect(all.sent).toBe(0);
    expect(all.error?.message).toMatch(/^The network fee does not settle for this amount: what would come back as change is at the edge of what the network keeps\. Change the amount a little and try again\. Nothing was sent\.$/);
  });
});
