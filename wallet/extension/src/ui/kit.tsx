// The wallet's building blocks, in the Pearl style: warm off-white and
// near-black, amber for warnings, rose for errors, no other hue. One rhythm:
// 16 px gutters, 12 px radii for controls and 16 px for cards, 12 px
// sentence-case labels, tabular numbers for amounts.

import { useEffect, useState, type MouseEvent, type ReactNode } from 'react';
import QRCode from 'qrcode';
import { AlertIcon, CheckIcon, ChevronLeftIcon, ChevronRightIcon, CopyIcon, ErrorIcon, InfoIcon } from './icons';

// ── Screen frame ────────────────────────────────────────────────────────────

/** A sub-screen's header: back, title, and room on the right. */
export function Header({ title, onBack, right }: { title: ReactNode; onBack?: () => void; right?: ReactNode }) {
  return (
    <header className={`topbar ${onBack ? 'with-back' : ''}`}>
      {onBack && <IconButton label="Back" onClick={onBack}><ChevronLeftIcon size={20} /></IconButton>}
      <h1 className="topbar-title">{title}</h1>
      {right}
    </header>
  );
}

/**
 * The scrolling body; `dense` for the busiest screens (the bridge). Its
 * children never shrink: a card that clips its overflow (.list) would
 * otherwise squeeze into the space left and cut its own rows off, and the
 * body would have nothing to scroll.
 */
export function Body({ children, className = '', dense = false }: { children: ReactNode; className?: string; dense?: boolean }) {
  return <div className={`flex-1 min-h-0 overflow-y-auto px-4 flex flex-col *:shrink-0 fade-in ${dense ? 'pt-3 pb-4 gap-2' : 'pt-4 pb-5 gap-3'} ${className}`}>{children}</div>;
}

/** Actions pinned under the body (the approval window). */
export function Footer({ children, row = false }: { children: ReactNode; row?: boolean }) {
  return <div className={`px-4 pt-3 pb-4 flex gap-2 shrink-0 border-t border-ink-700 ${row ? 'flex-row' : 'flex-col'}`}>{children}</div>;
}

// ── Buttons ─────────────────────────────────────────────────────────────────

export type ButtonKind = 'primary' | 'secondary' | 'danger' | 'quiet';

export function Button({ children, onClick, disabled, kind = 'primary', size = 'md', type = 'button', icon, className = '', full = true }: {
  children: ReactNode; onClick?: (e: MouseEvent<HTMLButtonElement>) => void; disabled?: boolean; kind?: ButtonKind; size?: 'sm' | 'md' | 'lg';
  type?: 'button' | 'submit'; icon?: ReactNode; className?: string; full?: boolean;
}) {
  return (
    <button type={type} disabled={disabled} onClick={onClick}
      className={`btn btn-${kind} ${size === 'md' ? '' : `btn-${size}`} ${full ? 'w-full' : ''} ${className}`}>
      {icon}{children}
    </button>
  );
}

export function IconButton({ label, onClick, children, disabled, small, className = '' }: {
  label: string; onClick?: () => void; children: ReactNode; disabled?: boolean; small?: boolean; className?: string;
}) {
  return (
    <button type="button" aria-label={label} title={label} disabled={disabled} onClick={onClick}
      className={`icon-btn ${small ? 'icon-btn-sm' : ''} ${className}`}>{children}</button>
  );
}

// ── Form ────────────────────────────────────────────────────────────────────

export function Field({ label, hint, error, right, children }: { label: ReactNode; hint?: ReactNode; error?: ReactNode; right?: ReactNode; children: ReactNode }) {
  return (
    <label className="flex flex-col gap-1.5">
      <span className="flex items-center justify-between gap-2 min-h-[18px]">
        <span className="text-xs font-medium text-pearl-500">{label}</span>
        {right && <span className="text-xs text-pearl-500 tnum">{right}</span>}
      </span>
      {children}
      {error ? <span className="text-xs text-rose-ink leading-snug">{error}</span>
        : hint ? <span className="text-xs text-pearl-500 leading-snug">{hint}</span> : null}
    </label>
  );
}

export function Input({ className = '', ...props }: React.InputHTMLAttributes<HTMLInputElement>) {
  return <input spellCheck={false} autoComplete="off" {...props} className={`field ${className}`} />;
}

export function TextArea({ className = '', ...props }: React.TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea spellCheck={false} autoComplete="off" {...props} className={`field ${className}`} />;
}

/** The big amount box: the number, the asset's symbol, and Max when there is one. */
export function AmountInput({ value, onChange, suffix, onMax, placeholder = '0.00', invalid, label = 'Amount', disabled }: {
  value: string; onChange: (v: string) => void; suffix?: ReactNode; onMax?: () => void; placeholder?: string; invalid?: boolean; label?: string; disabled?: boolean;
}) {
  return (
    <div className="amount-box" style={invalid ? { borderColor: 'color-mix(in srgb, var(--color-rose) 55%, var(--color-ink-700))' } : undefined}>
      <input className="amount-input" value={value} onChange={e => onChange(e.target.value)} inputMode="decimal" placeholder={placeholder}
        spellCheck={false} autoComplete="off" aria-label={label} disabled={disabled} />
      {suffix && <span className="text-sm font-semibold text-pearl-400 shrink-0">{suffix}</span>}
      {onMax && <button type="button" className="max-btn" onClick={onMax} disabled={disabled}>Max</button>}
    </div>
  );
}

