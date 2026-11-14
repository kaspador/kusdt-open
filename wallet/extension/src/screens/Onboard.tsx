// Creating or importing the wallet, and unlocking it.
//
// The 24-word phrase is shown while creating (the same words until the wallet
// exists: keys/draft.ts), and checked by asking for three of them. After that the
// wallet has no way to show it, or any key, again (no export in the UI).

import { useMemo, useRef, useState, useEffect, type ReactNode } from 'react';
import { BRAND, BRAND_TAGLINE, TOKEN_SYMBOL } from '@/brand';
import { cleanMnemonic } from '@/keys/derive';
import { clearDraft } from '@/keys/draft';
import { createVault, openVault, MIN_PASSWORD } from '@/keys/vault';
import { unlockWith } from '@/keys/session';
import { Body, Button, Checkbox, Field, Header, Input, Notice, TextArea, errText } from '@/ui/kit';
import { BrandMark, BridgeIcon, ShieldCheckIcon, SwapIcon } from '@/ui/icons';
import { acceptTerms } from '@/config/terms';
import { TermsCheck } from './Terms';

function Feature({ icon, children }: { icon: ReactNode; children: ReactNode }) {
  return (
    <div className="flex items-start gap-3 text-left">
      <span className="icon-badge w-8 h-8">{icon}</span>
      <span className="text-[13px] text-pearl-400 leading-snug pt-1.5">{children}</span>
    </div>
  );
}

/**
 * The first screen. Creating or importing waits for the Terms of Service to be accepted (the box), and the version
 * accepted is stored before going on, so the wallet set up next, in this window or one of its own, is not asked again.
 */
export function Welcome({ onCreate, onImport }: { onCreate: () => void; onImport: () => void }) {
  const [ticked, setTicked] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const then = (next: () => void) => () => {
    if (!ticked) return;
    acceptTerms().then(next, e => setErr(errText(e)));
  };
  return (
    <div className="flex-1 flex flex-col px-6 pt-6 pb-5 fade-in">
      <div className="flex-1 flex flex-col items-center justify-center text-center">
        <BrandMark size={64} />
        <h1 className="text-[22px] font-semibold mt-4 text-pearl-200">{BRAND}</h1>
        <p className="text-sm text-pearl-500 mt-1">{BRAND_TAGLINE}.</p>
        <div className="flex flex-col gap-3 mt-7 w-full max-w-[290px]">
          <Feature icon={<ShieldCheckIcon size={16} />}>Your keys stay in this browser, sealed with your password.</Feature>
          <Feature icon={<BridgeIcon size={16} />}>Bridge USDT from Ethereum and BNB Chain to {TOKEN_SYMBOL} on Kaspa, and back.</Feature>
          <Feature icon={<SwapIcon size={16} />}>Swap KAS and {TOKEN_SYMBOL} on the pool.</Feature>
        </div>
      </div>
      <div className="flex flex-col gap-2">
        <div className="mb-1.5"><TermsCheck checked={ticked} onChange={setTicked} /></div>
        {err && <Notice tone="error">{err}</Notice>}
        <Button size="lg" disabled={!ticked} onClick={then(onCreate)}>Create a new wallet</Button>
        <Button size="lg" kind="secondary" disabled={!ticked} onClick={then(onImport)}>I have a recovery phrase</Button>
        <p className="text-xs text-pearl-500 text-center mt-1.5">No analytics, no remote code.</p>
      </div>
    </div>
  );
}

function PasswordFields({ pw, setPw, cf, setCf }: { pw: string; setPw: (s: string) => void; cf: string; setCf: (s: string) => void }) {
  return (
    <>
      <Field label="Password" hint={`At least ${MIN_PASSWORD} characters. It unlocks the wallet in this browser only.`}>
        <Input type="password" value={pw} onChange={e => setPw(e.target.value)} />
      </Field>
      <Field label="Repeat the password" error={cf && cf !== pw ? 'The passwords differ.' : undefined}>
        <Input type="password" value={cf} onChange={e => setCf(e.target.value)} />
      </Field>
    </>
  );
}

function Steps({ at }: { at: number }) {
  return (
    <div className="flex gap-1.5 justify-center" aria-label={`Step ${at} of 3`}>
      {[1, 2, 3].map(i => <span key={i} className={`h-1 rounded-full transition-all ${i === at ? 'w-6 bg-pearl-200' : 'w-3 bg-ink-600'}`} />)}
    </div>
  );
}

