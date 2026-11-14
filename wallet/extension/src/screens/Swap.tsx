// KAS ⇄ kUSDT on the pool. The quote comes from the core on the newest
// verified pool state; the user sets the minimum to receive, and the wallet
// never submits below it (kusdt/pool.ts). A paused pool takes no swaps; a sell
// is held to the circuit breaker's room, which the core computes at the
// wallet's clock; a quote that got worse before the swap went in is shown
// again for the user to confirm.

import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { TOKEN_SYMBOL } from '@/brand';
import { fmtKas, fmtKasBalance, fmtUsdt, fmtUsdt2, parseKasText, parseUsdtText, formatUnits, parseUnits, plain } from '@/lib/format';
import { poolReady } from '@/config/settings';
import { networkName } from '@/config/networks';
import { useWallet } from '@/popup/state';
import { TopBar, useNav } from '@/popup/nav';
import {
  BreakerLimit, FEE_KEEP, PoolPaused, QuoteChanged, freshPool, largestSellWithin, lockedKasFor, maxBuyAcceptedFee, maxKasIn, minimumFor, poolFeeAbout, poolFeeShareText, quoteBuy, quoteSell, quoteSellAt, sellNowDaa, swap,
} from '@/kusdt/pool';
import type { VerifiedPool } from '@/kusdt/verify';
import { addActivity, afterMerges, followMaybeSent, outcomeStatus } from '@/activity/history';
import { Body, Button, Card, EmptyState, Field, IconButton, Input, Notice, Row, Segmented, Skeleton, errText } from '@/ui/kit';
import { FlipIcon, PoolIcon, RefreshIcon, SlidersIcon, SwapIcon, TokenMark, type TokenKind } from '@/ui/icons';
import { guardedSigner, useFormLock } from '@/lib/formLock';
import { Done, UNCONFIRMED_NOTE } from './Send';
import { BalanceMax, BreakerNotice, PausedNotice, PoolError, PoolFeeRow, QuoteChangedCard, breakerLine, usePoolFeerate, type BreakerView } from './PoolParts';
import { isMergeCoinsFirst } from '@/kusdt/inputs';

const SLIPPAGES = ['0.1', '0.5', '1'] as const;

export function TokenChip({ kind, symbol }: { kind: TokenKind; symbol: string }) {
  return <span className="token-chip"><TokenMark kind={kind} size={22} />{symbol}</span>;
}

function SwapPanel({ label, right, children }: { label: string; right?: ReactNode; children: ReactNode }) {
  return (
    <div className="panel">
      <div className="flex items-center justify-between gap-2 text-xs text-pearl-500">
        <span className="font-medium">{label}</span>
        {right && <span className="tnum flex items-center gap-2">{right}</span>}
      </div>
      <div className="flex items-center gap-3 mt-2 h-10">{children}</div>
    </div>
  );
}

