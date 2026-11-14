// End to end against the live local stack (bridge/devnet: npm run local:stack),
// through the wallet's own code: deposits on both chains, the mints, a kUSDT
// send, a redemption to chain 2 released in USDT, swaps both ways on the seeded
// pool, liquidity in and out, and a recipient Ethereum's USDT blocks (SPEC §9):
// refused before any burn, and a burn that lands anyway held as `blocked`, then
// paid once unblocked. Skipped unless KUSDT_STACK=1. It never starts or stops
// the stack, uses only a fresh wallet funded by the faucet, and takes every
// address it blacklists off the list again.

import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { core, devKey, NET } from './helpers';
import { KaspaNodeClient } from '@/kaspa/node';
import { mergeConfig } from '@/config/settings';
import { CoordinatorClient } from '@/kusdt/api';
import { newMnemonic, hdFromMnemonic, walletKeys, kaspaPrivateKey, evmPrivateKey } from '@/keys/derive';
import { signerOf } from '@/wallet/context';
import { planKasSend, sendKas, kasBalance } from '@/kaspa/kas';
import { loadTokens, planSend, executeSend, burnOwner } from '@/kusdt/tokens';
import { planRedeem, executeRedeem, recipientCheck, redeemCheck, redeemStatus } from '@/kusdt/redeem';
import { ownerOfAddress } from '@/kusdt/owner';
import {
  freshPool, quoteBuy, quoteSell, quoteAdd, quoteRemove, minimumFor, swap, addLiquidity, removeLiquidity, loadPositions, tokensForKas,
  BreakerLimit, MAX_SWAP_INPUT, QuoteChanged, largestSellWithin, quoteSellAt, sellNowDaa, type AddArgs, type RemoveArgs, type SwapArgs,
} from '@/kusdt/pool';
import { CORE_MIN_CHANGE } from '@/kusdt/build';
import { EthRpc } from '@/evm/rpc';
import { deposit, depositFeeMax, tokenBalance } from '@/evm/vault';
import { verifyPool } from '@/kusdt/verify';
import type { Ctx, Signer } from '@/kusdt/types';
import type { ChainKey } from '@/config/defaults';

const RUN = process.env.KUSDT_STACK === '1';
const FAUCET = process.env.KUSDT_FAUCET ?? 'http://127.0.0.1:9099';
const KAS = 100_000_000n;
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

async function waitFor<T>(what: string, f: () => Promise<T | null | undefined | false>, ms = 120_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await f().catch(() => null);
    if (v) return v as T;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(1_000);
  }
}

