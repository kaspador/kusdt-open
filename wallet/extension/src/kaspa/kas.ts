// KAS: balance and sends (version-0 transactions, planned and signed by
// bridge/packages/kaspa, the Pearl Wallet code).

import {
  KASPA_NETWORKS, addressForScript, planKaspaSend, buildFromPlan, signAll, spendableUtxos, toRpcTransactionJson, transactionId, scriptForAddress, hexToBytes, nodeHasTransaction,
  type KaspaSendPlan, type KaspaUtxo,
} from '@kusdt/kaspa';
import { pendingSet, markSpent } from '@/kusdt/pending';
import { MaybeSent, NoAnswer, NodeRejected, type KaspaNodeApi } from './node';
import type { KaspaNetworkName } from '@/config/defaults';

export interface KasBalance {
  /** Every plain coin, minus those the wallet is already spending. */
  total: bigint;
  /** What can be spent now (mined coins mature after ~100 s). */
  spendable: bigint;
  utxos: KaspaUtxo[];
}

/** The wallet's plain KAS coins (covenant states are not KAS balance). */
export async function kasBalance(node: KaspaNodeApi, network: KaspaNetworkName, addresses: string[]): Promise<KasBalance> {
  const [all, pending, inMempool] = await Promise.all([node.utxos(addresses), pendingSet(network), node.mempoolSpent(addresses).catch(() => new Set<string>())]);
  const plain = all.filter(u => u.covenantId === null && !pending.has(`${u.transactionId}:${u.index}`) && !inMempool.has(`${u.transactionId}:${u.index}`));
  const utxos: KaspaUtxo[] = plain.map(u => ({
    txid: u.transactionId, index: u.index, amount: u.amount,
    script: { version: parseInt(u.scriptPublicKey.slice(0, 4), 16), script: hexToBytes(u.scriptPublicKey.slice(4)) },
    blockDaaScore: u.blockDaaScore, isCoinbase: u.isCoinbase, address: u.address,
  }));
  const daa = utxos.some(u => u.isCoinbase) ? await node.virtualDaa() : null;
  const total = utxos.reduce((s, u) => s + u.amount, 0n);
  const spendable = spendableUtxos(utxos, { virtualDaaScore: daa }).reduce((s, u) => s + u.amount, 0n);
  return { total, spendable, utxos: spendableUtxos(utxos, { virtualDaaScore: daa }) };
}

export interface KasSendPlan { plan: KaspaSendPlan; to: string; changeAddress: string }

export async function planKasSend(node: KaspaNodeApi, network: KaspaNetworkName, prefix: string, args: {
  addresses: string[]; changeAddress: string; to: string; amount: bigint; sendMax?: boolean;
}): Promise<KasSendPlan> {
  const recipient = scriptForAddress(args.to, prefix);   // throws on a bad or other-network address
  const [bal, feerate] = await Promise.all([kasBalance(node, network, args.addresses), node.feerate()]);
  const plan = planKaspaSend({
    utxos: bal.utxos, recipient, change: scriptForAddress(args.changeAddress, prefix),
    amount: args.amount, sendMax: args.sendMax, feerate,
  });
  if (!plan.ok) {
    const why: Record<string, string> = {
      'no-coins': 'There is no KAS to send.',
      insufficient: 'Not enough KAS for this amount and the network fee.',
      'too-small': 'That amount is too small for the network (storage mass). Send a little more.',
      'too-many-coins': 'Too many small coins for one transaction. Send a smaller amount first.',
    };
    throw new Error(why[plan.failure ?? 'insufficient']);
  }
  return { plan, to: args.to, changeAddress: args.changeAddress };
}

// ── Test coins that are real coins ──────────────────────────────────────────
//
// The wallet's Kaspa keys are the same on every network (keys/derive.ts), and a Kaspa signature names no network: a
// plain KAS transaction signed for Testnet is valid on mainnet if the coins it spends exist there. Which network the
// node serves is the node's own word. So a node that says "testnet-10" and serves the mainnet coins of the user's
// keys would have real KAS sent under Testnet labels. kUSDT and pool transactions are not exposed: each spends a
// covenant coin that exists on one network only.

