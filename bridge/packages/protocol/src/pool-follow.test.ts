import { describe, expect, it } from 'vitest';
import { core } from '@kusdt/core';
import { bytesToHex, hexToBytes } from '@kusdt/kaspa';
import { PoolFollowError, followPool, followPositionTransfer, parsePushes, decodePoolProgram, type PoolLayouts, type PoolState } from './index';
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
const kindAt = (built: any, kind: string) => built.outputs.findIndex((o: any) => o.kind === kind);
/** The pool UTXO as a node shows it once accepted at `daa`: a builder claims its age (at least the minimum while more than half of the cap is in use). */
const aged = (pool: any, daa: bigint) => ({ ...pool, utxo: { ...pool.utxo, blockDaaScore: daa } });

describe('the pool follower', () => {
  const c = offlineChain('pool-follow');
  const alice = secret('pool-follow/alice');
  const bob = secret('pool-follow/bob');
  const minted = c.mint([alice, alice, bob], [60_000_000n, 30_000_000n, 40_000_000n]);
  let pool = c.at(c.poolGenesis, 0, 'pool', c.poolId);
  let reserve: any = null;

  /** Follows `built` from the current pool and checks every successor against the builder's own outputs. */
  function step(built: any) {
    const move = followPool(built.txid, built.transaction, pool.utxo, c.poolId, layouts, scriptOf)!;
    expect(move).not.toBeNull();
    const poolIndex = kindAt(built, 'pool');
    expect(move.pool.utxo.index).toBe(poolIndex);
    expect(move.pool.state).toEqual(poolOf(built.outputs[poolIndex].pool));
    const reserveIndex = built.outputs.findIndex((o: any) => o.kind === 'reserve');
    if (reserveIndex >= 0) {
      expect(move.reserve!.utxo.index).toBe(reserveIndex);
      expect(move.reserve!.state.amount).toBe(BigInt(built.outputs[reserveIndex].token.amount));
      reserve = c.at(built, reserveIndex, 'token');
    }
    pool = c.at(built, poolIndex, 'pool', c.poolId);
    return move;
  }

  it('follows init, buy, sell, sell_all, add, remove, tick and collect', () => {
    const init = core.call('pool-init', {
      ...c.common(), adminSecretKey: bytesToHex(c.admin), pool, provider: c.owned(c.at(minted, 1, 'token'), alice), kasIn: 1_000n * KAS, tokensIn: 50_000_000n,
      positionOwner: xonly(alice), tokenValue: TOKEN_VALUE, positionValue: POSITION_VALUE,
    }).value;
    const opened = step(init);
    expect(opened.spend.entry).toBe('init');
    expect(opened.position!.state).toEqual({ tokenCovid: c.covenantId, shares: 1_000n * KAS - 1_000n, owner: xonly(alice) });
    const alicePosition = c.at(init, kindAt(init, 'position'), 'position', c.poolId);

    const kasIn = 10n * KAS;
    const tokensOut = BigInt(core.call('quote', { kind: 'buy', pool: pool.state, kasIn }).value.tokensOut);
    const buy = core.call('pool-buy', { ...c.common(), pool, reserve, kasIn, tokensOut, buyer: xonly(bob), tokenValue: TOKEN_VALUE }).value;
    expect(step(buy).spend.entry).toBe('buy');

    const bobToken = c.at(minted, 3, 'token');
    const sellIn = 5_000_000n;
    const kasOut = BigInt(core.call('quote', { kind: 'sell', pool: pool.state, tokensIn: sellIn }).value.kasOut);
    const creditBefore = BigInt(pool.state.windowOut); // the buy before gave the sell room
    const sell = core.call('pool-sell', { ...c.common(), pool, reserve, payer: c.owned(bobToken, bob), tokensIn: sellIn, kasOut, tokenValue: TOKEN_VALUE, nowDaa: 5_000 }).value;
    expect(step(sell).spend.entry).toBe('sell');
    expect(BigInt(pool.state.windowCredit)).toBe(0n);
    expect(BigInt(pool.state.windowOut)).toBe(creditBefore + kasOut);
    expect(BigInt(pool.state.windowRef)).toBeLessThanOrEqual(BigInt(pool.state.kasReserve));
    const bobChange = c.at(sell, sell.outputs.findIndex((o: any) => o.kind === 'token'), 'token');

    const allIn = BigInt(bobChange.state.amount);
    const kasOutAll = BigInt(core.call('quote', { kind: 'sell', pool: pool.state, tokensIn: allIn }).value.kasOut);
    // At most half of the cap in use (this chain's cap is the whole reserve): even a pool UTXO only in the mempool can be
    // spent at once, claiming nothing. (Above half: pool-follow-random.test.ts, protocol.test.ts and the Rust tests.)
    expect(Number(core.call('pool-sell', { ...c.common(), pool, reserve, payer: c.owned(bobChange, bob), tokensIn: allIn, kasOut: kasOutAll, tokenValue: TOKEN_VALUE, nowDaa: 5_001 }).value.transaction.inputs[0].sequence)).toBe(0);
    expect(Number(core.call('pool-sell', { ...c.common(), pool: aged(pool, 4_960n), reserve, payer: c.owned(bobChange, bob), tokensIn: allIn, kasOut: kasOutAll, tokenValue: TOKEN_VALUE, nowDaa: 5_001 }).value.transaction.inputs[0].sequence)).toBe(41);
    const sellAll = core.call('pool-sell', { ...c.common(), pool: aged(pool, 4_900n), reserve, payer: c.owned(bobChange, bob), tokensIn: allIn, kasOut: kasOutAll, tokenValue: TOKEN_VALUE, nowDaa: 5_001 }).value;
    const sold = step(sellAll);
    expect(sold.spend.entry).toBe('sell_all');
    expect(sold.spend.entry === 'sell_all' && sold.spend.ageDaa).toBe(101n);
    expect(BigInt(pool.state.windowOut)).toBeLessThan(creditBefore + kasOut + kasOutAll);

    const addKas = 100n * KAS;
    const addTokens = 25_000_000n;
    const shares = BigInt(core.call('quote', { kind: 'add', pool: pool.state, kasIn: addKas, tokensIn: addTokens }).value.shares);
    const add = core.call('pool-add', {
      ...c.common(), pool: aged(pool, 5_000n), reserve, provider: c.owned(c.at(minted, 2, 'token'), alice), kasIn: addKas, tokensIn: addTokens, shares,
      positionOwner: xonly(bob), tokenValue: TOKEN_VALUE, positionValue: POSITION_VALUE, nowDaa: 5_100,
    }).value;
    const added = step(add);
    expect(added.spend.entry === 'add' && added.spend.ageDaa).toBe(100n);
    expect(added.position!.state.shares).toBe(shares);
    expect(added.position!.state.owner).toBe(xonly(bob));

    const out = core.call('quote', { kind: 'remove', pool: pool.state, shares: alicePosition.state.shares }).value;
    const remove = core.call('pool-remove', {
      ...c.common(), pool: aged(pool, 5_100n), reserve, position: alicePosition, positionSecretKey: bytesToHex(alice),
      kasOut: BigInt(out.kasOut), tokensOut: BigInt(out.tokensOut), receiver: xonly(alice), tokenValue: TOKEN_VALUE, nowDaa: 5_200,
    }).value;
    const removed = step(remove);
    expect(removed.consumed).toEqual({ transactionId: alicePosition.utxo.transactionId, index: alicePosition.utxo.index });
    expect(removed.spend.entry === 'remove' && removed.spend.ageDaa).toBe(100n);

    // Anyone's tick: the breaker settles by its claim, nothing else moves, no kUSDT.
    const before = poolOf(pool.state);
    expect(() => core.call('pool-tick', { ...c.common(), pool: aged(pool, 5_200n), nowDaa: 5_249 })).toThrow(/at least 50/);
    const tick = core.call('pool-tick', { ...c.common(), pool: aged(pool, 5_200n), nowDaa: 5_300 }).value;
    const ticked = step(tick);
    expect(ticked.spend.entry).toBe('tick');
    expect(ticked.spend.entry === 'tick' && ticked.spend.ageDaa).toBe(100n);
    expect(ticked.reserve).toBeNull();
    expect({ ...ticked.pool.state, windowRef: 0n, windowOut: 0n, windowCredit: 0n }).toEqual({ ...before, windowRef: 0n, windowOut: 0n, windowCredit: 0n });
    expect(ticked.pool.state.windowOut).toBeLessThan(before.windowOut);

    expect(pool.state.protocolKas > 0n || BigInt(pool.state.protocolKas) > 0n).toBe(true);
    const collect = core.call('pool-collect', { ...c.common(), pool, reserve, adminSecretKey: bytesToHex(c.admin), feesTo: xonly(c.admin), tokenValue: TOKEN_VALUE }).value;
    const collected = step(collect);
    expect(collected.pool.state.protocolKas).toBe(0n);
    expect(collected.pool.state.protocolTokens).toBe(0n);
  });

  it('follows a position transfer, and notices a redeem', () => {
    const local = offlineChain('pool-follow-2');
    const carol = secret('pool-follow/carol');
    const m = local.mint([carol], [80_000_000n]);
    const init = core.call('pool-init', {
      ...local.common(), adminSecretKey: bytesToHex(local.admin), pool: local.at(local.poolGenesis, 0, 'pool', local.poolId), provider: local.owned(local.at(m, 1, 'token'), carol),
      kasIn: 500n * KAS, tokensIn: 40_000_000n, positionOwner: xonly(carol), tokenValue: TOKEN_VALUE, positionValue: POSITION_VALUE,
    }).value;
    const position = local.at(init, kindAt(init, 'position'), 'position', local.poolId);
    const dave = secret('pool-follow/dave');
    const transfer = core.call('position-transfer', { ...local.common(), position, secretKey: bytesToHex(carol), newOwner: xonly(dave) }).value;
    const moved = followPositionTransfer(transfer.txid, transfer.transaction, position.utxo, layouts.position, scriptOf, local.poolId);
    expect(moved).not.toBe('redeemed');
    expect((moved as any).state).toEqual({ ...{ tokenCovid: local.covenantId, shares: BigInt(position.state.shares) }, owner: xonly(dave) });
  });

  it('refuses a pool successor the outputs do not hold', () => {
    const local = offlineChain('pool-follow-3');
    const erin = secret('pool-follow/erin');
    const m = local.mint([erin], [50_000_000n]);
    const genesisPool = local.at(local.poolGenesis, 0, 'pool', local.poolId);
    const init = core.call('pool-init', {
      ...local.common(), adminSecretKey: bytesToHex(local.admin), pool: genesisPool, provider: local.owned(local.at(m, 1, 'token'), erin),
      kasIn: 300n * KAS, tokensIn: 30_000_000n, positionOwner: xonly(erin), tokenValue: TOKEN_VALUE, positionValue: POSITION_VALUE,
    }).value;
    const forged = structuredClone(init.transaction);
    forged.outputs[0].scriptPublicKey = forged.outputs[1].scriptPublicKey;
    expect(() => followPool(init.txid, forged, genesisPool.utxo, local.poolId, layouts, scriptOf)).toThrow(PoolFollowError);
    const program = parsePushes(hexToBytes(init.transaction.inputs.find((i: any) => i.previousOutpoint.transactionId === genesisPool.utxo.transactionId).signatureScript)).at(-1)!;
    expect(decodePoolProgram(program, layouts.pool)).toEqual(poolOf(genesisPool.state));
  });
});

