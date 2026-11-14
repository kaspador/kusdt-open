// The unlocked wallet, shared by every screen.

import { createContext, useCallback, useContext, useEffect, useState } from 'react';
import type { HDKey } from '@scure/bip32';
import { activeConfig, saveNetworkConfig, type Active } from '@/config/settings';
import { deploymentDiffers, readLocalDeployment, withLocalDeployment, type LocalDeployment } from '@/config/local';
import { keysFor, openCtx, signerOf, balancesOf, type Balances } from '@/wallet/context';
import { evmPrivateKey, type WalletKeys } from '@/keys/derive';
import { noteArrivals } from '@/activity/history';
import { kasBalance } from '@/kaspa/kas';
import { loadTokens } from '@/kusdt/tokens';
import { Spinner } from '@/ui/kit';
import type { Ctx, Signer } from '@/kusdt/types';

export interface Wallet {
  hd: HDKey;
  active: Active;
  keys: WalletKeys;
  signer: Signer;
  kasAddresses: string[];
  balances: Balances | null;
  balanceError: string | null;
  refreshing: boolean;
  /** When the balances were last read (ms). */
  refreshedAt: number;
  refresh: () => Promise<void>;
  reloadConfig: () => Promise<void>;
  ctx: () => Promise<Ctx>;
  /** The EVM key, for one signing; the caller wipes it. */
  evmKey: () => Uint8Array;
  /** Local only: the running local stack's deployment, when it isn't the one pinned (config/local.ts). */
  localUpdate: LocalDeployment | null;
  /** Pins `localUpdate` for Local (only there) and reloads. */
  takeLocalUpdate: () => Promise<void>;
}

const WalletContext = createContext<Wallet | null>(null);

export function useWallet(): Wallet {
  const w = useContext(WalletContext);
  if (!w) throw new Error('No wallet.');
  return w;
}

export function WalletProvider({ hd, children }: { hd: HDKey; children: React.ReactNode }) {
  const [active, setActive] = useState<Active | null>(null);
  const [balances, setBalances] = useState<Balances | null>(null);
  const [balanceError, setBalanceError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [refreshedAt, setRefreshedAt] = useState(0);
  const [localUpdate, setLocalUpdate] = useState<LocalDeployment | null>(null);

  const reloadConfig = useCallback(async () => { setBalances(null); setBalanceError(null); setActive(await activeConfig()); }, []);
  useEffect(() => { reloadConfig(); }, [reloadConfig]);

  const keys = active ? keysFor(hd, active.network) : null;
  const signer = keys ? signerOf(hd, keys) : null;
  const kasAddresses = keys ? keys.scan.map(k => k.address) : [];

  const refresh = useCallback(async () => {
    if (!keys || !active) return;
    setRefreshing(true);
    try {
      const ctx = await openCtx(active);
      const b = await balancesOf(ctx, kasAddresses, keys.ownerHex, keys.main.address);
      setBalances(b); setBalanceError(null);
      // What arrived since the last look (activity).
      kasBalance(ctx.node, ctx.network, kasAddresses).then(k => noteArrivals(ctx.network, 'kas-receive', k.utxos.map(u => ({ txid: u.txid, index: u.index, amount: u.amount })))).catch(() => {});
      if (b.kusdt != null) loadTokens(ctx, { address: keys.main.address, ownerHex: keys.ownerHex, secretFor: () => null })
        .then(t => noteArrivals(ctx.network, 'kusdt-receive', t.states.map(s => ({ txid: s.utxo.transactionId, index: s.utxo.index, amount: s.state.amount })))).catch(() => {});
    } catch (e) { setBalanceError((e as Error).message); } finally { setRefreshing(false); setRefreshedAt(Date.now()); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, hd]);

  useEffect(() => { refresh(); }, [refresh]);

  // Local only: has the local stack restarted with a new deployment? (Testnet and Mainnet stay pinned.)
  useEffect(() => {
    setLocalUpdate(null);
    if (!active || active.network !== 'simnet') return;
    let alive = true;
    readLocalDeployment(active.network, active.config.apiUrl)
      .then(d => { if (alive && d && deploymentDiffers(active.config, d)) setLocalUpdate(d); })
      .catch(() => {});
    return () => { alive = false; };
  }, [active]);

  const takeLocalUpdate = useCallback(async () => {
    if (!active || active.network !== 'simnet' || !localUpdate) return;
    await saveNetworkConfig('simnet', withLocalDeployment(active.config, localUpdate));
    setLocalUpdate(null);
    await reloadConfig();
  }, [active, localUpdate, reloadConfig]);

  if (!active || !keys || !signer) return <div className="flex-1 flex items-center justify-center"><Spinner size={18} /></div>;
  const value: Wallet = {
    hd, active, keys, signer, kasAddresses, balances, balanceError, refreshing, refreshedAt, refresh, reloadConfig,
    // On the network this window shows (and checked a site's request against), whatever the settings say by now.
    ctx: () => openCtx(active),
    evmKey: () => evmPrivateKey(hd),
    localUpdate, takeLocalUpdate,
  };
  return <WalletContext.Provider value={value}>{children}</WalletContext.Provider>;
}