export function Checkbox({ checked, onChange, children }: { checked: boolean; onChange: (v: boolean) => void; children: ReactNode }) {
  return (
    <label className="flex items-start gap-2.5 text-[13px] text-pearl-300 leading-snug cursor-pointer select-none">
      <input type="checkbox" className="mt-px" checked={checked} onChange={e => onChange(e.target.checked)} />
      <span>{children}</span>
    </label>
  );
}

// ── Display ─────────────────────────────────────────────────────────────────

export function Card({ children, className = '', pad = 'p-4' }: { children: ReactNode; className?: string; pad?: string }) {
  return <div className={`card ${pad} ${className}`}>{children}</div>;
}

/** A label and its value, on one line. */
export function Row({ label, value, strong, mono }: { label: ReactNode; value: ReactNode; strong?: boolean; mono?: boolean }) {
  return (
    <div className="flex items-baseline justify-between gap-4 py-1.5 text-[13px]">
      <span className="text-pearl-500 shrink-0">{label}</span>
      <span className={`text-right tnum min-w-0 break-words ${mono ? 'mono text-xs' : ''} ${strong ? 'text-pearl-200 font-semibold' : 'text-pearl-300'}`}>{value}</span>
    </div>
  );
}

export function SectionTitle({ children, right }: { children: ReactNode; right?: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-2 mt-1 px-0.5">
      <h2 className="text-[13px] font-semibold text-pearl-300">{children}</h2>
      {right}
    </div>
  );
}

export type Tone = 'info' | 'warn' | 'error';

export function Notice({ tone = 'info', children, action }: { tone?: Tone; children: ReactNode; action?: ReactNode }) {
  const Icon = tone === 'warn' ? AlertIcon : tone === 'error' ? ErrorIcon : InfoIcon;
  return (
    <div className={`notice notice-${tone}`} role={tone === 'info' ? 'status' : 'alert'}>
      <Icon size={15} />
      <div className="flex-1 min-w-0 flex flex-col gap-2">
        <div className="break-words">{children}</div>
        {action}
      </div>
    </div>
  );
}

export type PillTone = 'neutral' | 'done' | 'outline' | 'warn' | 'error';
export function Pill({ tone = 'neutral', children }: { tone?: PillTone; children: ReactNode }) {
  return <span className={`pill pill-${tone}`}>{children}</span>;
}

export function Spinner({ size = 14 }: { size?: number }) {
  return <span className="spin inline-block rounded-full border-2 border-pearl-700 border-t-transparent shrink-0" style={{ width: size, height: size }} aria-hidden="true" />;
}

export function Skeleton({ className = '' }: { className?: string }) {
  return <span className={`skeleton ${className}`} aria-hidden="true" />;
}

/** Options in a row; the chosen one is filled solid. */
export function Segmented<T extends string>({ value, options, onChange, small, label }: {
  value: T; options: { value: T; label: ReactNode; disabled?: boolean }[]; onChange: (v: T) => void; small?: boolean; label?: string;
}) {
  return (
    <div className={`seg ${small ? 'seg-sm' : ''}`} role="radiogroup" aria-label={label}>
      {options.map(o => (
        <button key={o.value} type="button" role="radio" aria-checked={o.value === value} disabled={o.disabled}
          onClick={() => onChange(o.value)} className={`seg-opt ${o.value === value ? 'on' : ''}`}>{o.label}</button>
      ))}
    </div>
  );
}

export function Qr({ value, size = 168 }: { value: string; size?: number }) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    QRCode.toDataURL(value, { errorCorrectionLevel: 'M', margin: 1, scale: 6, color: { dark: '#1a1816', light: '#ffffff' } })
      .then(u => { if (alive) setUrl(u); }).catch(() => {});
    return () => { alive = false; };
  }, [value]);
  return (
    <div className="rounded-2xl bg-white p-3 border border-ink-700" style={{ width: size + 26, height: size + 26 }}>
      {url ? <img src={url} width={size} height={size} alt="QR code of the address" style={{ width: size, height: size, imageRendering: 'pixelated' }} />
        : <div style={{ width: size, height: size }} className="rounded-lg bg-ink-800" />}
    </div>
  );
}

/** Kaspa: the prefix, then `head` and `tail` characters ("kaspatest:qqd6e65y…kwr78y"); EVM: "0x9858…da94" with head 6, tail 4. */
export function shortAddress(a: string, head = 8, tail = 6): string {
  const i = a.indexOf(':');
  const prefix = i >= 0 ? a.slice(0, i + 1) : '';
  const body = i >= 0 ? a.slice(i + 1) : a;
  return body.length <= head + tail + 1 ? a : `${prefix}${body.slice(0, head)}…${body.slice(-tail)}`;
}

