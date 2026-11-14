// For the tests of round 12's R12-WW-1: a fake Kaspa node on which some addresses hold too many coins to list, and
// a holder of kUSDT states on it. The fake refuses, as the real client does (bridge/packages/kaspa/src/rpc.ts), any
// read that names such an address: one answer for every address asked about, or none.

import { RpcError, RpcTooLargeError } from '@kusdt/kaspa';
import { plainState } from '@/kusdt/owner';
import { p2shAddressOf, scriptOf } from '@/kusdt/verify';
import type { ApiLocated } from '@/kusdt/api';
import type { NodeUtxo } from '@/kaspa/node';
import { COVENANT, FakeNode, NET, devKey, fakeApi, kasCoin, signerFor, testCtx } from './helpers';

export const USDT = 1_000_000n;

export class FloodedNode extends FakeNode {
  /** Addresses whose list is too long to read. */
  full = new Set<string>();
  /** Addresses whose list does not come in time. */
  slow = new Set<string>();
  /** Every read of the UTXO set: the addresses it named. */
  reads: string[][] = [];
  async utxos(addresses: string[]): Promise<NodeUtxo[]> {
    this.reads.push([...addresses]);
    if (addresses.some(a => this.full.has(a))) throw new RpcTooLargeError('getUtxosByAddresses', 80_000_000, 64_000_000);
    if (addresses.some(a => this.slow.has(a))) throw new RpcError('getUtxosByAddresses', 'timed out');
    return super.utxos(addresses);
  }
}

/** A holder with one kUSDT state per amount (each on 1.5 KAS, listed by the coordinator with its whole coin) and 10 KAS. */
export function holder(tag: string, amounts: bigint[], opts: { api?: Parameters<typeof fakeApi>[0] } = {}) {
  const alice = devKey(`r12-full-${tag}`);
  const node = new FloodedNode();
  const listed: ApiLocated[] = [];
  const ctx = testCtx(node, fakeApi({ tokens: async () => ({ states: listed }), ...opts.api }));
  const states = amounts.map((amount, i) => {
    const state = plainState({ ownerScheme: 0, owner: alice.xonly }, amount);
    const spk = scriptOf(ctx, 'KCC20', state);
    const address = p2shAddressOf(spk, NET.prefix);
    const txid = (tag + i.toString(16).padStart(3, '0')).padEnd(64, '0');
    node.utxoSet.push({ address, transactionId: txid, index: 0, amount: 150_000_000n, scriptPublicKey: spk, blockDaaScore: 5n, isCoinbase: false, covenantId: COVENANT });
    listed.push({ utxo: { transactionId: txid, index: 0, amount: 150_000_000, scriptPublicKey: spk, blockDaaScore: 5, covenantId: COVENANT }, state: { ...state, amount: Number(amount) } });
    return { state, address, txid, outpoint: `${txid}:0` };
  });
  node.utxoSet.push(kasCoin(alice, (tag + 'c').padEnd(64, 'c'), 1_000_000_000n));
  return { alice, node, ctx, signer: signerFor(alice), kas: [alice.address], states, listed };
}
export type Holder = ReturnType<typeof holder>;
