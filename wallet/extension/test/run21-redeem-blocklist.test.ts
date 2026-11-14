// Run 21 fixes, Daybreak [24] (the rc.23 report, reproduced on rc.24 by run 21's wallet review). Before a burn the
// wallet took the coordinator's word (GET /recipients) that the token does not block the recipient. A coordinator
// answering "payable" for an address USDT blocks had kUSDT burnt that every honest signer then refuses to pay: held
// for as long as the token blocks the address, with no way to send it elsewhere. Now the wallet also asks the token
// itself, through the view its pinned deployment names (isBlackListed for Ethereum's USDT; BSC-USD keeps none), on each
// of the chain RPCs the vault is read over, when the burn is planned and again right before it is sent. One RPC
// saying blocked refuses the burn, and so does none answering.

import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { selector } from '@/evm/abi';
import { DEFAULTS } from '@/config/defaults';
import { mergeConfig } from '@/config/settings';
import { executeRedeem, planRedeem, VAULT_READER } from '@/kusdt/redeem';
import { plainState } from '@/kusdt/owner';
import { p2shAddressOf, scriptOf } from '@/kusdt/verify';
import { session } from '@/lib/storage';
import { COVENANT, FakeNode, NET, devKey, fakeApi, kasCoin, lastBuilt, recipientAnswer, signerFor, testCtx } from './helpers';

const A = '0x90F79bf6EB2c4f870365E785982E1f101E93b906';
const USDT = 1_000_000n;
const word = (n: bigint) => '0x' + n.toString(16).padStart(64, '0');
const BLOCKED_VIEW = selector('isBlackListed(address)');
const VIEWS: Record<string, bigint> = {
  [selector('paused()')]: 0n, [selector('unreservedBacking()')]: 500_000n * USDT, [selector('releaseAvailable()')]: 400_000n * USDT,
  [selector('reservedUnits()')]: 0n, [selector('releaseCapacity()')]: 400_000n * USDT,
};
const rosyStatus = () => ({ chains: [1, 2].map((chain) => ({
  chain, name: chain === 1 ? 'ethereum-local' : 'bsc-local', chainId: 31336 + chain, paused: false,
  backing: 1_000_000_000_000, unreservedBacking: 1_000_000_000_000, reservedUnits: 0, releaseAvailable: 1_000_000_000_000,
  fees: { feeBps: 20, minDepositFee: 500000, minReleaseFee: 500000, minDeposit: 10000000, maxDeposit: 100000000000, releaseCapacity: 1_000_000_000_000, releaseRefillPerSecond: 2893518 },
})) });

/** What one RPC says when the token is asked: blocked, not blocked, nothing (down), or a word that is neither. */
type Says = 'yes' | 'no' | 'down' | 'odd';

const reader = VAULT_READER.rpc;
afterEach(() => { VAULT_READER.rpc = reader; });
beforeEach(async () => { await session.remove('kusdt.pending.simnet'); lastBuilt.txid = ''; });

/**
 * A wallet with kUSDT in a state per amount, whose coordinator always says the recipient is payable. `token.says`:
 * what each RPC (by URL) answers about the recipient; `asked`: each time the token was asked, where and about whom.
 */
