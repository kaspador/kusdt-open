// Run 21, Daybreak [15]: Lock did not take back the signing it had already handed out. A signer made while the wallet
// was unlocked still derived keys after lock(), and an action under way (a redemption between its merge and its burn,
// a KAS send confirmed on the Review screen) signed its next transaction after the wallet locked. A signer now refuses
// once the unlock it was made in has ended, whether by Lock in this page or by the phrase leaving the session
// elsewhere (the auto-lock alarm, the close check, Lock in another window), and unlocking again does not revive it.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => {
  const state = {
    wallet: null as unknown,
    // What chrome.storage.onChanged tells every page of the wallet (the session area's changes among them).
    storageListeners: [] as ((changes: Record<string, { oldValue?: unknown; newValue?: unknown }>, area: string) => void)[],
  };
  (globalThis as { chrome?: unknown }).chrome = { storage: { onChanged: { addListener: (fn: (typeof state.storageListeners)[number]) => { state.storageListeners.push(fn); } } } };
  return state;
});
vi.mock('@/popup/state', () => ({ useWallet: () => h.wallet }));

import { createElement } from 'react';
import { selector } from '@/evm/abi';
import { executeRedeem, planRedeem, VAULT_READER } from '@/kusdt/redeem';
import { plainState } from '@/kusdt/owner';
import { p2shAddressOf, scriptOf } from '@/kusdt/verify';
import { session } from '@/lib/storage';
import { keysFor, signerOf } from '@/wallet/context';
import { lock, unlockWith, currentHd, SESSION_KEY } from '@/keys/session';
import { Send } from '@/screens/Send';
import { COVENANT, FakeNode, NET, fakeApi, lastBuilt, recipientAnswer, testCtx } from './helpers';
import { button, cleanup, click, field, mount, typeIn, until } from './fake-dom';
import { BOB, fixture, noNetwork, resetStores } from './screen-fixture';

const PHRASE = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const LOCKED = /locked/i;
const USDT = 1_000_000n;
const word = (n: bigint) => '0x' + n.toString(16).padStart(64, '0');

/** A wallet signing with the unlocked keys, whose kUSDT is in four states: redeeming all of it takes a merge first. */
async function unlockedWallet(tag: string) {
  await unlockWith(PHRASE);
  const hd = (await currentHd())!;
  const keys = keysFor(hd, 'simnet');
  const node = new FakeNode();
  const states = [0, 1, 2, 3].map(i => ({ txid: `${tag}${i}`.padEnd(64, '0'), state: plainState({ ownerScheme: 0, owner: keys.ownerHex }, 20_000n * USDT) }));
  const ctx = testCtx(node, fakeApi({
    status: async () => ({ chains: [1, 2].map(chain => ({
      chain, name: chain === 1 ? 'ethereum-local' : 'bsc-local', chainId: 31336 + chain, paused: false,
      backing: 1_000_000_000_000, unreservedBacking: 1_000_000_000_000, reservedUnits: 0, releaseAvailable: 1_000_000_000_000,
      fees: { feeBps: 20, minDepositFee: 500000, minReleaseFee: 500000, minDeposit: 10000000, maxDeposit: 100000000000, releaseCapacity: 1_000_000_000_000, releaseRefillPerSecond: 2893518 },
    })) }),
    tokens: async () => ({ states: states.map(s => ({ utxo: { transactionId: s.txid, index: 0 }, state: { ...s.state, amount: Number(s.state.amount) } })) }),
    recipient: async (chain, address) => recipientAnswer(chain, address),
  }));
  for (const s of states) {
    const spk = scriptOf(ctx, 'KCC20', s.state);
    node.utxoSet.push({ address: p2shAddressOf(spk, NET.prefix), transactionId: s.txid, index: 0, amount: 150_000_000n, scriptPublicKey: spk, blockDaaScore: 5n, isCoinbase: false, covenantId: COVENANT });
  }
  for (const [n, fill] of [['c', '1'], ['d', '2']]) {
    node.utxoSet.push({ address: keys.main.address, transactionId: `${tag}${n}`.padEnd(64, fill), index: 0, amount: 1_000_000_000n, scriptPublicKey: `000020${keys.ownerHex}ac`, blockDaaScore: 10n, isCoinbase: false, covenantId: null });
  }
  // A vault with room for all of it, and a USDT that does not block the recipient (Daybreak [24]: the token is asked).
  const views: Record<string, bigint> = { 'paused()': 0n, 'unreservedBacking()': 500_000n * USDT, 'releaseAvailable()': 400_000n * USDT, 'reservedUnits()': 0n, 'releaseCapacity()': 400_000n * USDT, 'isBlackListed(address)': 0n };
  const names = Object.fromEntries(Object.keys(views).map(v => [selector(v), v]));
  VAULT_READER.rpc = () => ({ ethCall: async (_to: string, data: string) => word(views[names[data.slice(0, 10)]] ?? 500_000n) });
  return { ctx, node, keys, signer: signerOf(hd, keys), kas: keys.scan.map(k => k.address) };
}

