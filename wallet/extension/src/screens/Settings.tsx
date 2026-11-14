// Settings: the network, connected sites, auto-lock, the theme, the password,
// Lock, and removing the wallet; under the version, the Terms of Service and the
// Privacy Policy. There is no way to show the phrase or a key.

import { useEffect, useState } from 'react';
import { BRAND } from '@/brand';
import { loadSettings, saveSettings, type StoredSettings } from '@/config/settings';
import { NETWORKS, networkName } from '@/config/networks';
import { privacyUrl, termsUrl } from '@/config/terms';
import { useWallet } from '@/popup/state';
import { NetDot } from '@/popup/nav';
import { connectionsKey, type Connection } from '@/provider/protocol';
import { local } from '@/lib/storage';
import { setTheme, storedTheme, type Theme } from '@/lib/theme';
import { changePassword, openVault, removeVault, MIN_PASSWORD } from '@/keys/vault';
import { forgetWallet, lock, rearmAutoLock } from '@/keys/session';
import { Body, Button, EmptyState, Field, Header, Input, ListRow, Notice, OptionList, SectionTitle, toast, errText } from '@/ui/kit';
import { ClockIcon, ExternalIcon, GlobeIcon, KeyIcon, LinkIcon, LockIcon, MonitorIcon, MoonIcon, NetworkIcon, SunIcon, TrashIcon } from '@/ui/icons';

const AUTOLOCK: { value: string; label: string; sub?: string }[] = [
  { value: '0', label: 'When the popup closes', sub: 'The most private: a password every time' },
  { value: '5', label: 'After 5 minutes' },
  { value: '15', label: 'After 15 minutes' },
  { value: '60', label: 'After 1 hour' },
];
const autoLockLabel = (m: number) => (m === 0 ? 'On close' : m === 60 ? '1 h' : m < 0 ? 'Never' : `${m} min`);
const THEME_LABEL: Record<Theme, string> = { system: 'System', light: 'Light', dark: 'Dark' };

type Page = 'main' | 'sites' | 'autolock' | 'theme' | 'password' | 'remove';

