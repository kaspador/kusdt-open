// Round 11, R11-WW-3: the wallet uses one key path on every Kaspa network, a
// Kaspa signature names no network, and the wallet took its node's word for
// which network it serves. A public node that says "testnet-10" and serves
// the mainnet coins of the user's keys, spelled kaspatest:, had real KAS sent
// under Testnet labels: the transaction and its signature are valid on mainnet.
//
// What is done here: on Testnet with a public node, before a plain KAS send
// is signed, the wallet asks a mainnet node whether the coins it is about to
// spend exist on mainnet, and refuses if they do or if it cannot ask. This
// narrows the finding (a second source has to lie too); only keys of their own
// for test networks would close it (see docs: security/known-limits).

import { beforeEach, describe, expect, it } from 'vitest';
import { schnorr } from '@noble/curves/secp256k1.js';
import { blake2b } from '@noble/hashes/blake2.js';
import { bytesToHex, encodeKaspaAddress } from '@kusdt/kaspa';
import { FakeNode } from './helpers';
import { CoinsAreReal, assertNotMainnetCoins, planKasSend, sendKas } from '@/kaspa/kas';
import { session } from '@/lib/storage';
import type { NodeUtxo } from '@/kaspa/node';

const KAS = 100_000_000n;
const key = (name: string) => {
  const secret = blake2b(new TextEncoder().encode(`r11-network/${name}`), { dkLen: 32 }), xonly = schnorr.getPublicKey(secret);
  return { secret, xonly: bytesToHex(xonly), test: encodeKaspaAddress('kaspatest', 0, xonly), main: encodeKaspaAddress('kaspa', 0, xonly), sim: encodeKaspaAddress('kaspasim', 0, xonly) };
};
const alice = key('alice'), bob = key('bob');
const coinAt = (address: string, txid: string, amount: bigint): NodeUtxo =>
  ({ address, transactionId: txid, index: 0, amount, scriptPublicKey: `000020${alice.xonly}ac`, blockDaaScore: 10n, isCoinbase: false, covenantId: null });
const REAL = 'a1'.repeat(32), TEST = 'b2'.repeat(32);
const keyFor = (a: string) => (a === alice.test || a === alice.sim ? Uint8Array.from(alice.secret) : null);

/** What a node shows the wallet on "testnet-10": the coin `txid` at alice's address, spelled for the test network. */
const testnetNode = (txid: string) => { const node = new FakeNode(); node.utxoSet.push(coinAt(alice.test, txid, 50n * KAS)); node.submitImpl = async () => { throw new Error('the test never lets a transaction out'); }; return node; };
/** An honest mainnet node: alice's real coin sits at her mainnet address. */
const mainnetNode = () => { const node = new FakeNode(); node.utxoSet.push(coinAt(alice.main, REAL, 50n * KAS)); return node; };

beforeEach(async () => { await session.remove('kusdt.pending.testnet-10', 'kusdt.pending.simnet'); });

