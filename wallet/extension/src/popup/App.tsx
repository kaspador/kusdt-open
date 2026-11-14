// The popup (and, with #request=…, the approval window for a site's request).

import { useEffect, useState } from 'react';
import type { HDKey } from '@scure/bip32';
import { hasVault } from '@/keys/vault';
import { currentHd, forgetInMemory, lock, lockCount, SESSION_KEY } from '@/keys/session';
import { draftPhrase, readDraft } from '@/keys/draft';
import { WalletProvider } from './state';
import { BottomNav, NavContext, type Nav, type Pushed, type Tab } from './nav';
import { Welcome, Create, Import, Unlock } from '@/screens/Onboard';
import { Home, Receive } from '@/screens/Home';
import { Send } from '@/screens/Send';
import { Swap } from '@/screens/Swap';
import { Bridge } from '@/screens/Bridge';
import { PoolTab } from '@/screens/Pool';
import { ActivityTab } from '@/screens/Activity';
import { SettingsScreen } from '@/screens/Settings';
import { NetworkEditor, NetworkScreen } from '@/screens/Network';
import { Approve } from '@/screens/Approve';
import { TermsGate } from '@/screens/Terms';
import { termsAccepted } from '@/config/terms';
import { ToastHost } from '@/ui/kit';

const REQUEST_MODE = location.hash.startsWith('#request=');
/** Setting the wallet up in a window of its own (see begin below). */
const SETUP_MODE = (/^#setup=(create|import)$/.exec(location.hash) ?? [])[1] as 'create' | 'import' | undefined;
/** `terms`: unlocked, but this version of the Terms of Service is not accepted yet; nothing else opens until it is. */
type Gate = 'loading' | 'welcome' | 'create' | 'import' | 'locked' | 'terms' | 'open';

/** The toolbar's popup: Chrome closes it the moment anything else is clicked. */
const inToolbarPopup = (): boolean => {
  try { return chrome.extension.getViews({ type: 'popup' }).includes(window); } catch { return false; }
};

function Main({ onLock, onRemoved }: { onLock: () => void; onRemoved: () => void }) {
  const [tab, setTabState] = useState<Tab>('wallet');
  /** Screens pushed over the tabs; Back pops one. */
  const [stack, setStack] = useState<Pushed[]>([]);
  if (REQUEST_MODE) return <Approve />;
  const nav: Nav = {
    tab,
    setTab: (t) => { setStack([]); setTabState(t); },
    push: (s) => setStack(x => [...x, s]),
    back: () => setStack(x => x.slice(0, -1)),
    // Lock clears the unlocked phrase from the session (as auto-lock does), not just this window.
    lock: () => { lock().finally(onLock); },
  };
  const top = stack[stack.length - 1];
  return (
    <NavContext.Provider value={nav}>
      {top === 'send' ? <Send onBack={nav.back} />
        : top === 'merge' ? <Send onBack={nav.back} merge />
        : top === 'receive' ? <Receive onBack={nav.back} />
        : top === 'settings' ? <SettingsScreen onBack={nav.back} onNetwork={() => nav.push('network')} onLock={onLock} onRemoved={onRemoved} />
        : top === 'network' ? <NetworkScreen onBack={nav.back} onAdvanced={() => nav.push('advanced')} />
        : top === 'advanced' ? <NetworkEditor onBack={nav.back} />
        : (
          <>
            <div className="flex-1 flex flex-col min-h-0">
              {tab === 'wallet' && <Home />}
              {tab === 'swap' && <Swap />}
              {tab === 'bridge' && <Bridge />}
              {tab === 'pool' && <PoolTab />}
              {tab === 'activity' && <ActivityTab />}
            </div>
            <BottomNav />
          </>
        )}
    </NavContext.Provider>
  );
}

export function App() {
  const [gate, setGate] = useState<Gate>('loading');
  const [hd, setHd] = useState<HDKey | null>(null);
  const [phrase, setPhrase] = useState<string | null>(null);

  const showCreate = (words: string) => { setPhrase(words); setGate('create'); };

  /**
   * Saving a phrase means going somewhere else, and that closes the toolbar's
   * popup: there, setting up moves to a window of its own, which stays.
   */
  async function begin(what: 'create' | 'import') {
    if (inToolbarPopup() && chrome.windows?.create) {
      const opened = await new Promise<chrome.windows.Window | undefined>(r => chrome.windows.create({
        url: chrome.runtime.getURL(`src/popup/index.html#setup=${what}`), type: 'popup', width: 400, height: 640, focused: true,
      }, w => { void chrome.runtime.lastError; r(w); }));
      if (opened?.id) { window.close(); return; }
    }
    if (what === 'import') setGate('import');
    else showCreate(await draftPhrase());
  }

  async function check() {
    if (!(await hasVault())) {
      if (SETUP_MODE === 'import') { setGate('import'); return; }
      if (SETUP_MODE === 'create') { showCreate(await draftPhrase()); return; }
      // Coming back to a window that asked for the wallet: straight to the words it already showed.
      const draft = REQUEST_MODE ? await readDraft() : undefined;
      if (draft) showCreate(draft); else setGate('welcome');
      return;
    }
    // The wallet exists: the words it was made from stay nowhere in this window (R21-W2-2). Create and the session's
    // draft held them until now; this window stays open as the wallet, and locking it must leave no phrase behind.
    setPhrase(null);
    const at = lockCount();
    const k = await currentHd();
    // A wallet set up before the terms (or before their current version) accepts them once, at its next unlock:
    // before its screens and before any site's request in this window.
    const terms = !!k && await termsAccepted();
    // A lock while this ran (the auto-lock alarm, Lock in another window) wins: the wallet is not shown open on a key
    // the lock has ended (run 21, reviewer RV-W).
    if (!k || lockCount() !== at) { setHd(null); setGate('locked'); return; }
    setHd(k);
    setGate(terms ? 'open' : 'terms');
  }

  useEffect(() => {
    // Lets the background lock "on close" when auto-lock is set so.
    try { chrome.runtime.connect({ name: 'popup' }); } catch { /* not in the extension */ }
    check();
    // The auto-lock alarm clears the session: lock this window too.
    const onChange = (changes: Record<string, chrome.storage.StorageChange>, area: string) => {
      if (area === 'session' && SESSION_KEY in changes && changes[SESSION_KEY].newValue === undefined) { forgetInMemory(); setHd(null); setPhrase(null); setGate('locked'); }
    };
    chrome.storage?.onChanged.addListener(onChange);
    return () => chrome.storage?.onChanged.removeListener(onChange);
  }, []);

  const shell = REQUEST_MODE || SETUP_MODE ? 'window-shell' : 'popup-shell';
  return (
    <div className={shell}>
      {gate === 'loading' && <div className="flex-1" />}
      {gate === 'welcome' && <Welcome onCreate={() => { void begin('create'); }} onImport={() => { void begin('import'); }} />}
      {gate === 'create' && phrase && <Create mnemonic={phrase} onBack={() => setGate('welcome')} onDone={check} />}
      {gate === 'import' && <Import onBack={() => setGate('welcome')} onDone={check} />}
      {gate === 'locked' && <Unlock onUnlocked={check} />}
      {gate === 'terms' && <TermsGate request={REQUEST_MODE} onAccepted={check} />}
      {gate === 'open' && hd && (
        <WalletProvider hd={hd}>
          <Main onLock={() => { forgetInMemory(); setHd(null); setPhrase(null); setGate('locked'); }} onRemoved={() => { setHd(null); setPhrase(null); setGate('welcome'); }} />
        </WalletProvider>
      )}
      <ToastHost />
    </div>
  );
}