describe.skipIf(!RUN)('the wallet on the live local stack', () => {
  const record: Record<string, unknown> = {};
  const txids: Record<string, string> = {};
  let stack: any;
  let ctx: Ctx;
  let signer: Signer;
  let kasAddresses: string[];
  let keyFor: (a: string) => Uint8Array | null;
  let evm: { address: string; key: () => Uint8Array };
  const rpcs = {} as Record<ChainKey, EthRpc>;
  const bob = devKey('stack-bob');
  /** Addresses this run put on chain 1's mock USDT blacklist, taken off again in afterAll whatever happens. */
  const listed = new Set<string>();
  const blacklist = async (address: string, blocked: boolean) => {
    const r = await fetch(`${FAUCET}/blacklist`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ chain: 1, address, blocked }) });
    if (!r.ok) throw new Error(`/blacklist: HTTP ${r.status} ${await r.text()}`);
    if (blocked) listed.add(address); else listed.delete(address);
    return r.json();
  };

  const snapshot = async () => {
    const [kas, tokens, usdt1, usdt2] = await Promise.all([
      kasBalance(ctx.node, ctx.network, kasAddresses), loadTokens(ctx, signer),
      tokenBalance(rpcs.ethereum, ctx.config.chains.ethereum.token, evm.address), tokenBalance(rpcs.bsc, ctx.config.chains.bsc.token, evm.address),
    ]);
    return { kas: kas.total.toString(), kusdt: tokens.total.toString(), kusdtStates: tokens.states.length, usdtEthereumLocal: usdt1.toString(), usdtBscLocal: usdt2.toString() };
  };
  const kusdtIs = (amount: bigint) => waitFor(`kUSDT ${amount}`, async () => (await loadTokens(ctx, signer)).total === amount);

  beforeAll(async () => {
    stack = await (await fetch(`${FAUCET}/stack`)).json();
    const dep = stack.deployment;
    const chainCfg = (c: any) => ({ name: c.name, chainId: c.chainId, vault: c.vault, token: c.token, decimals: c.decimals, rpcUrls: [c.rpc] });
    const config = mergeConfig('simnet', {
      nodeUrl: stack.kaspa.rpc, apiUrl: stack.api, covenantId: dep.kaspa.covenantId, poolId: dep.kaspa.poolId, tokenValue: String(dep.kaspa.tokenValue),
      chains: { ethereum: chainCfg(stack.evm.find((c: any) => c.chain === 1)), bsc: chainCfg(stack.evm.find((c: any) => c.chain === 2)) },
    });
    ctx = { core, node: new KaspaNodeClient('simnet', config.nodeUrl), api: new CoordinatorClient(config.apiUrl), network: 'simnet', net: NET, config };
    for (const k of ['ethereum', 'bsc'] as const) { const c = config.chains[k]; rpcs[k] = new EthRpc(c.rpcUrls, c.chainId, c.name, 'ETH'); }
    const hd = hdFromMnemonic(newMnemonic());
    const keys = walletKeys(hd, NET);
    signer = signerOf(hd, keys);
    kasAddresses = keys.scan.map(k => k.address);
    keyFor = (a) => { const k = keys.scan.find(x => x.address === a); return k ? kaspaPrivateKey(hd, k) : null; };
    evm = { address: keys.evmAddress, key: () => evmPrivateKey(hd) };
    record.wallet = { kaspa: keys.main.address, evm: keys.evmAddress };

    const f = await (await fetch(`${FAUCET}/faucet`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ kaspa: keys.main.address, kas: 3000, evm: keys.evmAddress, usdt: 1000 }) })).json();
    txids.faucetKas = f.kaspaTxid;
    await waitFor('the faucet KAS', async () => (await kasBalance(ctx.node, 'simnet', kasAddresses)).total >= 3000n * KAS);
    record.before = await snapshot();
    // The coordinator's own newest pool, verified on the node (no wallet hint involved).
    const vp = await verifyPool(ctx, await ctx.api!.pool());
    record.poolAtStart = { txid: vp.pool.utxo.transactionId, kasReserve: vp.pool.state.kasReserve.toString(), tokenReserve: vp.pool.state.tokenReserve.toString() };
  }, 180_000);

  /**
   * A pool move the user approved at `quoted`. When the pool moved meanwhile and gives less, the wallet stops
   * (QuoteChanged) and sends nothing; the user here confirms the new numbers once, as a person would.
   */
  const requoted: unknown[] = [];
  async function confirmed<A extends { quoted: unknown }, R>(f: (a: A) => Promise<R>, args: A): Promise<R> {
    try { return await f(args); }
    catch (e) {
      if (!(e instanceof QuoteChanged)) throw e;
      requoted.push({ seen: String(e.seen), now: String(e.now) });
      return f({ ...args, quoted: e.now });
    }
  }
  const swapAt = (a: SwapArgs) => confirmed((x: SwapArgs) => swap(ctx, signer, kasAddresses, x), a);
  const addAt = (a: AddArgs) => confirmed((x: AddArgs) => addLiquidity(ctx, signer, kasAddresses, x), a);
  const removeAt = (a: RemoveArgs) => confirmed((x: RemoveArgs) => removeLiquidity(ctx, signer, kasAddresses, x), a);

  /** The coordinator's /pool, verified, once it names the pool output of `txid`. */
  const coordinatorPoolAt = (txid: string) => waitFor(`/pool at ${txid}`, async () => {
    const p = await verifyPool(ctx, await ctx.api!.pool());
    return p.pool.utxo.transactionId === txid ? p : null;
  });

  afterAll(async () => {
    for (const a of [...listed]) await blacklist(a, false).catch(e => console.error(`could not take ${a} off the blacklist: ${e}`));
    record.txids = txids;
    record.requoted = requoted;
    if (process.env.KUSDT_E2E_OUT) writeFileSync(process.env.KUSDT_E2E_OUT, JSON.stringify(record, null, 2));
    // Public data only: addresses, txids, balances.
    console.log('STACK E2E RECORD', JSON.stringify(record, null, 2));
    ctx?.node.close();
  });

  it('deposits USDT on both chains from the wallet EVM account, and both are minted', async () => {
    const amounts: Record<ChainKey, bigint> = { ethereum: 100_000_000n, bsc: 50_000_000n };
    let minted = 0n;
    for (const chain of ['ethereum', 'bsc'] as const) {
      const c = ctx.config.chains[chain];
      const key = evm.key();
      const what = { rpc: rpcs[chain], vault: c.vault, token: c.token, decimals: c.decimals, resetAllowanceFirst: chain === 'ethereum',
        from: evm.address, units: amounts[chain], ownerScheme: 0, ownerHex: signer.ownerHex, minMinted: 0n };
      // As the Bridge screen does: the fee ceiling it would show, then held to.
      const r = await deposit({ ...what, key, maxNetworkFee: await depositFeeMax(what) });
      key.fill(0);
      txids[`deposit-${chain}`] = r.hash;
      const d = await waitFor(`deposit ${chain} #${r.event.nonce} minted`, async () => { const d = await ctx.api!.deposit(chain, r.event.nonce); return d?.status === 'minted' ? d : null; }, 180_000);
      expect(d.chain).toBe(chain === 'ethereum' ? 1 : 2);
      expect(BigInt(d.minted)).toBe(r.event.minted);
      txids[`mint-${chain}`] = d.kaspaTxid;
      minted += r.event.minted;
    }
    await kusdtIs(minted);
    record.afterDeposits = await snapshot();
    expect(minted).toBe(149_000_000n); // 100 − 0.5 and 50 − 0.5 (SPEC §8 minimum deposit fee)
  }, 400_000);

  it('sends 10 kUSDT', async () => {
    const plan = await planSend(ctx, signer, kasAddresses, { to: ownerOfAddress(bob.address, NET.prefix), amount: 10_000_000n });
    const { txid } = await executeSend(ctx, signer, kasAddresses, plan, (t) => { txids[`merge-${t.slice(0, 8)}`] = t; });
    txids.send = txid;
    await kusdtIs(139_000_000n);
    const bobs = await waitFor("bob's state", async () => { const t = await ctx.api!.tokens(bob.xonly); return t.states.length ? t : null; });
    expect(bobs.states.some((s: any) => s.utxo.transactionId === txid)).toBe(true);
  }, 200_000);

  it('redeems 20 kUSDT to chain 2; it is released and the USDT arrives', async () => {
    const usdtBefore = await tokenBalance(rpcs.bsc, ctx.config.chains.bsc.token, evm.address);
    const q = await redeemCheck(ctx, 'bsc', 20_000_000n);
    expect(q.problem).toBeNull();
    // Above bsc-local's backing (50 USDT deposited here, minus what others redeemed): refused before any burn.
    const tooMuch = await redeemCheck(ctx, 'bsc', 10n ** 15n);
    expect(tooMuch.problem).toMatch(/release capacity|backing|right now/);
    await expect(planRedeem(ctx, signer, kasAddresses, { chain: 'bsc', address: evm.address, amount: 10n ** 15n })).rejects.toThrow();
    record.refusedRedeem = tooMuch.problem;
    const plan = await planRedeem(ctx, signer, kasAddresses, { chain: 'bsc', address: evm.address, amount: 20_000_000n });
    const r = await executeRedeem(ctx, signer, kasAddresses, plan);
    txids.redeem = r.txid;
    expect(r.reported).toBe(true);
    const s = await waitFor('released', async () => { const s = await redeemStatus(ctx, r.txid, 0); return s.status === 'released' ? s : null; }, 240_000);
    txids.release = s.evmTxHash ?? '';
    const usdtAfter = await waitFor('USDT on bsc-local', async () => { const b = await tokenBalance(rpcs.bsc, ctx.config.chains.bsc.token, evm.address); return b > usdtBefore ? b : null; });
    expect(usdtAfter - usdtBefore).toBe((20_000_000n - q.fee!) * 10n ** 12n);
    await kusdtIs(119_000_000n);
  }, 400_000);

  it("refuses a sell above the circuit breaker's room before anything is merged, built or sent, naming the largest that fits", async () => {
    const vp = await freshPool(ctx);
    const nowDaa = sellNowDaa(vp.pool.state, await ctx.node.virtualDaa());
    const room = quoteSellAt(ctx, vp.pool.state, 0n, nowDaa, vp.pool.utxo.blockDaaScore === undefined ? undefined : BigInt(vp.pool.utxo.blockDaaScore)).breaker;
    // The smallest sell above the room, whatever the wallet holds (SPEC §15: at most 10 % of the KAS reserve per window).
    const fit = largestSellWithin(ctx, vp.pool.state, room.maxKasOut, MAX_SWAP_INPUT);
    const tooMuch = fit + 1n;
    expect(quoteSell(ctx, vp.pool.state, tooMuch)).toBeGreaterThan(room.maxKasOut);
    const before = await loadTokens(ctx, signer);
    const e = await swap(ctx, signer, kasAddresses, { side: 'sell', amountIn: tooMuch, minOut: CORE_MIN_CHANGE, quoted: 1n }).catch(x => x);
    expect(e).toBeInstanceOf(BreakerLimit);
    // The wallet's own check, a moment later: never a smaller room than this pool state allows, and its largest sell fits it.
    // (A moment later the window has moved a little: the wallet's room is within a hair of this one, either way.)
    expect(e.maxKasOut).toBeGreaterThanOrEqual((room.maxKasOut * 99n) / 100n);
    expect(e.maxTokensIn).toBeLessThan(tooMuch);
    expect(quoteSell(ctx, vp.pool.state, e.maxTokensIn)).toBeLessThanOrEqual(e.maxKasOut);
    // Nothing moved: the same token states, so no merge and no sell went out.
    const after = await loadTokens(ctx, signer);
    expect(after.states.map(s => `${s.utxo.transactionId}:${s.utxo.index}`)).toEqual(before.states.map(s => `${s.utxo.transactionId}:${s.utxo.index}`));
    record.breaker = {
      kasReserve: vp.pool.state.kasReserve.toString(), windowCredit: vp.pool.state.windowCredit.toString(), windowOut: vp.pool.state.windowOut.toString(),
      nowDaa: nowDaa.toString(), roomKas: room.maxKasOut.toString(), windowEndsDaa: room.windowEndsDaa.toString(),
      largestSell: fit.toString(), refusedSell: tooMuch.toString(), message: e.message,
    };
  }, 120_000);

  it('swaps both ways on the seeded pool, never below the minimum, the sell held to the breaker', async () => {
    const vp = await freshPool(ctx);
    record.poolBefore = { kasReserve: vp.pool.state.kasReserve.toString(), tokenReserve: vp.pool.state.tokenReserve.toString() };
    const kasIn = 10n * KAS;
    const buyQ = quoteBuy(ctx, vp.pool.state, kasIn);
    const buy = await swapAt({ side: 'buy', amountIn: kasIn, minOut: minimumFor(buyQ, 100), quoted: buyQ });
    txids.swapBuy = buy.txid;
    expect(buy.amountOut).toBeGreaterThanOrEqual(minimumFor(buyQ, 100));
    await kusdtIs(119_000_000n + buy.amountOut);

    // 5 kUSDT, or less when the breaker's window has less room left (the stack's pool runs for days).
    const vp2 = await coordinatorPoolAt(buy.txid);
    const room = quoteSellAt(ctx, vp2.pool.state, 0n, sellNowDaa(vp2.pool.state, await ctx.node.virtualDaa()), vp2.pool.utxo.blockDaaScore === undefined ? undefined : BigInt(vp2.pool.utxo.blockDaaScore)).breaker.maxKasOut;
    const sold = largestSellWithin(ctx, vp2.pool.state, room, 5_000_000n);
    const sellQ = quoteSell(ctx, vp2.pool.state, sold);
    record.swaps = { buy: { kasIn: kasIn.toString(), kusdtOut: buy.amountOut.toString(), tries: buy.tries } };
    if (minimumFor(sellQ, 100) < CORE_MIN_CHANGE) {
      // The window's room is spent: no sell fits until it reopens (checked above), so none is made.
      record.swaps = { ...record.swaps as object, sell: `skipped: the breaker's window has ${room} sompi left` };
      txids.swapSell = buy.txid;
      return;
    }
    const sell = await swapAt({ side: 'sell', amountIn: sold, minOut: minimumFor(sellQ, 100), quoted: sellQ });
    txids.swapSell = sell.txid;
    expect(sell.amountOut).toBeGreaterThanOrEqual(minimumFor(sellQ, 100));
    expect(sell.amountOut).toBeLessThanOrEqual(room);
    await kusdtIs(119_000_000n + buy.amountOut - sold);
    record.swaps = { ...record.swaps as object, sell: { kusdtIn: sold.toString(), kasOut: sell.amountOut.toString(), tries: sell.tries, roomKas: room.toString() } };
  }, 300_000);

  it('adds liquidity, then removes it', async () => {
    const vp = await coordinatorPoolAt(txids.swapSell);
    const before = (await loadTokens(ctx, signer)).total;
    const kasIn = 20n * KAS;
    const tokensIn = tokensForKas(vp.pool.state, kasIn);
    const shares = quoteAdd(ctx, vp.pool.state, kasIn, tokensIn);
    const add = await addAt({ kasIn, tokensIn, minShares: minimumFor(shares, 100), quoted: shares });
    txids.lpAdd = add.txid;
    const pos = await waitFor('the position', async () => (await loadPositions(ctx, signer)).find(p => p.id === `${add.txid}:1`));
    expect(pos.located.state.shares).toBe(add.shares);
    // What the add really put in: the wallet trims both sides to what the shares need (round 10), never more than asked.
    expect(add.tokensIn <= tokensIn && add.kasIn <= kasIn).toBe(true);
    await kusdtIs(before - add.tokensIn);

    // The coordinator follows liquidity moves now, and lists the position. Since its API is a process of its own,
    // /pool comes from a copy written every second and /positions from the coordinator's last save, a few seconds
    // behind (coordinator-api.md, "Where the answers come from"): wait for the listing rather than expect it at once.
    const vp2 = await coordinatorPoolAt(add.txid);
    expect(await waitFor("the position in the coordinator's list", async () => (await ctx.api!.positions(signer.ownerHex)).positions.some((p: any) => p.utxo.transactionId === add.txid && p.utxo.index === 1), 30_000)).toBe(true);
    const out = quoteRemove(ctx, vp2.pool.state, add.shares);
    const rm = await removeAt({ position: pos.id, minKas: minimumFor(out.kasOut, 100), minTokens: minimumFor(out.tokensOut, 100), quoted: out });
    txids.lpRemove = rm.txid;
    await kusdtIs(before - add.tokensIn + rm.tokensOut);
    expect(await waitFor('the position gone', async () => (await loadPositions(ctx, signer)).length === 0)).toBe(true);
    await coordinatorPoolAt(rm.txid);
    record.liquidity = { kasIn: add.kasIn.toString(), tokensIn: add.tokensIn.toString(), shares: add.shares.toString(), kasOut: rm.kasOut.toString(), tokensOut: rm.tokensOut.toString() };
    record.after = await snapshot();
  }, 300_000);

  it("refuses a burn to an address Ethereum's USDT blocks; one that lands anyway is held as blocked, then paid once unblocked", async () => {
    const frozen = '0x' + randomBytes(20).toString('hex');
    const listedNow = await blacklist(frozen, true);
    expect(listedNow.honoured).toBe(true); // chain 1's deployment names the isBlackListed view
    const asked = await waitFor('/recipients to see the blacklist', async () => { const r = await recipientCheck(ctx, 'ethereum', frozen); return r.blocked ? r : null; }, 30_000);
    expect(asked).toMatchObject({ payable: false, checked: true, blocked: true });
    // The wallet names the chain as its Local preset does ("Ethereum (local)"), not as the stack calls it.
    expect(asked.problem).toMatch(/USDT on Ethereum \(local\) blocks this address/);
    // Refused before anything is built, with no other chain offered.
    const before = (await loadTokens(ctx, signer)).total;
    const refused = await planRedeem(ctx, signer, kasAddresses, { chain: 'ethereum', address: frozen, amount: 5_000_000n }).then(() => null, (e: Error) => e.message);
    expect(refused).toMatch(/blocks this address/);
    expect(refused).not.toMatch(/BNB Chain \(local\)|bsc-local|instead|can pay it now/);
    record.refusedBlockedRecipient = refused;
    // BNB Chain's USDT keeps no blocklist (as on mainnet): its vault would pay the same address.
    expect((await recipientCheck(ctx, 'bsc', frozen)).payable).toBe(true);

    // A burn built past the wallet's checks (as another wallet might): held, never paid while blocked.
    const units = 5_000_000n;
    const plan = await planSend(ctx, signer, kasAddresses, { to: burnOwner(ctx, 1, frozen), amount: units, redeem: { chain: 1, address: frozen } });
    const { txid, built } = await executeSend(ctx, signer, kasAddresses, plan);
    txids.blockedBurn = txid;
    await ctx.api!.postRedeem({ transaction: built.transaction, transactionId: txid });
    await waitFor('the burn held as blocked', async () => (await redeemStatus(ctx, txid, 0)).status === 'blocked', 240_000);
    const held = await ctx.api!.redeem(txid, 0);
    expect(held.lastError).toMatch(/blocks/);
    expect(typeof held.nextTry).toBe('number');
    const token = ctx.config.chains.ethereum.token;
    expect(await tokenBalance(rpcs.ethereum, token, frozen)).toBe(0n);
    record.heldRedeem = { status: held.status, lastError: held.lastError };

    // Unblocked: the coordinator checks again (every 3 s on the local stack) and pays.
    await blacklist(frozen, false);
    const s = await waitFor('released once unblocked', async () => { const s = await redeemStatus(ctx, txid, 0); return s.status === 'released' ? s : null; }, 240_000);
    txids.unblockedRelease = s.evmTxHash ?? '';
    const q = await redeemCheck(ctx, 'ethereum', units);
    expect(await waitFor('USDT at the unblocked address', async () => { const b = await tokenBalance(rpcs.ethereum, token, frozen); return b > 0n ? b : null; })).toBe(units - q.fee!);
    await kusdtIs(before - units);
  }, 600_000);
});