export function SettingsScreen({ onBack, onNetwork, onLock, onRemoved }: { onBack: () => void; onNetwork: () => void; onLock: () => void; onRemoved: () => void }) {
  const w = useWallet();
  const [s, setS] = useState<StoredSettings | null>(null);
  const [page, setPage] = useState<Page>('main');
  const [sites, setSites] = useState<Record<string, Connection>>({});
  const [theme, setThemeState] = useState<Theme>(storedTheme());
  useEffect(() => { loadSettings().then(setS); }, []);
  useEffect(() => { local.get<Record<string, Connection>>(connectionsKey(w.active.network)).then(c => setSites(c ?? {})); }, [w.active.network]);

  if (!s) return null;
  const name = networkName(w.active.network);
  const main = () => setPage('main');

  async function disconnect(origin: string) {
    const next = { ...sites };
    delete next[origin];
    await local.set({ [connectionsKey(w.active.network)]: next });
    setSites(next);
    toast('Disconnected');
  }

  if (page === 'sites') return (
    <>
      <Header title="Connected sites" onBack={main} />
      <Body>
        <p className="text-[13px] text-pearl-500 leading-relaxed px-0.5">Sites you approved on {name}. A site sees your address and balances; every transaction it asks for opens the wallet for your approval.</p>
        {Object.keys(sites).length === 0
          ? <EmptyState icon={<GlobeIcon size={20} />} title="No sites connected">Sites ask to connect through the wallet's own window, once per network.</EmptyState>
          : <div className="list">{Object.values(sites).map(c => (
            <div key={c.origin} className="list-row">
              <GlobeIcon size={17} className="list-icon" />
              <span className="flex-1 min-w-0">
                <span className="block truncate text-[13.5px]">{c.origin.replace(/^https?:\/\//, '')}</span>
                <span className="block text-xs text-pearl-500">Since {new Date(c.at).toLocaleDateString()}</span>
              </span>
              <Button kind="secondary" size="sm" full={false} onClick={() => disconnect(c.origin)}>Disconnect</Button>
            </div>
          ))}</div>}
      </Body>
    </>
  );
  if (page === 'autolock') return (
    <>
      <Header title="Auto-lock" onBack={main} />
      <Body>
        <p className="text-[13px] text-pearl-500 leading-relaxed px-0.5">When the wallet locks by itself. Locking forgets the unlocked phrase; your password opens it again.</p>
        <OptionList label="Auto-lock" value={String(s.autoLockMins)} options={AUTOLOCK} onChange={async v => { setS(await saveSettings({ autoLockMins: Number(v) })); await rearmAutoLock(); toast('Saved'); }} />
      </Body>
    </>
  );
  if (page === 'theme') return (
    <>
      <Header title="Theme" onBack={main} />
      <Body>
        <OptionList label="Theme" value={theme} onChange={t => { setTheme(t); setThemeState(t); }} options={[
          { value: 'system', label: 'System', sub: 'Follows your computer', icon: <MonitorIcon size={17} /> },
          { value: 'light', label: 'Light', icon: <SunIcon size={17} /> },
          { value: 'dark', label: 'Dark', icon: <MoonIcon size={17} /> },
        ]} />
      </Body>
    </>
  );
  if (page === 'password') return <PasswordPage onBack={main} />;
  if (page === 'remove') return <RemovePage onBack={main} onRemoved={onRemoved} />;

  const siteCount = Object.keys(sites).length;
  const version = chrome.runtime?.getManifest?.().version ?? '';
  return (
    <>
      <Header title="Settings" onBack={onBack} />
      <Body>
        <div className="list">
          <ListRow icon={<NetworkIcon size={17} />} label="Network" onClick={onNetwork}
            value={<span className="inline-flex items-center gap-1.5"><NetDot network={w.active.network} />{NETWORKS[w.active.network].name}</span>} />
          <ListRow icon={<LinkIcon size={17} />} label="Connected sites" value={siteCount ? String(siteCount) : 'None'} onClick={() => setPage('sites')} />
          <ListRow icon={<ClockIcon size={17} />} label="Auto-lock" value={autoLockLabel(s.autoLockMins)} onClick={() => setPage('autolock')} />
          <ListRow icon={<SunIcon size={17} />} label="Theme" value={THEME_LABEL[theme]} onClick={() => setPage('theme')} />
        </div>
        <div className="list">
          <ListRow icon={<KeyIcon size={17} />} label="Change password" onClick={() => setPage('password')} />
          <ListRow icon={<LockIcon size={17} />} label="Lock now" chevron={false} onClick={async () => { await lock(); onLock(); }} />
        </div>
        <SectionTitle>Danger zone</SectionTitle>
        <div className="list">
          <ListRow icon={<TrashIcon size={17} />} tone="danger" label="Remove wallet from this browser" onClick={() => setPage('remove')} />
        </div>
        <p className="text-xs text-pearl-500 text-center mt-2">{BRAND} {version} · no analytics, no remote code</p>
        {/* The texts of the active network's web app (config/terms.ts), each in a new tab. */}
        <p className="text-xs text-pearl-500 text-center flex justify-center gap-3">
          <a href={termsUrl(w.active.network)} target="_blank" rel="noreferrer" className="underline inline-flex items-center gap-0.5" data-testid="settings-terms">Terms of Service<ExternalIcon size={10} /></a>
          <a href={privacyUrl(w.active.network)} target="_blank" rel="noreferrer" className="underline inline-flex items-center gap-0.5" data-testid="settings-privacy">Privacy Policy<ExternalIcon size={10} /></a>
        </p>
      </Body>
    </>
  );
}

function PasswordPage({ onBack }: { onBack: () => void }) {
  const [old, setOld] = useState(''), [pw, setPw] = useState(''), [cf, setCf] = useState('');
  const [err, setErr] = useState<string | null>(null), [busy, setBusy] = useState(false);
  async function go() {
    setBusy(true); setErr(null);
    try { if (await changePassword(old, pw)) { toast('Password changed'); onBack(); } else setErr('Wrong current password.'); }
    catch (e) { setErr(errText(e)); } finally { setBusy(false); }
  }
  return (
    <>
      <Header title="Change password" onBack={onBack} />
      <Body>
        <Field label="Current password"><Input type="password" value={old} onChange={e => setOld(e.target.value)} /></Field>
        <Field label="New password" hint={`At least ${MIN_PASSWORD} characters.`}><Input type="password" value={pw} onChange={e => setPw(e.target.value)} /></Field>
        <Field label="Repeat the new password" error={cf && cf !== pw ? 'The passwords differ.' : undefined}><Input type="password" value={cf} onChange={e => setCf(e.target.value)} /></Field>
        {err && <Notice tone="error">{err}</Notice>}
        <Button size="lg" disabled={busy || pw.length < MIN_PASSWORD || pw !== cf} onClick={go}>{busy ? 'Changing…' : 'Change password'}</Button>
      </Body>
    </>
  );
}

function RemovePage({ onBack, onRemoved }: { onBack: () => void; onRemoved: () => void }) {
  const [pw, setPw] = useState(''), [err, setErr] = useState<string | null>(null);
  async function go() {
    if (!(await openVault(pw))) { setErr('Wrong password.'); return; }
    await lock();
    await removeVault();
    await forgetWallet();
    onRemoved();
  }
  return (
    <>
      <Header title="Remove wallet" onBack={onBack} />
      <Body>
        <Notice tone="warn">This deletes the sealed wallet from this browser. Without your recovery phrase, its funds are gone for good.</Notice>
        <Field label="Password"><Input type="password" value={pw} onChange={e => setPw(e.target.value)} /></Field>
        {err && <Notice tone="error">{err}</Notice>}
        <Button kind="danger" size="lg" disabled={!pw} onClick={go}>Remove this wallet</Button>
      </Body>
    </>
  );
}
