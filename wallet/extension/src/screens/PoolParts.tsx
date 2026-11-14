// Pieces the Swap and Pool screens share: the pause notice, the circuit
// breaker's room for sells, a changed quote to confirm, and "Balance: … Max".

import { useEffect, useState, type ReactNode } from 'react';
import { fmtKas } from '@/lib/format';
import { mergedFirst } from '@/activity/history';
import { poolFeeAbout, secondsUntilDaa, windowOver } from '@/kusdt/pool';
import type { PoolState } from '@/kusdt/types';
import { Button, Notice, Row } from '@/ui/kit';

/**
 * The node's feerate for a pool screen's network fee (round 15, R15-CL-3), read again every 30 s; null until read.
 * What the screen shows is what the transaction is held to (kusdt/pool.ts feerateCap).
 */
export function usePoolFeerate(read: () => Promise<number>, key: unknown): number | null {
  const [feerate, setFeerate] = useState<number | null>(null);
  useEffect(() => {
    let alive = true;
    const once = () => read().then(f => { if (alive) setFeerate(f); }, () => {});
    once();
    const again = setInterval(once, 30_000);
    return () => { alive = false; clearInterval(again); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  return feerate;
}

/**
 * "Network fee: about 0.08 KAS" at that feerate. `keep`: what the form's Max keeps for the fee, when the amount is the
 * Max: up to that much goes to the network (the change it leaves is too small for the network to keep), and the
 * build may pay it (R17-CL-1).
 */
export function PoolFeeRow({ feerate, keep }: { feerate: number | null; keep?: bigint }) {
  const about = feerate != null ? poolFeeAbout(feerate) : null;
  const text = about == null ? 'checking' : keep != null && keep > about ? `up to ${fmtKas(keep, 4)} KAS (Max keeps it for the fee)` : `about ${fmtKas(about, 4)} KAS`;
  return <Row label="Network fee" value={<span data-testid="pool-fee">{text}</span>} />;
}

/** The guardian paused the pool (SPEC §15): swaps and new liquidity stop, withdrawals don't. */
export function PausedNotice() {
  return <Notice tone="warn"><span data-testid="pool-paused">The pool is paused: swaps and new liquidity are stopped for now. Withdrawals stay open, so you can still remove liquidity.</span></Notice>;
}

/** "in about 41 min (around 13:05)", from a number of seconds. */
export function waitText(seconds: number, now = Date.now()): string {
  if (seconds < 60) return 'in under a minute';
  const mins = Math.round(seconds / 60);
  const span = mins < 60 ? `${mins} min` : `${Math.floor(mins / 60)} h${mins % 60 ? ` ${mins % 60} min` : ''}`;
  const at = new Date(now + seconds * 1000).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  return `in about ${span} (around ${at})`;
}

export interface BreakerView {
  /** KAS sells may still take out at the wallet's clock. */
  maxKasOut: bigint;
  windowEndsDaa: bigint;
  /** The wallet's breaker clock when this was read. */
  nowDaa: bigint;
  /** The pool state it was read for. */
  pool: PoolState;
}

/** Where the breaker stands: what sells may take out, and until when. */
export function breakerLine(b: BreakerView): { room: string; when: string } {
  const room = `${fmtKas(b.maxKasOut, 2)} KAS`;
  if (windowOver(b.windowEndsDaa, b.nowDaa)) return { room, when: 'the full allowance is available' };
  return { room, when: `the full allowance returns ${waitText(secondsUntilDaa(b.windowEndsDaa, b.nowDaa))}` };
}

/** A sell above the breaker's room: how much KAS may leave, until when, and the largest sell that fits. */
export function BreakerNotice({ b, maxSell, onUse }: { b: BreakerView; maxSell: string | null; onUse?: () => void }) {
  const over = windowOver(b.windowEndsDaa, b.nowDaa);
  const until = over ? '' : `, until it has refilled ${waitText(secondsUntilDaa(b.windowEndsDaa, b.nowDaa))}`;
  return (
    <Notice tone="warn" action={maxSell && onUse ? <Button size="sm" kind="secondary" full={false} onClick={onUse}>Sell {maxSell} instead</Button> : undefined}>
      <span data-testid="breaker-notice">
        The pool's circuit breaker lets sells take out at most {fmtKas(b.maxKasOut, 2)} KAS more{until}.{' '}
        {maxSell ? <>The most you can sell now is <b className="font-semibold tnum">{maxSell}</b>.</> : 'No sell fits until then.'}
      </span>
    </Notice>
  );
}

/**
 * The pool moved and gives less than what was approved: the new numbers, to confirm or drop. `merged`: merges that went
 * out first (Daybreak [9]): then it is the action's own transaction (`what`) that was not sent, and the merges are said.
 */
export function QuoteChangedCard({ children, confirm, onConfirm, onCancel, busy, merged = 0, what = 'swap' }: { children: ReactNode; confirm: string; onConfirm: () => void; onCancel: () => void; busy?: boolean; merged?: number; what?: string }) {
  return (
    <Notice tone="warn" action={
      <div className="flex gap-2">
        <Button size="sm" full={false} disabled={busy} onClick={onConfirm}>{confirm}</Button>
        <Button size="sm" kind="secondary" full={false} disabled={busy} onClick={onCancel}>Cancel</Button>
      </div>}>
      <span data-testid="quote-changed">The pool moved before this went in, and it now gives less: {children} {merged ? `The ${what} was not sent; ${mergedFirst(merged)}` : 'Nothing was sent.'}</span>
    </Notice>
  );
}

/**
 * A pool action's error. `merge`: it is MergeCoinsFirst (the wallet's KAS is in more coins than a pool transaction
 * takes), and the notice offers the way out the wallet already has: Send, opened as a send of all the KAS to the
 * wallet's own address, reviewed there before anything is signed.
 */
export function PoolError({ err, merge, onMerge }: { err: string; merge?: boolean; onMerge?: () => void }) {
  return (
    <Notice tone="error" action={merge && onMerge ? <Button size="sm" kind="secondary" full={false} onClick={onMerge}>Merge my KAS</Button> : undefined}>
      <span data-testid={merge ? 'merge-coins' : undefined}>{err}</span>
    </Notice>
  );
}

/** "Balance: 12.34 kUSDT" and Max, for the right of an amount field. */
export function BalanceMax({ text, onMax, disabled }: { text: string; onMax?: () => void; disabled?: boolean }) {
  return (
    <span className="flex items-center gap-2">
      <span>Balance: {text}</span>
      {onMax && <button type="button" className="max-btn" onClick={onMax} disabled={disabled}>Max</button>}
    </span>
  );
}