/** Puts every output of the transaction the core just built on the node, as its acceptance would. */
function landLast(node: FakeNode, address: string) {
  const v = lastBuilt.value;
  for (const o of v.outputs) {
    const p2sh = /^0000aa20[0-9a-f]{64}87$/.test(o.scriptPublicKey);
    node.utxoSet.push({ address: p2sh ? p2shAddressOf(o.scriptPublicKey, NET.prefix) : address, transactionId: v.txid, index: o.index, amount: BigInt(o.value), scriptPublicKey: o.scriptPublicKey, blockDaaScore: 7n, isCoinbase: false, covenantId: p2sh ? COVENANT : null });
  }
}

const isBurn = (json: string) => (JSON.parse(json).payload ?? '').startsWith('4b55534454'); // "KUSDT"

beforeEach(async () => { await session.remove('kusdt.pending.simnet'); lastBuilt.txid = ''; });
afterEach(async () => { cleanup(); vi.unstubAllGlobals(); await lock(); });

describe('Daybreak [15]: a signer made before the wallet locks', () => {
  it('hands out no key once lock() has run', async () => {
    await unlockWith(PHRASE);
    const hd = (await currentHd())!;
    const keys = keysFor(hd, 'simnet');
    const signer = signerOf(hd, keys);
    expect(signer.secretFor(keys.main.address)).toMatch(/^[0-9a-f]{64}$/);
    await lock();
    expect(await currentHd()).toBeNull();
    expect(() => signer.secretFor(keys.main.address)).toThrow(LOCKED);
  });

  it('hands out none once the phrase leaves the session elsewhere (the auto-lock alarm, Lock in another window)', async () => {
    await unlockWith(PHRASE);
    const hd = (await currentHd())!;
    const keys = keysFor(hd, 'simnet');
    const signer = signerOf(hd, keys);
    // What every wallet page hears when the background's alarm (or another window) removes the phrase.
    for (const l of h.storageListeners) l({ [SESSION_KEY]: { oldValue: PHRASE } }, 'session');
    expect(() => signer.secretFor(keys.main.address)).toThrow(LOCKED);
    // Other changes to the session (the phrase written at an unlock, another key) take nothing back.
    await unlockWith(PHRASE);
    const again = signerOf((await currentHd())!, keys);
    for (const l of h.storageListeners) l({ [SESSION_KEY]: { newValue: PHRASE } }, 'session');
    for (const l of h.storageListeners) l({ 'kusdt.provider.request': { oldValue: {} } }, 'session');
    for (const l of h.storageListeners) l({ [SESSION_KEY]: { oldValue: PHRASE } }, 'local');
    expect(again.secretFor(keys.main.address)).toMatch(/^[0-9a-f]{64}$/);
  });

  it('stays refused after the wallet is unlocked again; a signer of the new unlock signs', async () => {
    await unlockWith(PHRASE);
    const hd = (await currentHd())!;
    const keys = keysFor(hd, 'simnet');
    const old = signerOf(hd, keys);
    await lock();
    await unlockWith(PHRASE);
    expect(() => old.secretFor(keys.main.address)).toThrow(LOCKED);
    const fresh = signerOf((await currentHd())!, keys);
    expect(fresh.secretFor(keys.main.address)).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('Daybreak [15]: an action under way when the wallet locks', () => {
  it('a redemption locked during its merge sends the merge and stops before signing the burn', async () => {
    const w = await unlockedWallet('f15a');
    const plan = await planRedeem(w.ctx, w.signer, w.kas, { chain: 'ethereum', address: '0x90F79bf6EB2c4f870365E785982E1f101E93b906', amount: 80_000n * USDT });
    expect(plan.merges).toBe(1);
    w.node.submitImpl = async (json) => {
      if (!isBurn(json)) { landLast(w.node, w.keys.main.address); await lock(); }
      return lastBuilt.txid;
    };
    await expect(executeRedeem(w.ctx, w.signer, w.kas, plan)).rejects.toThrow(LOCKED);
    expect(w.node.submitted).toHaveLength(1);
    expect(isBurn(w.node.submitted[0])).toBe(false);
  });

  it('a KAS send confirmed after the wallet locked (the Review still on screen) is not signed', async () => {
    await resetStores();
    vi.stubGlobal('fetch', noNetwork);
    const fx = fixture('f15b');
    h.wallet = fx.wallet;
    const { root } = await mount(createElement(Send, { onBack() {} }));
    await until('the Send screen', () => root.textContent.includes('Send'));
    await click(button(root, /^KAS/));
    await typeIn(field(root, 'kaspasim:…'), BOB);
    await typeIn(field(root, 'Amount'), '5');
    await until('Review to be enabled', () => !button(root, 'Review').disabled);
    await click(button(root, 'Review'));
    await until('the Review', () => root.textContent.includes('You send'));
    await lock();
    await click(button(root, 'Confirm and send'));
    await until('the refusal', () => LOCKED.test(root.textContent) || fx.node.submitted.length > 0);
    expect(fx.node.submitted).toHaveLength(0);
    expect(root.textContent).toMatch(LOCKED);
  });
});