function wallet(tag: string, amounts: bigint[] = [60_000n * USDT], rpcUrls?: string[]) {
  const alice = devKey(`r21-blocklist-${tag}`);
  const node = new FakeNode();
  const states = amounts.map((a, i) => ({ txid: `${tag}${i}`.padEnd(64, '0'), state: plainState({ ownerScheme: 0, owner: alice.xonly }, a) }));
  const ctx = testCtx(node, fakeApi({
    status: async () => rosyStatus(),
    tokens: async () => ({ states: states.map(s => ({ utxo: { transactionId: s.txid, index: 0 }, state: { ...s.state, amount: Number(s.state.amount) } })) }),
    recipient: async (chain, addr) => recipientAnswer(chain, addr),
  }));
  if (rpcUrls) ctx.config.chains.ethereum.rpcUrls = rpcUrls;
  for (const s of states) {
    const spk = scriptOf(ctx, 'KCC20', s.state);
    node.utxoSet.push({ address: p2shAddressOf(spk, NET.prefix), transactionId: s.txid, index: 0, amount: 150_000_000n, scriptPublicKey: spk, blockDaaScore: 5n, isCoinbase: false, covenantId: COVENANT });
  }
  node.utxoSet.push(kasCoin(alice, `${tag}c`.padEnd(64, '1'), 1_000_000_000n), kasCoin(alice, `${tag}d`.padEnd(64, '2'), 1_000_000_000n));
  const token: { says: Record<string, Says> } = { says: {} };
  const asked: { rpc: string; to: string; about: string }[] = [];
  VAULT_READER.rpc = (ch) => ({
    ethCall: async (to: string, data: string) => {
      if (data.slice(0, 10) === BLOCKED_VIEW) {
        const rpc = ch.rpcUrls.join(' ');
        asked.push({ rpc, to: to.toLowerCase(), about: '0x' + data.slice(34, 74) });
        const says = token.says[rpc] ?? 'no';
        if (says === 'down') throw new Error('rpc down');
        return says === 'odd' ? word(2n) : word(says === 'yes' ? 1n : 0n);
      }
      const view = VIEWS[data.slice(0, 10)];
      return word(view ?? 500_000n); // the release fee for anything else (releaseFeeOf)
    },
  });
  return { ctx, node, signer: signerFor(alice), kas: [alice.address], token, asked };
}
type W = ReturnType<typeof wallet>;
const plan = (w: W, chain: 'ethereum' | 'bsc' = 'ethereum', amount = 50_000n * USDT) => planRedeem(w.ctx, w.signer, w.kas, { chain, address: A, amount });
const isBurn = (json: string) => (JSON.parse(json).payload ?? '').startsWith('4b55534454'); // "KUSDT"