describe('the pool follower across a pause', () => {
  it('follows the guardian pause and the admin resume, which move no kUSDT; no tick while paused', () => {
    const c = offlineChain('pool-pause');
    let pool: any = c.at(c.poolGenesis, 0, 'pool', c.poolId);
    const step = (built: any) => {
      const move = followPool(built.txid, built.transaction, pool.utxo, c.poolId, layouts, scriptOf);
      expect(move).not.toBeNull();
      pool = { utxo: { ...move!.pool.utxo, covenantId: c.poolId }, state: move!.pool.state };
      return move!;
    };
    // This pool was never opened: nobody's tick moves it from its genesis outpoint, where the launch check looks for it
    // and the admin's first deposit spends it (round 11, R11-OWN-1).
    expect(() => core.call('pool-tick', { ...c.common(), pool: aged(pool, 1_000n), nowDaa: 2_000 })).toThrow(/has not been opened/);
    const pause = core.call('pool-pause', { ...c.common(), pool, secretKey: bytesToHex(c.guardian) }).value;
    const paused = step(pause);
    expect(paused.spend.entry).toBe('pause');
    expect(paused.reserve).toBeNull();
    expect(pool.state.paused).toBe(true);
    expect(() => core.call('pool-unpause', { ...c.common(), pool, secretKey: bytesToHex(c.guardian) })).toThrow(/not the pool's admin/);
    // A paused pool takes no second pause, as the minter (round 11, COV-2).
    expect(() => core.call('pool-pause', { ...c.common(), pool, secretKey: bytesToHex(c.guardian) })).toThrow(/already paused/);
    // No tick while paused: the breaker stands still.
    expect(() => core.call('pool-tick', { ...c.common(), pool: { ...pool, utxo: { ...pool.utxo, blockDaaScore: 1_000n } }, nowDaa: 2_000 })).toThrow(/paused/);
    const resume = core.call('pool-unpause', { ...c.common(), pool, secretKey: bytesToHex(c.admin) }).value;
    expect(step(resume).spend.entry).toBe('unpause');
    expect(pool.state.paused).toBe(false);
    // Resumed, it can be paused again, and it still takes no tick before the first deposit.
    expect(step(core.call('pool-pause', { ...c.common(), pool, secretKey: bytesToHex(c.guardian) }).value).spend.entry).toBe('pause');
    expect(() => core.call('pool-tick', { ...c.common(), pool: aged(c.at(resume, 0, 'pool', c.poolId), 1_000n), nowDaa: 2_000 })).toThrow(/has not been opened/);
  });
});
