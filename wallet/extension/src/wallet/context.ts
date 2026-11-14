// Ties the pieces together for the screens, the approval window and the
// background: the active network's config, its node, its coordinator, the
// core, and the unlocked keys.

import type { HDKey } from '@scure/bip32';
import { KASPA_NETWORKS, bytesToHex } from '@kusdt/kaspa';
import type { Active } from '@/config/settings';
import { KaspaNodeClient, type KaspaNodeApi } from '@/kaspa/node';
import { CoordinatorClient } from '@/kusdt/api';
import { getCore } from '@/lib/core';
import { kaspaPrivateKey, walletKeys, type WalletKeys } from '@/keys/derive';
import { kasBalance, type MainnetLook } from '@/kaspa/kas';
import { emptyStatesOf, loadTokens } from '@/kusdt/tokens';
import { settleUnconfirmed } from '@/kusdt/unconfirmed';
import { markOutcomes } from '@/activity/history';
import { kusdtReady } from '@/config/settings';
import { lockCount, lockCountOf } from '@/keys/session';
import type { Ctx, Signer } from '@/kusdt/types';

let nodeCache: { key: string; node: KaspaNodeApi } | null = null;

function nodeFor(a: Pick<Active, 'network' | 'config'>): KaspaNodeApi {
  const key = `${a.network}|${a.config.nodeUrl}`;
  if (nodeCache?.key !== key) {
    nodeCache?.node.close();
    nodeCache = { key, node: new KaspaNodeClient(a.network, a.config.nodeUrl) };
  }
  return nodeCache.node;
}

/**
 * The context an action runs in: the network and config it was checked against, or that its window shows (Daybreak
 * [21], [52]). The settings are not read again here. A window that showed a request on one network built it from a
 * fresh read of the settings, and a switch made meanwhile (in the popup, or a site's approved switch) moved it to
 * another network's node, coordinator and contracts; a site's balances were read on the network the wallet had moved
 * to, not the one the site was connected on.
 */
export async function openCtx(active: Pick<Active, 'network' | 'config'>): Promise<Ctx> {
  return {
    core: await getCore(),
    node: nodeFor(active),
    api: active.config.apiUrl ? new CoordinatorClient(active.config.apiUrl) : null,
    network: active.network,
    net: KASPA_NETWORKS[active.network],
    config: active.config,
  };
}

/**
 * Where a plain KAS send on a test network asks whether its coins are real ones (kaspa/kas.ts assertNotMainnetCoins):
 * a mainnet node from the public node network, on a connection of its own, closed after the one question. With a node
 * the user set themselves for this network, nobody is asked: that node's word is the user's to trust.
 */
export function mainnetLookFor(active: Active): { look: MainnetLook; close: () => void } {
  if (active.config.nodeUrl) return { look: 'own-node', close: () => {} };
  const node = new KaspaNodeClient('mainnet', '');
  return { look: node, close: () => node.close() };
}

/** What an action under way meets at its next signature once the wallet has locked. */
export class WalletLocked extends Error {
  constructor() { super('The wallet locked while this was running, so nothing more was signed. Unlock it and check Activity before trying again.'); }
}

/**
 * The signer of the unlocked wallet: private keys derived on demand, for the wallet's own addresses only, and only
 * while the unlock it was made in lasts. Daybreak [15]: a signer kept handing out keys after Lock, so what was already
 * under way (the burn after its merge, a send after its checks) signed after the wallet locked. Every transaction the
 * wallet builds asks its signer for the keys first: it stops there now.
 */
export function signerOf(hd: HDKey, keys: WalletKeys): Signer {
  const byAddress = new Map(keys.scan.map(k => [k.address, k]));
  // Counted from the unlock its key was made under: one made after a lock from a key unlocked before it refuses too.
  const madeAt = lockCountOf(hd);
  return {
    address: keys.main.address,
    ownerHex: keys.ownerHex,
    secretFor(address: string) {
      if (lockCount() !== madeAt) throw new WalletLocked();
      const k = byAddress.get(address);
      if (!k) return null;
      const priv = kaspaPrivateKey(hd, k);
      const hex = bytesToHex(priv);
      priv.fill(0);
      return hex;
    },
  };
}

export function keysFor(hd: HDKey, network: Active['network']): WalletKeys {
  return walletKeys(hd, KASPA_NETWORKS[network]);
}

export interface Balances {
  kas: bigint; kasSpendable: bigint; kusdt: bigint | null; rejected: number; kusdtError?: string;
  /** Empty kUSDT states (amount 0: a deposit's change when it used a whole state), and the KAS they hold. */
  emptyStates: number; emptyKas: bigint;
  /**
   * kUSDT states the node could not show or deny, because it could not list their address (round 12, R12-WW-1): how
   * many, and what they hold by their records. Never part of `kusdt`.
   */
  unchecked?: number; uncheckedKusdt?: bigint;
  /** The coordinator did not answer: `kusdt` is what the wallet already knew of, found on the node again. */
  kusdtFromMemory?: boolean;
}

/** KAS on every scanned address, and kUSDT on the main key (verified states only). */
export async function balancesOf(ctx: Ctx, kasAddresses: string[], ownerHex: string, mainAddress: string): Promise<Balances> {
  // First, what became of pool transactions that were sent and not seen confirmed: one that lost the race gives back
  // the coins and the kUSDT it held, so they count in the balances read next; Activity says which it was.
  await settleUnconfirmed(ctx).then(o => markOutcomes(ctx.network, o)).catch(() => {});
  const kas = await kasBalance(ctx.node, ctx.network, kasAddresses);
  let kusdt: bigint | null = null, rejected = 0, kusdtError: string | undefined, emptyStates = 0, emptyKas = 0n;
  let unchecked = 0, uncheckedKusdt = 0n, kusdtFromMemory = false;
  if (kusdtReady(ctx.config)) {
    try {
      const t = await loadTokens(ctx, { address: mainAddress, ownerHex, secretFor: () => null });
      kusdt = t.total; rejected = t.rejected;
      unchecked = t.unread.length + t.unreadNoRecord; uncheckedKusdt = t.unreadTotal; kusdtFromMemory = t.fromMemory;
      const empty = emptyStatesOf(t.states);
      emptyStates = empty.length;
      emptyKas = empty.reduce((s, e) => s + e.utxo.amount, 0n);
    } catch (e) { kusdtError = (e as Error).message; }
  } else kusdtError = 'kUSDT is not configured for this network.';
  return { kas: kas.total, kasSpendable: kas.spendable, kusdt, rejected, kusdtError, emptyStates, emptyKas, unchecked, uncheckedKusdt, kusdtFromMemory };
}