/** An EVM address, short. */
export const shortEvm = (a: string) => shortAddress(a, 6, 4);

/** Copies public text (addresses, txids). Nothing secret is ever copied by the wallet. */
function useCopy(text: string) {
  const [done, setDone] = useState(false);
  const copy = () => navigator.clipboard.writeText(text).then(() => { setDone(true); toast('Copied'); setTimeout(() => setDone(false), 1200); }).catch(() => {});
  return { done, copy };
}

export function CopyButton({ text, label, small = true }: { text: string; label?: string; small?: boolean }) {
  const { done, copy } = useCopy(text);
  if (label) return <Button kind="secondary" size="sm" full={false} onClick={copy} icon={done ? <CheckIcon size={15} /> : <CopyIcon size={15} />}>{done ? 'Copied' : label}</Button>;
  return <IconButton label="Copy" small={small} onClick={copy}>{done ? <CheckIcon size={14} /> : <CopyIcon size={14} />}</IconButton>;
}

/** A short address with its copy button; the full address is in the tooltip. */
export function AddressChip({ address, head = 8, tail = 6 }: { address: string; head?: number; tail?: number }) {
  return (
    <span className="chip" title={address}>
      <span className="truncate">{shortAddress(address, head, tail)}</span>
      <CopyButton text={address} />
    </span>
  );
}

export function EmptyState({ icon, title, children, action }: { icon: ReactNode; title: string; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-center text-center gap-2 px-6 py-8">
      <span className="icon-badge w-12 h-12 mb-1">{icon}</span>
      <div className="text-sm font-semibold text-pearl-200">{title}</div>
      {children && <div className="text-[13px] text-pearl-500 leading-relaxed max-w-[280px]">{children}</div>}
      {action && <div className="mt-2">{action}</div>}
    </div>
  );
}

/** A settings-style row: icon, label, value, chevron. */
export function ListRow({ icon, label, sub, value, onClick, chevron = !!onClick, tone, disabled }: {
  icon?: ReactNode; label: ReactNode; sub?: ReactNode; value?: ReactNode; onClick?: () => void; chevron?: boolean; tone?: 'danger'; disabled?: boolean;
}) {
  const inner = (
    <>
      {icon && <span className={tone === 'danger' ? 'text-rose-ink shrink-0' : 'list-icon'}>{icon}</span>}
      <span className="flex-1 min-w-0">
        <span className={`block truncate ${tone === 'danger' ? 'text-rose-ink font-medium' : ''}`}>{label}</span>
        {sub && <span className="block text-xs text-pearl-500 truncate mt-0.5">{sub}</span>}
      </span>
      {value != null && <span className="text-[13px] text-pearl-500 shrink-0 tnum">{value}</span>}
      {chevron && <ChevronRightIcon size={16} className="text-pearl-600 shrink-0" />}
    </>
  );
  return onClick ? <button type="button" className="list-row" onClick={onClick} disabled={disabled}>{inner}</button> : <div className="list-row">{inner}</div>;
}

/** One choice among a few, as rows with a check. */
export function OptionList<T extends string>({ value, options, onChange, label }: {
  value: T; options: { value: T; label: string; sub?: string; icon?: ReactNode }[]; onChange: (v: T) => void; label?: string;
}) {
  return (
    <div className="list" role="radiogroup" aria-label={label}>
      {options.map(o => (
        <button key={o.value} type="button" role="radio" aria-checked={o.value === value} className="list-row" onClick={() => onChange(o.value)}>
          {o.icon && <span className="list-icon">{o.icon}</span>}
          <span className="flex-1 min-w-0">
            <span className={`block ${o.value === value ? 'font-semibold' : ''}`}>{o.label}</span>
            {o.sub && <span className="block text-xs text-pearl-500 mt-0.5">{o.sub}</span>}
          </span>
          {o.value === value && <CheckIcon size={17} className="text-pearl-200 shrink-0" />}
        </button>
      ))}
    </div>
  );
}

// ── Toasts ──────────────────────────────────────────────────────────────────

let toastListener: ((m: string) => void) | null = null;
export const toast = (m: string) => toastListener?.(m);
export function ToastHost() {
  const [msg, setMsg] = useState<string | null>(null);
  useEffect(() => {
    let t: ReturnType<typeof setTimeout> | undefined;
    toastListener = (m) => { setMsg(m); clearTimeout(t); t = setTimeout(() => setMsg(null), 1600); };
    return () => { toastListener = null; clearTimeout(t); };
  }, []);
  if (!msg) return null;
  return (
    <div className="absolute inset-x-0 bottom-20 flex justify-center pointer-events-none z-50" role="status">
      <div className="toast fade-in">{msg}</div>
    </div>
  );
}

export const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e)) || 'Something went wrong.';