/** The coins a "test" send would spend exist on mainnet: they are real KAS. */
export class CoinsAreReal extends Error {
  constructor() {
    super('The Kaspa node this wallet is connected to shows coins that exist on Kaspa mainnet as test coins: this send would move real KAS. Nothing was signed. Close the wallet and open it again to reach another node, or set a node of your own in Settings.');
  }
}

/** Where to ask whether coins exist on mainnet: a mainnet node, or `own-node` when the user set their own node for this network (then its word is theirs to trust). */
export type MainnetLook = Pick<KaspaNodeApi, 'utxos'> | 'own-node';

/**
 * Asks a mainnet node whether any coin `p` spends exists on mainnet, under the same keys' mainnet addresses, and
 * throws CoinsAreReal if one does. A second source, not a proof: it holds unless that node lies too. No answer is
 * not a "no": the send is then refused.
 */
export async function assertNotMainnetCoins(p: KasSendPlan, mainnet: Pick<KaspaNodeApi, 'utxos'>): Promise<void> {
  const prefix = KASPA_NETWORKS.mainnet.prefix;
  const addresses = [...new Set(p.plan.inputs.map(u => addressForScript(u.script, prefix)).filter((a): a is string => !!a))];
  if (addresses.length === 0) throw new Error('The coins of this send have no address the wallet can check on mainnet. Nothing was signed.');
  let there: Awaited<ReturnType<KaspaNodeApi['utxos']>>;
  try { there = await mainnet.utxos(addresses); }
  catch (e) {
    throw new Error(`The wallet could not check with a mainnet node that these test coins are not real KAS (${(e as Error)?.message ?? e}). Nothing was signed; try again in a moment.`);
  }
  const real = new Set(there.map(u => `${u.transactionId}:${u.index}`));
  if (p.plan.inputs.some(u => real.has(`${u.txid}:${u.index}`))) throw new CoinsAreReal();
}

/** The networks on which a plain KAS send is checked against mainnet first: the public test network (the local one is the user's own node). */
export const checkedAgainstMainnet = (network: KaspaNetworkName): boolean => network === 'testnet-10';

/**
 * Builds, checks (buildFromPlan → checkTransaction), signs and submits.
 * `keyFor` gives the private key of a coin's address; each is wiped after use.
 * On Testnet, `mainnet` is asked first whether these coins are real ones (assertNotMainnetCoins): without it the
 * send is refused, so no caller can leave the check out by forgetting it.
 */
export async function sendKas(node: KaspaNodeApi, network: KaspaNetworkName, prefix: string, p: KasSendPlan, keyFor: (address: string) => Uint8Array | null, mainnet?: MainnetLook): Promise<string> {
  if (checkedAgainstMainnet(network)) {
    if (!mainnet) throw new Error('This send was not checked against mainnet. Nothing was signed.');
    if (mainnet !== 'own-node') await assertNotMainnetCoins(p, mainnet);
  }
  const tx = buildFromPlan(p.plan, scriptForAddress(p.to, prefix), scriptForAddress(p.changeAddress, prefix));
  signAll(tx, p.plan, keyFor);
  const txid = transactionId(tx);
  const spent = p.plan.inputs.map(u => `${u.txid}:${u.index}`);
  let got: string;
  try { got = await node.submit(toRpcTransactionJson(tx)); }
  catch (e) {
    if (e instanceof NodeRejected && nodeHasTransaction(e.said, txid)) got = txid;
    else if (e instanceof NoAnswer) { await markSpent(network, spent).catch(() => {}); throw new MaybeSent(txid); }
    else throw e;
  }
  if (got !== txid) throw new Error('The node reported another transaction id.');
  await markSpent(network, spent);
  return txid;
}