describe('Daybreak [24]: the token itself is asked whether it blocks the recipient, not only the coordinator', () => {
  it('the coordinator says payable and the token says blocked: refused before anything is built or signed', async () => {
    const w = wallet('a1');
    const rpc = w.ctx.config.chains.ethereum.rpcUrls.join(' ');
    w.token.says[rpc] = 'yes';
    const e = await plan(w).then(() => null, (x: Error) => x);
    expect(e?.message).toMatch(/USDT on Ethereum \(local\) blocks this address/);
    expect(e?.message).toMatch(/bridge server said/);
    expect(e?.message).toMatch(/Nothing was burnt/);
    expect(lastBuilt.txid).toBe('');
    expect(w.node.submitted).toEqual([]);
  });

  it('asks the pinned token, about exactly the recipient, on the chain\'s own RPC: at the plan and again right before the burn', async () => {
    const w = wallet('a2');
    const p = await plan(w);
    expect(w.asked).toEqual([{ rpc: 'http://127.0.0.1:8545', to: w.ctx.config.chains.ethereum.token.toLowerCase(), about: A.toLowerCase() }]);
    await executeRedeem(w.ctx, w.signer, w.kas, p);
    expect(w.asked).toHaveLength(2);
    expect(w.node.submitted).toHaveLength(1);
  });

  it('with two RPCs, one saying blocked is enough to refuse', async () => {
    const w = wallet('a3', undefined, ['http://rpc-a.test', 'http://rpc-b.test']);
    w.token.says['http://rpc-b.test'] = 'yes';
    await expect(plan(w)).rejects.toThrow(/blocks this address/);
    expect(new Set(w.asked.map(a => a.rpc))).toEqual(new Set(['http://rpc-a.test', 'http://rpc-b.test']));
    expect(lastBuilt.txid).toBe('');
  });

  it('no RPC answering is a no, and so is an answer that is neither yes nor no', async () => {
    const down = wallet('a4', undefined, ['http://rpc-a.test', 'http://rpc-b.test']);
    down.token.says = { 'http://rpc-a.test': 'down', 'http://rpc-b.test': 'down' };
    await expect(plan(down)).rejects.toThrow(/Couldn't read from USDT on Ethereum \(local\) whether it blocks this address, so nothing was burnt/);
    const odd = wallet('a5', undefined, ['http://rpc-a.test', 'http://rpc-b.test']);
    odd.token.says = { 'http://rpc-a.test': 'odd', 'http://rpc-b.test': 'down' };
    await expect(plan(odd)).rejects.toThrow(/Couldn't read from USDT/);
    expect(lastBuilt.txid).toBe('');
  });

  it('one RPC down and the other saying not blocked: the burn goes ahead', async () => {
    const w = wallet('a6', undefined, ['http://rpc-a.test', 'http://rpc-b.test']);
    w.token.says['http://rpc-a.test'] = 'down';
    await executeRedeem(w.ctx, w.signer, w.kas, await plan(w));
    expect(w.node.submitted).toHaveLength(1);
    expect(isBurn(w.node.submitted[0])).toBe(true);
  });

  it('blocked between the review and the click: the burn is not sent', async () => {
    const w = wallet('a7');
    const p = await plan(w);
    w.token.says['http://127.0.0.1:8545'] = 'yes';
    await expect(executeRedeem(w.ctx, w.signer, w.kas, p)).rejects.toThrow(/USDT on Ethereum \(local\) blocks this address/);
    expect(w.node.submitted).toEqual([]);
  });

  it('blocked while a merge waits: the merge went out, the burn does not', async () => {
    const w = wallet('a8', [20_000n * USDT, 20_000n * USDT, 20_000n * USDT, 20_000n * USDT]);
    const p = await plan(w, 'ethereum', 80_000n * USDT);
    expect(p.merges).toBe(1);
    w.node.submitImpl = async (json) => {
      if (!isBurn(json)) {
        const v = lastBuilt.value;
        for (const o of v.outputs) {
          const p2sh = /^0000aa20[0-9a-f]{64}87$/.test(o.scriptPublicKey);
          w.node.utxoSet.push({ address: p2sh ? p2shAddressOf(o.scriptPublicKey, NET.prefix) : w.kas[0], transactionId: v.txid, index: o.index, amount: BigInt(o.value), scriptPublicKey: o.scriptPublicKey, blockDaaScore: 7n, isCoinbase: false, covenantId: p2sh ? COVENANT : null });
        }
        w.token.says['http://127.0.0.1:8545'] = 'yes';
      }
      return lastBuilt.txid;
    };
    await expect(executeRedeem(w.ctx, w.signer, w.kas, p)).rejects.toThrow(/blocks this address/);
    expect(w.node.submitted).toHaveLength(1);
    expect(isBurn(w.node.submitted[0])).toBe(false);
  });

  it('BNB Chain\'s USDT keeps no blocklist: nothing is asked of it, and the burn goes out', async () => {
    const w = wallet('a9');
    await executeRedeem(w.ctx, w.signer, w.kas, await plan(w, 'bsc'));
    expect(w.asked).toEqual([]);
    expect(w.node.submitted).toHaveLength(1);
  });

  it('every network names the view its deployment does, and a stored edit can neither drop it nor add one', () => {
    const testnet = JSON.parse(readFileSync(new URL('../../../deployments/testnet.json', import.meta.url), 'utf8'));
    expect(DEFAULTS['testnet-10'].chains.ethereum.blocklist).toBe(testnet.chains[0].blocklist);
    expect(DEFAULTS['testnet-10'].chains.bsc.blocklist).toBe(testnet.chains[1].blocklist ?? null);
    for (const net of ['mainnet', 'testnet-10', 'simnet'] as const) {
      expect(DEFAULTS[net].chains.ethereum.blocklist).toBe('isBlackListed');
      expect(DEFAULTS[net].chains.bsc.blocklist).toBeNull();
    }
    expect(mergeConfig('testnet-10', { chains: { ethereum: { blocklist: null } } }).chains.ethereum.blocklist).toBe('isBlackListed');
    expect(mergeConfig('mainnet', { chains: { bsc: { blocklist: 'isBlackListed' } } }).chains.bsc.blocklist).toBeNull();
  });
});