describe('a plain KAS send on Testnet, with keys that also hold mainnet coins', () => {
  it('is refused, unsigned, when the node shows a mainnet coin of the same key as a test coin', async () => {
    // The lying node: it says testnet-10 and serves the mainnet UTXO of alice's key under her kaspatest: address.
    const liar = testnetNode(REAL);
    const plan = await planKasSend(liar, 'testnet-10', 'kaspatest', { addresses: [alice.test], changeAddress: alice.test, to: bob.test, amount: 10n * KAS });
    expect(plan.plan.inputs.map(u => `${u.txid}:${u.index}`)).toEqual([`${REAL}:0`]);
    let keys = 0;
    const counting = (a: string) => { keys++; return keyFor(a); };
    const e = await sendKas(liar, 'testnet-10', 'kaspatest', plan, counting, mainnetNode()).catch(x => x);
    // Before the fix this signed and submitted a transaction that mainnet accepts.
    expect(e).toBeInstanceOf(CoinsAreReal);
    expect(e.message).toMatch(/real KAS/);
    expect(e.message).toMatch(/Nothing was signed/);
    expect(keys).toBe(0);
    expect(liar.submitted).toHaveLength(0);
  });

  it('goes ahead when a mainnet node does not have those coins', async () => {
    const honest = testnetNode(TEST);
    let sent = '';
    honest.submitImpl = async (json) => { sent = json; throw new Error('stop after the submission'); };
    const plan = await planKasSend(honest, 'testnet-10', 'kaspatest', { addresses: [alice.test], changeAddress: alice.test, to: bob.test, amount: 10n * KAS });
    await expect(sendKas(honest, 'testnet-10', 'kaspatest', plan, keyFor, mainnetNode())).rejects.toThrow('stop after the submission');
    expect(sent).toContain(TEST);
  });

  it('asks the mainnet node about the same keys under their mainnet addresses, and compares outpoints', async () => {
    const asked: string[][] = [];
    const main = { utxos: async (a: string[]) => { asked.push(a); return [coinAt(alice.main, 'c3'.repeat(32), 1n)]; } };
    const plan = await planKasSend(testnetNode(TEST), 'testnet-10', 'kaspatest', { addresses: [alice.test], changeAddress: alice.test, to: bob.test, amount: 10n * KAS });
    await assertNotMainnetCoins(plan, main);
    expect(asked).toEqual([[alice.main]]);
    // The same outpoint there: these are mainnet coins.
    await expect(assertNotMainnetCoins(plan, { utxos: async () => [coinAt(alice.main, TEST, 1n)] })).rejects.toBeInstanceOf(CoinsAreReal);
  });

  it('is refused when mainnet cannot be asked: no answer is not a "no"', async () => {
    const node = testnetNode(TEST);
    const plan = await planKasSend(node, 'testnet-10', 'kaspatest', { addresses: [alice.test], changeAddress: alice.test, to: bob.test, amount: 10n * KAS });
    const down = { utxos: async () => { throw new Error('no node reachable'); } };
    await expect(sendKas(node, 'testnet-10', 'kaspatest', plan, keyFor, down)).rejects.toThrow(/could not check with a mainnet node.*Nothing was signed/s);
    // And when the caller hands in no way to ask at all.
    await expect(sendKas(node, 'testnet-10', 'kaspatest', plan, keyFor)).rejects.toThrow(/Nothing was signed/);
    expect(node.submitted).toHaveLength(0);
  });

  it('is not asked for with a node of the user\'s own, nor on the local network, nor on mainnet', async () => {
    const node = testnetNode(TEST);
    node.submitImpl = async () => { throw new Error('reached the node'); };
    const plan = await planKasSend(node, 'testnet-10', 'kaspatest', { addresses: [alice.test], changeAddress: alice.test, to: bob.test, amount: 10n * KAS });
    await expect(sendKas(node, 'testnet-10', 'kaspatest', plan, keyFor, 'own-node')).rejects.toThrow('reached the node');

    const local = new FakeNode();
    local.utxoSet.push(coinAt(alice.sim, TEST, 50n * KAS));
    local.submitImpl = async () => { throw new Error('reached the node'); };
    const simPlan = await planKasSend(local, 'simnet', 'kaspasim', { addresses: [alice.sim], changeAddress: alice.sim, to: bob.sim, amount: 10n * KAS });
    await expect(sendKas(local, 'simnet', 'kaspasim', simPlan, keyFor)).rejects.toThrow('reached the node');

    const main = new FakeNode();
    main.utxoSet.push(coinAt(alice.main, REAL, 50n * KAS));
    main.submitImpl = async () => { throw new Error('reached the node'); };
    const mainPlan = await planKasSend(main, 'mainnet', 'kaspa', { addresses: [alice.main], changeAddress: alice.main, to: bob.main, amount: 10n * KAS });
    await expect(sendKas(main, 'mainnet', 'kaspa', mainPlan, (a) => (a === alice.main ? Uint8Array.from(alice.secret) : null))).rejects.toThrow('reached the node');
  });
});
