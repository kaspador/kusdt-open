// The popup's navigation: five tabs at the bottom, the screens pushed over them
// (Send, Receive, Settings, Network and its advanced form), and the header every
// main screen shares: the network, always visible and one tap to change, then
// Settings and Lock.

import { createContext, useContext, type ComponentType } from 'react';
import type { KaspaNetworkName } from '@/config/defaults';
import { NETWORKS } from '@/config/networks';
import { deploymentEdits, kusdtReady } from '@/config/settings';
import { useWallet } from './state';
import {
  ActivityIcon, AlertIcon, BrandMark, BridgeIcon, ChevronDownIcon, InfoIcon, LockIcon, PoolIcon, SettingsIcon, SwapIcon, WalletIcon, type IconProps,
} from '@/ui/icons';
import { IconButton } from '@/ui/kit';

export type Tab = 'wallet' | 'swap' | 'bridge' | 'pool' | 'activity';
/** `merge`: Send, opened as a plain send of all of the KAS to the wallet's own address (a pool transaction found it in too many coins). */
export type Pushed = 'send' | 'merge' | 'receive' | 'settings' | 'network' | 'advanced';

export interface Nav {
  tab: Tab;
  setTab: (t: Tab) => void;
  push: (s: Pushed) => void;
  back: () => void;
  /** Locks the wallet: the unlocked phrase leaves the session. */
  lock: () => void;
}

export const NavContext = createContext<Nav | null>(null);
export function useNav(): Nav {
  const n = useContext(NavContext);
  if (!n) throw new Error('No navigation.');
  return n;
}

export function NetDot({ network }: { network: KaspaNetworkName }) {
  return <span className={`dot dot-${NETWORKS[network].tone}`} aria-hidden="true" />;
}

/** The network, as a dot and its name. With `onClick`, a button that opens the Network screen. */
export function NetworkButton({ network, onClick }: { network: KaspaNetworkName; onClick?: () => void }) {
  const name = NETWORKS[network].name;
  if (!onClick) return <span className="net-btn static" title={`Network: ${name}`}><NetDot network={network} />{name}</span>;
  return (
    <button type="button" className="net-btn" onClick={onClick} aria-label={`Network: ${name}. Change network`} title="Change network">
      <NetDot network={network} />{name}<ChevronDownIcon size={14} />
    </button>
  );
}

/** The calm line under the header on Testnet and Local (and on a network where kUSDT isn't live). */
/** The network line, and under it the warning of a deployment that is not the built-in one. */
export function NetworkBanner({ network }: { network?: KaspaNetworkName }) {
  return <><NetworkLine network={network} /><CustomDeploymentBanner /></>;
}

function NetworkLine({ network }: { network?: KaspaNetworkName }) {
  const w = useWallet();
  const net = network ?? w.active.network;
  const info = NETWORKS[net];
  if (info.banner) {
    return (
      <div className={`banner banner-${info.tone}`} role="status">
        {info.tone === 'test' ? <AlertIcon size={13} /> : <InfoIcon size={13} />}<span>{info.banner}</span>
      </div>
    );
  }
  if (!kusdtReady(w.active.config)) return <div className="banner banner-info" role="status"><InfoIcon size={13} /><span>{info.name}: kUSDT is not live here yet</span></div>;
  return null;
}

/**
 * Shown on every screen while the wallet uses other contracts than the built-in ones: an edit nobody remembers making
 * would otherwise send a deposit to a contract of somebody else's with nothing on screen to say so.
 */
export function CustomDeploymentBanner() {
  const w = useWallet();
  const edits = deploymentEdits(w.active.network, w.active.config);
  if (!edits.length) return null;
  return (
    <div className="banner banner-test" role="alert" data-testid="custom-deployment">
      <AlertIcon size={13} /><span>Custom settings: {edits.join(', ')} {edits.length === 1 ? 'is' : 'are'} not the built-in one{edits.length === 1 ? '' : 's'}. Your money and what you are shown depend on {edits.length === 1 ? 'it' : 'them'}. Not your doing? Network, Advanced, Restore defaults.</span>
    </div>
  );
}

/** The header of the five main screens. */
export function TopBar({ title, brand = false }: { title: string; brand?: boolean }) {
  const nav = useNav();
  const w = useWallet();
  return (
    <>
      <header className="topbar">
        {brand && <span className="mr-2"><BrandMark size={22} /></span>}
        <h1 className="topbar-title">{title}</h1>
        <NetworkButton network={w.active.network} onClick={() => nav.push('network')} />
        <IconButton label="Settings" onClick={() => nav.push('settings')}><SettingsIcon size={18} /></IconButton>
        <IconButton label="Lock" onClick={nav.lock}><LockIcon size={18} /></IconButton>
      </header>
      <NetworkBanner />
    </>
  );
}

const TABS: [Tab, string, ComponentType<IconProps>][] = [
  ['wallet', 'Wallet', WalletIcon], ['swap', 'Swap', SwapIcon], ['bridge', 'Bridge', BridgeIcon], ['pool', 'Pool', PoolIcon], ['activity', 'Activity', ActivityIcon],
];

export function BottomNav() {
  const nav = useNav();
  return (
    <nav className="bottom-nav" aria-label="Main">
      {TABS.map(([t, label, Icon]) => {
        const on = nav.tab === t;
        return (
          <button key={t} type="button" className={`nav-item ${on ? 'on' : ''}`} aria-current={on ? 'page' : undefined} onClick={() => nav.setTab(t)}>
            <span className="nav-icon"><Icon size={19} /></span>
            <span>{label}</span>
          </button>
        );
      })}
    </nav>
  );
}
