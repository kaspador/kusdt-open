// Second outside review of rc.22, deep round, D6-2. The pool's kUSDT reserve sits at an address of its own, and
// anyone can fill it with coins until a node cannot list it. The wallet then builds nothing on the pool, as it
// should, but said "the address the pool is at" and "it ends when the pool next moves": a tick moves the pool and
// leaves the reserve where it was (the reserve's address follows from its amount alone), so the message was wrong
// about what is full and about what ends it. A fake node stands in for kaspad (test/flooded.ts).

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { freshPool } from '@/kusdt/pool';
import { PoolUnreadable, p2shAddressOf, poolValue, reserveStateOf, scriptOf } from '@/kusdt/verify';
import { local, session } from '@/lib/storage';
import type { PoolState } from '@/kusdt/types';
import { COVENANT, NET, POOL } from './helpers';
import { holder } from './flooded';

beforeEach(async () => {
  for (const k of ['kusdt.pending.simnet', 'kusdt.unreadable.simnet']) await session.remove(k);
  await local.remove('kusdt.positions.simnet');
});
afterEach(() => { vi.restoreAllMocks(); });

const KAS = 100_000_000n;
const POOL_STATE: PoolState = { tokenCovid: COVENANT, kasReserve: 200n * KAS, tokenReserve: 20_000_000n, totalShares: 200n * KAS, protocolKas: 0n, protocolTokens: 0n, baseValue: KAS, admin: '11'.repeat(32), maxOutBps: 1_000n, windowLen: 36_000n, windowCredit: 0n, windowRef: 0n, windowOut: 0n, paused: false, guardian: '22'.repeat(32) };

/** A pool and its reserve on the fake node, as the coordinator names them. */
function world(tag: string) {
  const h = holder(tag, []);
  const pspk = scriptOf(h.ctx, 'Pool', POOL_STATE), reserve = reserveStateOf(POOL, POOL_STATE), rspk = scriptOf(h.ctx, 'KCC20', reserve);
  const ptx = tag.padEnd(64, '0');
  const poolAddress = p2shAddressOf(pspk, NET.prefix), reserveAddress = p2shAddressOf(rspk, NET.prefix);
  h.node.utxoSet.push(
    { address: poolAddress, transactionId: ptx, index: 0, amount: poolValue(POOL_STATE), scriptPublicKey: pspk, blockDaaScore: 1n, isCoinbase: false, covenantId: POOL },
    { address: reserveAddress, transactionId: ptx, index: 1, amount: 150_000_000n, scriptPublicKey: rspk, blockDaaScore: 1n, isCoinbase: false, covenantId: COVENANT },
  );
  h.ctx.api!.pool = async () => ({ pool: { utxo: { transactionId: ptx, index: 0 }, state: POOL_STATE }, reserve: { utxo: { transactionId: ptx, index: 1 }, state: reserve } });
  return { h, ptx, poolAddress, reserveAddress };
}

describe("the pool's kUSDT reserve at an address the node cannot list (D6-2)", () => {
  it('is refused, and the message names the reserve and says a tick does not end it', async () => {
    const { h, ptx, reserveAddress } = world('d62a');
    expect((await freshPool(h.ctx)).pool.utxo.transactionId).toBe(ptx);
    h.node.full.add(reserveAddress);
    const e = await freshPool(h.ctx).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(PoolUnreadable);
    const said = (e as Error).message;
    expect(said).toMatch(/kUSDT reserve/);
    expect(said).toMatch(/tick/);
    expect(said).not.toMatch(/ends when the pool next moves/);
    expect(said).toMatch(/Nothing was sent/);
    expect(said).not.toMatch(new RegExp(String.fromCharCode(0x2014)));
  });

  it("the pool's own address full is said as before, and does not blame the reserve", async () => {
    const { h, poolAddress } = world('d62b');
    h.node.full.add(poolAddress);
    const e = await freshPool(h.ctx).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(PoolUnreadable);
    const said = (e as Error).message;
    expect(said).toMatch(/the address the pool is at/);
    expect(said).not.toMatch(/reserve/);
    expect(said).toMatch(/Nothing was sent/);
  });

  it('both full: the message names both', async () => {
    const { h, poolAddress, reserveAddress } = world('d62c');
    h.node.full.add(poolAddress);
    h.node.full.add(reserveAddress);
    const e = await freshPool(h.ctx).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(PoolUnreadable);
    expect((e as Error).message).toMatch(/the pool and its kUSDT reserve/);
  });
});