export function Create({ mnemonic, onBack, onDone }: { mnemonic: string; onBack: () => void; onDone: () => void }) {
  const words = mnemonic.split(' ');
  const [step, setStep] = useState<'show' | 'check' | 'password'>('show');
  const [saved, setSaved] = useState(false);
  const positions = useMemo(() => {
    const all = words.map((_, i) => i);
    const out: number[] = [];
    const rnd = new Uint32Array(3);
    crypto.getRandomValues(rnd);
    for (const r of rnd) out.push(all.splice(r % all.length, 1)[0]);
    return out.sort((a, b) => a - b);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mnemonic]);
  const [answers, setAnswers] = useState<Record<number, string>>({});
  const checked = positions.every(i => (answers[i] ?? '').trim().toLowerCase() === words[i]);
  const [pw, setPw] = useState(''), [cf, setCf] = useState('');
  const [busy, setBusy] = useState(false), [err, setErr] = useState<string | null>(null);

  async function finish() {
    setBusy(true); setErr(null);
    try { await createVault(mnemonic, pw); await unlockWith(mnemonic); await clearDraft(); onDone(); }
    catch (e) { setErr(errText(e)); } finally { setBusy(false); }
  }

  if (step === 'show') return (
    <>
      <Header title="Your recovery phrase" onBack={onBack} />
      <Body>
        <Steps at={1} />
        <Notice tone="warn">Write these 24 words down, in order, and keep them offline. They are the only backup of this wallet: anyone with them controls its funds, and the wallet will not show them again.</Notice>
        <div className="card p-2.5 grid grid-cols-3 gap-1.5">
          {words.map((w, i) => (
            <div key={i} className="inset px-2 py-1.5 text-[12.5px] mono flex gap-1.5 items-baseline"><span className="text-pearl-600 w-5 text-right text-[11px] tnum">{i + 1}</span><span className="text-pearl-200">{w}</span></div>
          ))}
        </div>
        <Checkbox checked={saved} onChange={setSaved}>I wrote the phrase down, in order, and keep it offline</Checkbox>
        <Button size="lg" disabled={!saved} onClick={() => setStep('check')}>Continue</Button>
      </Body>
    </>
  );
  if (step === 'check') return (
    <>
      <Header title="Check your phrase" onBack={() => setStep('show')} />
      <Body>
        <Steps at={2} />
        <p className="text-[13px] text-pearl-500 px-0.5">Type these words from your written copy.</p>
        {positions.map(i => (
          <Field key={i} label={`Word ${i + 1}`}><Input value={answers[i] ?? ''} onChange={e => setAnswers({ ...answers, [i]: e.target.value })} /></Field>
        ))}
        <Button size="lg" disabled={!checked} onClick={() => setStep('password')}>Continue</Button>
      </Body>
    </>
  );
  return (
    <>
      <Header title="Set a password" onBack={() => setStep('check')} />
      <Body>
        <Steps at={3} />
        <PasswordFields pw={pw} setPw={setPw} cf={cf} setCf={setCf} />
        {err && <Notice tone="error">{err}</Notice>}
        <Button size="lg" disabled={busy || pw.length < MIN_PASSWORD || pw !== cf} onClick={finish}>{busy ? 'Sealing…' : 'Create wallet'}</Button>
      </Body>
    </>
  );
}

export function Import({ onBack, onDone }: { onBack: () => void; onDone: () => void }) {
  const [phrase, setPhrase] = useState('');
  const [pw, setPw] = useState(''), [cf, setCf] = useState('');
  const [busy, setBusy] = useState(false), [err, setErr] = useState<string | null>(null);
  const clean = cleanMnemonic(phrase);
  async function finish() {
    if (!clean) return;
    setBusy(true); setErr(null);
    try { await createVault(clean, pw); await unlockWith(clean); await clearDraft(); setPhrase(''); onDone(); }
    catch (e) { setErr(errText(e)); } finally { setBusy(false); }
  }
  return (
    <>
      <Header title="Import a recovery phrase" onBack={onBack} />
      <Body>
        <Field label="Recovery phrase" error={phrase && !clean ? 'Not a valid 12- or 24-word English phrase yet.' : undefined}
          hint={'Kaspa: m/44\'/111111\'/0\', the same keys on mainnet and on test networks: for testing, use a phrase that holds no real KAS. EVM: m/44\'/60\'/0\'/0/0.'}>
          <TextArea rows={4} className="mono text-[13px]" value={phrase} onChange={e => setPhrase(e.target.value)} placeholder="word1 word2 word3 …" />
        </Field>
        <PasswordFields pw={pw} setPw={setPw} cf={cf} setCf={setCf} />
        {err && <Notice tone="error">{err}</Notice>}
        <Button size="lg" disabled={busy || !clean || pw.length < MIN_PASSWORD || pw !== cf} onClick={finish}>{busy ? 'Sealing…' : 'Import'}</Button>
      </Body>
    </>
  );
}

export function Unlock({ onUnlocked }: { onUnlocked: () => void }) {
  const [pw, setPw] = useState('');
  const [busy, setBusy] = useState(false), [err, setErr] = useState<string | null>(null);
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => { ref.current?.focus(); }, []);
  async function go() {
    if (!pw || busy) return;
    setBusy(true); setErr(null);
    try {
      const m = await openVault(pw);
      if (!m) { setErr('Wrong password.'); return; }
      await unlockWith(m);
      setPw('');
      onUnlocked();
    } finally { setBusy(false); }
  }
  return (
    <div className="flex-1 flex flex-col px-6 pt-6 pb-5 fade-in">
      <div className="flex-1 flex flex-col items-center justify-center text-center">
        <BrandMark size={56} />
        <h1 className="text-[20px] font-semibold mt-4 text-pearl-200">Welcome back</h1>
        <p className="text-[13px] text-pearl-500 mt-1">Unlock {BRAND} with your password.</p>
        <div className="w-full max-w-[290px] mt-6 flex flex-col gap-2">
          <input ref={ref} type="password" value={pw} onChange={e => { setPw(e.target.value); setErr(null); }} onKeyDown={e => { if (e.key === 'Enter') go(); }}
            placeholder="Password" aria-label="Password" className={`field text-center ${err ? 'invalid' : ''}`} />
          <p className="text-xs text-rose-ink min-h-[16px]" role="alert">{err}</p>
        </div>
      </div>
      <Button size="lg" disabled={!pw || busy} onClick={go}>{busy ? 'Unlocking…' : 'Unlock'}</Button>
    </div>
  );
}