export function Swap() {
  const w = useWallet();
  const nav = useNav();
  const [side, setSide] = useState<'buy' | 'sell'>('buy');
  const [amountText, setAmountText] = useState('');
  const [slippage, setSlippage] = useState('0.5');
  const [minText, setMinText] = useState('');
  const [showSlippage, setShowSlippage] = useState(false);
  const [vp, setVp] = useState<VerifiedPool | null>(null);
  /** The node's virtual DAA when the pool was read: the breaker's clock. */
  const [virtualDaa, setVirtualDaa] = useState<bigint | null>(null);
  const [loading, setLoading] = useState(false);
  const [quote, setQuote] = useState<bigint | null>(null);
  const [breaker, setBreaker] = useState<BreakerView | null>(null);
  /** Sells: the largest that fits the breaker's room and the balance. */
  const [maxFit, setMaxFit] = useState<bigint | null>(null);
  const [err, setErr] = useState<string | null>(null);
  /** The text of a MergeCoinsFirst error: while it is the one shown, the notice offers the merge. */
  const [mergeErr, setMergeErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  /** A worse quote to confirm; `merged`: the merges that went out before it (Daybreak [9]). */
  const [changed, setChanged] = useState<{ seen: bigint; now: bigint; merged: number } | null>(null);
  // What was swapped, as it was sent: its side is the swap's, not the one the form shows afterwards.
  const [done, setDone] = useState<{ txid: string; out: bigint; side: 'buy' | 'sell'; confirmed: boolean } | null>(null);
  const outDec = side === 'buy' ? 6 : 8;
  const amountIn = side === 'buy' ? parseKasText(amountText) : parseUsdtText(amountText);
  const minOut = parseUnits(minText, outDec);
  const ready = poolReady(w.active.config);
  const b = w.balances;
  const clickedForm = useFormLock({ side, amountText, minText });
  // The fee the swap is shown with and held to (R15-CL-3).
  const feerate = usePoolFeerate(async () => (await w.ctx()).node.feerate(), w.active.network);

  const loadPool = useCallback(async (alive: () => boolean = () => true) => {
    setLoading(true);
    try {
      const ctx = await w.ctx();
      const [p, daa] = await Promise.all([freshPool(ctx), ctx.node.virtualDaa()]);
      if (alive()) { setVp(p); setVirtualDaa(daa); setErr(null); }
    } catch (e) { if (alive()) setErr(errText(e)); }
    finally { if (alive()) setLoading(false); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [w.active.network]);

  useEffect(() => {
    if (!ready) return;
    let alive = true;
    loadPool(() => alive);
    return () => { alive = false; };
  }, [loadPool, ready]);

  const opened = !!vp && !!vp.reserve && vp.pool.state.totalShares > 0n;
  const paused = !!vp?.pool.state.paused;

  useEffect(() => {
    (async () => {
      if (!vp || !opened || !amountIn || amountIn <= 0n) { setQuote(null); return; }
      const ctx = await w.ctx();
      const q = side === 'buy' ? quoteBuy(ctx, vp.pool.state, amountIn) : quoteSell(ctx, vp.pool.state, amountIn);
      setQuote(q);
      const bps = Math.round(Number(slippage) * 100);
      if (Number.isFinite(bps) && bps >= 0 && bps <= 5000) setMinText(plain(formatUnits(minimumFor(q, bps), outDec)));
    })().catch(e => setErr(errText(e)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [vp, amountText, side, slippage]);

  // Sells: what the circuit breaker lets out at the wallet's clock (the core's own computation), and the largest sell that fits.
  useEffect(() => {
    (async () => {
      if (side !== 'sell' || !vp || !opened || virtualDaa == null) { setBreaker(null); setMaxFit(null); return; }
      const ctx = await w.ctx();
      const nowDaa = sellNowDaa(vp.pool.state, virtualDaa);
      const q = quoteSellAt(ctx, vp.pool.state, 0n, nowDaa, vp.pool.utxo.blockDaaScore);
      setBreaker({ maxKasOut: q.breaker.maxKasOut, windowEndsDaa: q.breaker.windowEndsDaa, nowDaa, pool: vp.pool.state });
      setMaxFit(b?.kusdt != null ? largestSellWithin(ctx, vp.pool.state, q.breaker.maxKasOut, b.kusdt) : null);
    })().catch(e => setErr(errText(e)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [vp, virtualDaa, side, b?.kusdt]);

  async function go(quoted: bigint) {
    if (!amountIn || !minOut || busy || feerate == null) return;
    const shownFeerate = feerate;
    // Max says it keeps FEE_KEEP for the network fee: a buy of it may pay that, change the network does not keep included (R17-CL-1).
    const acceptedFee = maxBuyAcceptedFee({ config: w.active.config }, side, amountIn, b?.kasSpendable);
    // The form is locked while this runs; should it have changed all the same, or been left, nothing more is signed.
    const signer = guardedSigner(w.signer, clickedForm());
    setBusy(true); setErr(null); setChanged(null);
    // The merges a sale sends first: once one went out, "nothing was sent" is said of the swap itself (Daybreak [9]).
    let merged = 0;
    try {
      const ctx = await w.ctx();
      const r = await followMaybeSent(ctx.network, side === 'buy' ? { kind: 'swap-buy', kas: amountIn.toString(), kusdt: quoted.toString() } : { kind: 'swap-sell', kusdt: amountIn.toString(), kas: quoted.toString() },
        () => swap(ctx, signer, w.kasAddresses, { side, amountIn, minOut, quoted, shownFeerate, acceptedFee }, (t) => { merged++; addActivity(ctx.network, { kind: 'kusdt-merge', txid: t }).catch(() => {}); }));
      await addActivity(ctx.network, side === 'buy'
        ? { kind: 'swap-buy', txid: r.txid, kas: amountIn.toString(), kusdt: r.amountOut.toString(), fee: r.built.fee.toString(), ...outcomeStatus(r.confirmed) }
        : { kind: 'swap-sell', txid: r.txid, kusdt: amountIn.toString(), kas: r.amountOut.toString(), fee: r.built.fee.toString(), ...outcomeStatus(r.confirmed) });
      setDone({ txid: r.txid, out: r.amountOut, side, confirmed: r.confirmed });
      w.refresh();
    } catch (e) {
      if (e instanceof QuoteChanged && typeof e.now === 'bigint' && typeof e.seen === 'bigint') setChanged({ seen: e.seen, now: e.now, merged });
      else {
        const text = afterMerges(errText(e), merged, side === 'buy' ? 'buy' : 'sale');
        setErr(text);
        setMergeErr(isMergeCoinsFirst(e) ? text : null);
        // The pool changed under the form (paused, or the breaker's room moved): show it as it is now.
        if (e instanceof PoolPaused || e instanceof BreakerLimit) loadPool();
      }
    } finally { setBusy(false); }
  }

  const name = networkName(w.active.network);
  if (!ready) return (
    <>
      <TopBar title="Swap" />
      <Body>
        <EmptyState icon={<SwapIcon size={20} />} title={`No pool on ${name} yet`}>
          Swaps between KAS and {TOKEN_SYMBOL} run on the pool, which is not live on {name}.
        </EmptyState>
      </Body>
    </>
  );

  // Sent is not done: "Swapped" only once the node showed the swap accepted (kusdt/pool.ts sendToPool).
  const doneOut = done && (done.side === 'buy' ? `${fmtUsdt(done.out)} ${TOKEN_SYMBOL}` : `${fmtKas(done.out)} KAS`);
  if (done) return <Done title="Swap" heading={done.confirmed ? 'Swapped' : 'Swap sent'} txid={done.txid}
    lines={done.confirmed ? [`You received ${doneOut}.`] : [`The network has not confirmed it yet. Once it does, you receive ${doneOut}.`, UNCONFIRMED_NOTE]}
    onClose={() => { setDone(null); setAmountText(''); setMinText(''); setVp(null); loadPool(); }} />;

  if (vp && !opened) return (
    <>
      <TopBar title="Swap" />
      <Body>
        <EmptyState icon={<PoolIcon size={20} />} title="The pool has no liquidity yet"
          action={<Button full={false} onClick={() => nav.setTab('pool')}>Open the pool</Button>}>
          Swaps start once the pool's first deposit of KAS and {TOKEN_SYMBOL} sets its price. You can make it from the Pool tab.
        </EmptyState>
      </Body>
    </>
  );

  const s = vp?.pool.state;
  const price = s && s.tokenReserve > 0n ? formatUnits((s.kasReserve * 1_000_000n) / s.tokenReserve, 8, 4) : null;
  const kasBal = b ? fmtKasBalance(b.kasSpendable) : '—';
  const tokBal = b?.kusdt != null ? fmtUsdt2(b.kusdt) : '—';
  const inKind: TokenKind = side === 'buy' ? 'kas' : 'kusdt', outKind: TokenKind = side === 'buy' ? 'kusdt' : 'kas';
  const inSym = side === 'buy' ? 'KAS' : TOKEN_SYMBOL, outSym = side === 'buy' ? TOKEN_SYMBOL : 'KAS';
  const flip = () => { if (busy) return; setSide(x => (x === 'buy' ? 'sell' : 'buy')); setAmountText(''); setMinText(''); setChanged(null); };
  const cfg = { config: w.active.config };
  // Max: a buy keeps the KAS its new token carries and the fee; a sell is held to the breaker's room.
  const kasMax = b ? maxKasIn(cfg, 'buy', b.kasSpendable) : null;
  const tokMax = b?.kusdt != null ? (maxFit != null && maxFit < b.kusdt ? maxFit : b.kusdt) : null;
  const max = side === 'buy' ? kasMax : tokMax;
  const heldByBreaker = side === 'sell' && maxFit != null && b?.kusdt != null && maxFit < b.kusdt;
  const kept = lockedKasFor(cfg, 'buy') + FEE_KEEP;
  const overBalance = amountIn != null && amountIn > 0n && !!b && (side === 'buy' ? kasMax != null && amountIn > kasMax : b.kusdt != null && amountIn > b.kusdt);
  const overBreaker = side === 'sell' && breaker != null && quote != null && quote > breaker.maxKasOut;
  const fmtIn = (v: bigint) => (side === 'buy' ? fmtKas(v) : fmtUsdt(v));
  const fmtOut = (v: bigint) => (side === 'buy' ? `${fmtUsdt(v)} ${TOKEN_SYMBOL}` : `${fmtKas(v)} KAS`);
  const bl = breaker ? breakerLine(breaker) : null;
  const canSwap = !busy && !!vp && !paused && !!amountIn && !!minOut && minOut > 0n && !(quote != null && minOut > quote) && !overBreaker && !overBalance && feerate != null;
  const feeShare = feerate != null && amountIn && quote != null ? poolFeeShareText(poolFeeAbout(feerate), side === 'buy' ? amountIn : quote) : null;

  return (
    <>
      <TopBar title="Swap" />
      <Body>
        <div className="flex items-center justify-between gap-2 -mt-1 -mb-1">
          <span className="flex items-center gap-1 text-xs text-pearl-500 tnum">
            {price ? <>1 {TOKEN_SYMBOL} = {price} KAS</> : err ? 'Pool price unavailable' : <Skeleton className="h-3 w-36" />}
            <IconButton label="Refresh the pool" small onClick={() => loadPool()} disabled={loading || busy}><RefreshIcon size={13} className={loading ? 'spin' : ''} /></IconButton>
          </span>
          <button type="button" className="btn btn-quiet btn-sm -mr-2" onClick={() => setShowSlippage(v => !v)} aria-expanded={showSlippage} aria-label="Slippage settings">
            <SlidersIcon size={14} />{slippage}%
          </button>
        </div>
        {paused && <PausedNotice />}
        {showSlippage && (
          <Card pad="p-3.5" className="flex flex-col gap-3 fade-in">
            <Field label="Slippage tolerance" right={<span>The most the price may move</span>}>
              <div className="flex gap-2 items-center">
                <div className="flex-1"><Segmented small label="Slippage" value={slippage} onChange={setSlippage} options={SLIPPAGES.map(v => ({ value: v, label: `${v}%`, disabled: busy }))} /></div>
                <div className="relative w-[84px]">
                  <Input value={slippage} onChange={e => setSlippage(e.target.value)} inputMode="decimal" aria-label="Custom slippage, in percent" disabled={busy} className="h-[34px] text-[13px] pr-7 tnum" />
                  <span className="absolute right-2.5 top-1/2 -translate-y-1/2 text-xs text-pearl-500 pointer-events-none">%</span>
                </div>
              </div>
            </Field>
            <Field label={`Minimum to receive (${outSym})`} hint="Set from the slippage; you can also type it.">
              <Input value={minText} onChange={e => setMinText(e.target.value)} inputMode="decimal" className="tnum" disabled={busy} />
            </Field>
            <p className="text-xs text-pearl-500 leading-relaxed">If the pool moves before your swap lands, the wallet quotes again on its newest state (up to 3 times). It goes ahead on its own only if you get at least what you saw; for less it asks you first, and never goes below the minimum.</p>
          </Card>
        )}
        <div className="flex flex-col gap-1.5">
          <SwapPanel label="You pay" right={<BalanceMax text={side === 'buy' ? `${kasBal} KAS` : `${tokBal} ${TOKEN_SYMBOL}`}
            onMax={!paused && max != null && max > 0n ? () => { setAmountText(plain(fmtIn(max))); setChanged(null); } : undefined} disabled={busy} />}>
            <input className="amount-input" value={amountText} onChange={e => { setAmountText(e.target.value); setChanged(null); }} inputMode="decimal" placeholder="0.00" aria-label="You pay"
              spellCheck={false} autoComplete="off" disabled={paused || busy} />
            <TokenChip kind={inKind} symbol={inSym} />
          </SwapPanel>
          <div className="relative h-0"><button type="button" className="flip-btn" disabled={busy} onClick={flip} aria-label={`Switch to ${outSym} → ${inSym}`} title="Switch direction"><FlipIcon size={16} /></button></div>
          <SwapPanel label="You receive" right={<span>Balance: {side === 'buy' ? `${tokBal} ${TOKEN_SYMBOL}` : `${kasBal} KAS`}</span>}>
            <span className={`panel-amount ${quote == null ? 'text-pearl-800' : ''}`} aria-live="polite">{quote != null ? formatUnits(quote, outDec) : '0.00'}</span>
            <TokenChip kind={outKind} symbol={outSym} />
          </SwapPanel>
        </div>
        {side === 'buy' && <p className="text-xs text-pearl-500 leading-relaxed px-0.5 -mt-1">Max keeps {fmtKas(kept)} KAS: {fmtKas(lockedKasFor(cfg, 'buy'))} KAS for your new {TOKEN_SYMBOL} token and {fmtKas(FEE_KEEP)} KAS for the network fee.</p>}
        {heldByBreaker && <p className="text-xs text-pearl-500 leading-relaxed px-0.5 -mt-1">Max is held to {fmtUsdt(maxFit!)} {TOKEN_SYMBOL} by the pool's circuit breaker.</p>}
        <Card pad="px-4 py-1">
          <Row label="Minimum received" value={minOut != null && minText ? `${minText} ${outSym}` : '—'} strong />
          <Row label="Pool fee" value="0.50 %" />
          <PoolFeeRow feerate={feerate} keep={side === 'buy' && kasMax != null && amountIn === kasMax ? FEE_KEEP : undefined} />
          {side === 'buy' && <Row label="Kept in your token" value={`${fmtKas(BigInt(w.active.config.tokenValue))} KAS`} />}
          {side === 'sell' && bl && <Row label="Sells may still take out" value={<span data-testid="breaker-room">{bl.room}<span className="block text-xs text-pearl-500 mt-0.5">{bl.when}</span></span>} />}
        </Card>
        {overBreaker && breaker && <BreakerNotice b={breaker} maxSell={maxFit && maxFit > 0n ? `${fmtUsdt(maxFit)} ${TOKEN_SYMBOL}` : null} onUse={maxFit && maxFit > 0n && !busy ? () => setAmountText(plain(fmtUsdt(maxFit))) : undefined} />}
        {overBalance && <Notice tone="warn">{side === 'buy' ? `That leaves too little KAS: keep ${fmtKas(kept)} KAS for your new token and the network fee.` : 'That is more than you have.'}</Notice>}
        {quote != null && minOut != null && minOut > quote && <Notice tone="warn">The minimum is above the current quote: the swap would be refused.</Notice>}
        {feeShare && <Notice tone="warn"><span data-testid="pool-fee-share">{feeShare}</span></Notice>}
        {changed && (
          <QuoteChangedCard confirm="Swap at the new quote" busy={busy} merged={changed.merged} what={side === 'buy' ? 'buy' : 'sale'} onConfirm={() => go(changed.now)} onCancel={() => { setChanged(null); loadPool(); }}>
            you would now receive <b className="font-semibold tnum">{fmtOut(changed.now)}</b> instead of {fmtOut(changed.seen)}.
          </QuoteChangedCard>
        )}
        {err && <PoolError err={err} merge={err === mergeErr} onMerge={() => nav.push('merge')} />}
        <Button size="lg" disabled={!canSwap || !!changed} onClick={() => quote != null && go(quote)}>{busy ? 'Swapping…' : paused ? 'The pool is paused' : `Swap ${inSym} for ${outSym}`}</Button>
      </Body>
    </>
  );
}
