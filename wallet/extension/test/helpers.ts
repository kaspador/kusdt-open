// Shared test setup: the Node build of the kUSDT core, a fake Kaspa node and
// a fake coordinator.

import { core } from '@kusdt/core';
import { KASPA_NETWORKS, encodeKaspaAddress, bytesToHex } from '@kusdt/kaspa';
import { schnorr } from '@noble/curves/secp256k1.js';
import { blake2b } from '@noble/hashes/blake2.js';
import { setCoreLoader } from '@/lib/core';
import { mergeConfig } from '@/config/settings';
import type { KaspaNodeApi, NodeUtxo, MempoolOutput } from '@/kaspa/node';
import type { CoordinatorApi } from '@/kusdt/api';
import type { Ctx, Signer } from '@/kusdt/types';
import { VAULT_READER } from '@/kusdt/redeem';
import { selector } from '@/evm/abi';
import { CONFIRM_WAIT } from '@/kusdt/submit';

// A fake node takes a transaction and never shows it accepted (unless a test lands it): the wallet's wait for a pool
// transaction's outcome is one look here, so such a test goes on at once with 'sent, not confirmed' as its answer.
// The tests of the wait itself set their own (round11-pool-outcome.test.ts).
CONFIRM_WAIT.ms = 0;
CONFIRM_WAIT.everyMs = 0;

/** The id (and the core's answer) of the last transaction the core built: what a fake node answers to a submission. */
export const lastBuilt: { txid: string; command: string; value: any } = { txid: '', command: '', value: null };
const tracked = { ...core, call: ((command: string, request: unknown) => {
  const a = core.call(command, request as object);
  if (typeof (a.value as { txid?: unknown })?.txid === 'string') Object.assign(lastBuilt, { txid: (a.value as { txid: string }).txid, command, value: a.value });
  return a;
}) as typeof core.call };
setCoreLoader(() => tracked);
export { tracked as core };

export const NET = KASPA_NETWORKS.simnet;
export const COVENANT = 'a5'.repeat(32);
export const POOL = 'b6'.repeat(32);

export function devKey(name: string) {
  const secret = blake2b(new TextEncoder().encode(`kusdt-wallet-test/${name}`), { dkLen: 32 });
  const xonly = schnorr.getPublicKey(secret);
  return { secret: bytesToHex(secret), xonly: bytesToHex(xonly), address: encodeKaspaAddress(NET.prefix, 0, xonly) };
}

export class FakeNode implements KaspaNodeApi {
  readonly network = 'simnet' as const;
  utxoSet: NodeUtxo[] = [];
  mempool: MempoolOutput[] = [];
  spent = new Set<string>();
  submitted: string[] = [];
  submitImpl: (json: string) => Promise<string> = async () => lastBuilt.txid;
  async utxos(addresses: string[]) { return this.utxoSet.filter(u => addresses.includes(u.address)); }
  async mempoolOutputs(addresses: string[]) { return this.mempool.filter(u => addresses.includes(u.address)); }
  async inMempool(txid: string) { return this.mempool.some(u => u.transactionId === txid); }
  async mempoolSpent() { return this.spent; }
  async feerate() { return 100; }
  async virtualDaa() { return 1_000_000n; }
  async submit(json: string) { this.submitted.push(json); return this.submitImpl(json); }
  close() {}
}

export function fakeApi(over: Partial<CoordinatorApi> = {}): CoordinatorApi {
  return {
    status: async () => ({}),
    tokens: async () => ({ states: [] }),
    pool: async () => { throw new Error('no pool'); },
    deposit: async () => ({}),
    postRedeem: async () => ({ redeems: [] }),
    redeem: async () => ({}),
    positions: async () => ({ positions: [] }),
    recipient: async (chain, address) => recipientAnswer(chain, address),
    ...over,
  };
}

/** GET /recipients/:chain/:address as the coordinator answers it (bridge/services/src/coordinator/api.ts); payable unless `over` says otherwise. */
export const recipientAnswer = (chain: 'ethereum' | 'bsc', address: string, over: Record<string, unknown> = {}) => ({
  chain: chain === 'ethereum' ? 1 : 2, address, blocklist: chain === 'ethereum' ? 'isBlackListed' : null, blocked: false, payable: true, reason: null, ...over,
});

export function testCtx(node: FakeNode, api: CoordinatorApi | null = fakeApi()): Ctx {
  const config = { ...mergeConfig('simnet', undefined), covenantId: COVENANT, poolId: POOL, apiUrl: 'http://x/api/v1' };
  return { core: tracked, node, api, network: 'simnet', net: NET, config };
}

export function signerFor(k: ReturnType<typeof devKey>): Signer {
  return { address: k.address, ownerHex: k.xonly, secretFor: (a) => (a === k.address ? k.secret : null) };
}

/** What the fake vault answers (SPEC §8's mainnet fees; simnet's Ethereum chain stands in for Ethereum). */
export const fakeVault = {
  feeBps: 20n, minReleaseFee: { 31337: 5_000_000n, 31338: 500_000n } as Record<number, bigint>, releaseCapacity: 250_000_000_000n,
  // What the vault says it can pay now (round 12, R12-WW-2: the wallet reads these too): not paused, nothing queued, plenty there.
  paused: false, unreservedBacking: 250_000_000_000n, releaseAvailable: 250_000_000_000n, reservedUnits: 0n,
};
const word = (n: bigint) => '0x' + n.toString(16).padStart(64, '0');
const VIEWS: Record<string, () => bigint> = {
  [selector('releaseCapacity()')]: () => fakeVault.releaseCapacity,
  [selector('paused()')]: () => (fakeVault.paused ? 1n : 0n),
  [selector('unreservedBacking()')]: () => fakeVault.unreservedBacking,
  [selector('releaseAvailable()')]: () => fakeVault.releaseAvailable,
  [selector('reservedUnits()')]: () => fakeVault.reservedUnits,
};
const BLOCKED = selector('isBlackListed(address)');
VAULT_READER.rpc = (ch) => ({
  ethCall: async (_to: string, data: string) => {
    if (data.length === 10) { const view = VIEWS[data]; if (!view) throw new Error(`the fake vault has no view ${data}`); return word(view()); }
    // The token's own blocklist, asked before a burn (run 21, Daybreak [24]): it blocks nobody here.
    if (data.startsWith(BLOCKED)) return word(0n);
    const units = BigInt('0x' + data.slice(10)); // releaseFeeOf(uint256)
    const prop = (units * fakeVault.feeBps + 9_999n) / 10_000n, min = fakeVault.minReleaseFee[ch.chainId] ?? 500_000n;
    return word(prop > min ? prop : min);
  },
});

/** "0000" + 20<key>ac. */
export const p2pkSpk = (xonly: string) => `000020${xonly}ac`;

export function kasCoin(k: ReturnType<typeof devKey>, txid: string, amount: bigint): NodeUtxo {
  return { address: k.address, transactionId: txid, index: 0, amount, scriptPublicKey: p2pkSpk(k.xonly), blockDaaScore: 10n, isCoinbase: false, covenantId: null };
}
