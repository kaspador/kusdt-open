// Liquidity: the pool, the wallet's positions, adding and removing, and the
// pool's first deposit ("Open the pool") while it has no liquidity yet.
// Paused, the pool takes no new liquidity; removing it stays open.

import { useCallback, useEffect, useState } from 'react';
import { TOKEN_SYMBOL } from '@/brand';
import { fmtKas, fmtKasBalance, fmtUsdt, fmtUsdt2, parseKasText, parseUsdtText, formatUnits, plain } from '@/lib/format';
import { poolReady } from '@/config/settings';
import { networkName } from '@/config/networks';
import { useWallet } from '@/popup/state';
import { NetworkBanner, NetworkButton, TopBar, useNav } from '@/popup/nav';
import {
  FEE_KEEP, LOCKED_SHARES, ONLY_THE_ADMIN, PoolPaused, QuoteChanged, addLiquidity, freshPool, kasForTokens, loadPositions, lockedKasFor, maxKasIn, minimumFor, openPool, openTerms,
  poolFeeAbout, poolFeeShareText, quoteAdd, quoteRemove, removeLiquidity, tokensForKas, trimToShares, type Position,
} from '@/kusdt/pool';
import type { VerifiedPool } from '@/kusdt/verify';
import { addActivity, afterMerges, followMaybeSent, outcomeStatus } from '@/activity/history';
import { AmountInput, Body, Button, Card, EmptyState, Field, Header, IconButton, Notice, Pill, Row, SectionTitle, Skeleton, errText } from '@/ui/kit';
import { PlusIcon, PoolIcon, RefreshIcon, ShieldCheckIcon, TokenMark } from '@/ui/icons';
import { guardedSigner, useFormLock } from '@/lib/formLock';
import { Done, UNCONFIRMED_NOTE } from './Send';
import { BalanceMax, PausedNotice, PoolError, PoolFeeRow, QuoteChangedCard, usePoolFeerate } from './PoolParts';
import { isMergeCoinsFirst } from '@/kusdt/inputs';

function PairMarks() {
  return (
    <span className="flex items-center shrink-0">
      <TokenMark kind="kas" size={30} />
      <span className="-ml-2.5 rounded-full ring-2 ring-ink-900 inline-flex"><TokenMark kind="kusdt" size={30} /></span>
    </span>
  );
}

const opened = (vp: VerifiedPool | null) => !!vp && !!vp.reserve && vp.pool.state.totalShares > 0n;

/**
 * What a deposit of the Max KAS (`kasRoom`) keeps for the network fee: FEE_KEEP, and what the pool ratio leaves of the
 * KAS besides. Up to that much may go to the network as change too small to keep, as the fee row then says; any other
 * amount is held to the fee shown (R17-CL-1).
 */
function maxKeep(kasIn: bigint, tokensIn: bigint, kasRoom: bigint, pool: VerifiedPool['pool']['state']): bigint | undefined {
  if (kasIn !== kasRoom) return undefined;
  return FEE_KEEP + (kasIn - trimToShares(pool, kasIn, tokensIn).kasIn);
}

export function PoolTab() {
  const w = useWallet();
  const nav = useNav();
  const [vp, setVp] = useState<VerifiedPool | null>(null);
  const [positions, setPositions] = useState<Position[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  /** The text of a MergeCoinsFirst error: while it is the one shown, the notice offers the merge. */
  const [mergeErr, setMergeErr] = useState<string | null>(null);
  const [mode, setMode] = useState<'list' | 'add' | 'open'>('list');
  const [busy, setBusy] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  /** A removal whose quote got worse before it went in: the new numbers, to confirm. */
  const [changed, setChanged] = useState<{ id: string; seen: { kasOut: bigint; tokensOut: bigint }; now: { kasOut: bigint; tokensOut: bigint } } | null>(null);
  // The fee a removal is shown with and held to (R15-CL-3).
  const feerate = usePoolFeerate(async () => (await w.ctx()).node.feerate(), w.active.network);

  const load = useCallback(async () => {
    setErr(null); setLoading(true);
    try {
      const ctx = await w.ctx();
      setVp(await freshPool(ctx));
      setPositions(await loadPositions(ctx, w.signer));
    } catch (e) { setErr(errText(e)); setPositions(p => p ?? []); } finally { setLoading(false); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [w.active.network]);
  useEffect(() => { if (poolReady(w.active.config)) load(); }, [load]);

  async function remove(p: Position, quoted?: { kasOut: bigint; tokensOut: bigint }) {
    if (!vp || !opened(vp) || feerate == null) return;
    const shownFeerate = feerate;
    setBusy(p.id); setErr(null); setNote(null); setChanged(null);
    try {
      const ctx = await w.ctx();
      // What the user saw: this pool's quote, or the new one they just confirmed. The 99 % floor stays from what they saw first.
      const q = quoted ?? quoteRemove(ctx, vp.pool.state, p.located.state.shares);
      const r = await followMaybeSent(ctx.network, { kind: 'lp-remove', kas: q.kasOut.toString(), kusdt: q.tokensOut.toString() },
        () => removeLiquidity(ctx, w.signer, w.kasAddresses, { position: p.id, minKas: minimumFor(q.kasOut, 100), minTokens: minimumFor(q.tokensOut, 100), quoted: q, shownFeerate }));
      await addActivity(ctx.network, { kind: 'lp-remove', txid: r.txid, kas: r.kasOut.toString(), kusdt: r.tokensOut.toString(), fee: r.built.fee.toString(), ...outcomeStatus(r.confirmed) });
      // Sent is not done: "Removed" only once the node showed the withdrawal accepted.
      setNote(r.confirmed ? `Removed: ${fmtKas(r.kasOut, 4)} KAS and ${fmtUsdt(r.tokensOut, 2)} ${TOKEN_SYMBOL}.`
        : `Sent, not confirmed by the network yet: ${fmtKas(r.kasOut, 4)} KAS and ${fmtUsdt(r.tokensOut, 2)} ${TOKEN_SYMBOL} arrive once it is. Activity shows which way it went.`);
      w.refresh(); load();
    } catch (e) {
      if (e instanceof QuoteChanged && typeof e.now === 'object' && typeof e.seen === 'object') setChanged({ id: p.id, seen: e.seen, now: e.now });
      else { const text = errText(e); setErr(text); setMergeErr(isMergeCoinsFirst(e) ? text : null); }
    } finally { setBusy(null); }
  }

  const name = networkName(w.active.network);
  if (!poolReady(w.active.config)) return (
    <>
      <TopBar title="Pool" />
      <Body>
        <EmptyState icon={<PoolIcon size={20} />} title={`No pool on ${name} yet`}>
          The KAS / {TOKEN_SYMBOL} pool is not live on {name}.
        </EmptyState>
      </Body>
    </>
  );
  if (mode === 'add') return <AddLiquidity vp={vp} onBack={() => { setMode('list'); load(); }} />;
  if (mode === 'open') return <OpenPool vp={vp} onBack={() => { setMode('list'); load(); }} />;
  const s = vp?.pool.state;
  const empty = !!vp && !opened(vp);
  const paused = !!s?.paused;
  const price = s && s.tokenReserve > 0n ? formatUnits((s.kasReserve * 1_000_000n) / s.tokenReserve, 8, 4) : null;
  return (
    <>
      <TopBar title="Pool" />
      <Body>
        <Card pad="px-4 pt-3.5 pb-2">
          <div className="flex items-center gap-3">
            <PairMarks />
            <div className="flex-1 min-w-0">
              <div className="text-[14px] font-semibold text-pearl-200">KAS / {TOKEN_SYMBOL}</div>
              <div className="text-xs text-pearl-500">0.50 % per swap</div>
            </div>
            {paused && <Pill tone="warn">Paused</Pill>}
            {s && !paused && <span title="Its state was checked against the Kaspa node"><Pill tone="done"><ShieldCheckIcon size={12} />Verified</Pill></span>}
            <IconButton label="Refresh the pool" small onClick={load} disabled={loading}><RefreshIcon size={14} className={loading ? 'spin' : ''} /></IconButton>
          </div>
          <div className="mt-2.5 border-t border-ink-700 pt-1.5">
            {empty ? (
              <div className="py-1.5" data-testid="pool-empty">
                <div className="text-[13px] font-semibold text-pearl-300">No liquidity yet</div>
                <p className="text-xs text-pearl-500 mt-1 leading-relaxed pb-1">The pool was created but nobody has made its first deposit. That deposit sets the price: the KAS and {TOKEN_SYMBOL} you put in become its reserves.</p>
              </div>
            ) : s ? <>
              <Row label="KAS reserve" value={`${fmtKas(s.kasReserve, 2)} KAS`} />
              <Row label={`${TOKEN_SYMBOL} reserve`} value={`${fmtUsdt(s.tokenReserve, 2)} ${TOKEN_SYMBOL}`} />
              {price && <Row label="Price" value={`1 ${TOKEN_SYMBOL} = ${price} KAS`} />}
              <Row label="Fee" value="0.50 % per swap (0.05 % of it to the protocol)" />
            </> : !err && <div className="flex flex-col gap-2.5 py-2"><Skeleton className="h-3 w-full" /><Skeleton className="h-3 w-4/5" /><Skeleton className="h-3 w-3/5" /></div>}
          </div>
        </Card>
        {paused && <PausedNotice />}
        {empty ? <>
          {!paused && <Button size="lg" icon={<PlusIcon size={17} />} onClick={() => setMode('open')}>Open the pool</Button>}
        </> : <>
          <SectionTitle right={positions && positions.length > 0 && <span className="text-xs text-pearl-500">{positions.length}</span>}>Your positions</SectionTitle>
          {positions === null && <Card><div className="flex flex-col gap-2.5"><Skeleton className="h-3 w-2/5" /><Skeleton className="h-3 w-4/5" /></div></Card>}
          {positions?.length === 0 && (
            <div className="card px-4 py-5 text-center">
              <div className="text-[13px] font-semibold text-pearl-300">No positions yet</div>
              <div className="text-xs text-pearl-500 mt-1 leading-relaxed">Add KAS and {TOKEN_SYMBOL} at the pool's ratio to earn a share of its swap fees. Positions this wallet adds show here.</div>
            </div>
          )}
          {positions?.map(p => {
            const share = s && s.totalShares > 0n ? (p.located.state.shares * s.kasReserve) / s.totalShares : null;
            const tok = s && s.totalShares > 0n ? (p.located.state.shares * s.tokenReserve) / s.totalShares : null;
            const c = changed?.id === p.id ? changed : null;
            return (
              <Card key={p.id} pad="px-4 pt-3 pb-3.5">
                <div className="flex items-baseline justify-between gap-2">
                  <span className="text-[13.5px] font-semibold text-pearl-200">{formatUnits(p.located.state.shares, 0)} shares</span>
                  {share != null && tok != null && <span className="text-[13px] font-semibold text-pearl-200 tnum">{fmtKas(share, 4)} KAS + {fmtUsdt2(tok)} {TOKEN_SYMBOL}</span>}
                </div>
                <div className="text-xs text-pearl-500 mt-0.5">Worth now, at the pool's reserves</div>
                <div className="mt-2 border-t border-ink-700 pt-1">
                  <Row label="Kept in the position" value={`${fmtKas(p.located.utxo.amount)} KAS (returned on removal)`} />
                  <PoolFeeRow feerate={feerate} />
                </div>
                {p.unread && <p className="text-xs text-amber leading-relaxed pt-1.5" data-testid="position-unchecked">This position could not be checked on the Kaspa node: the address it sits at can't be listed right now (it holds too many coins, or the node is slow). It is shown from its record. Removing it works if it is there as recorded; if not, the node refuses and nothing is sent.</p>}
                {c && <div className="mt-2">
                  <QuoteChangedCard confirm="Remove at the new quote" busy={!!busy} onConfirm={() => remove(p, c.now)} onCancel={() => { setChanged(null); load(); }}>
                    you would now receive <b className="font-semibold tnum">{fmtKas(c.now.kasOut, 4)} KAS + {fmtUsdt2(c.now.tokensOut)} {TOKEN_SYMBOL}</b> instead of {fmtKas(c.seen.kasOut, 4)} KAS + {fmtUsdt2(c.seen.tokensOut)} {TOKEN_SYMBOL}.
                  </QuoteChangedCard>
                </div>}
                {!c && share != null && feerate != null && poolFeeShareText(poolFeeAbout(feerate), share) && <p className="text-xs text-amber leading-relaxed pt-1.5">{poolFeeShareText(poolFeeAbout(feerate), share)}</p>}
                {!c && <div className="mt-2"><Button kind="secondary" size="sm" disabled={!!busy || feerate == null} onClick={() => remove(p)}>{busy === p.id ? 'Removing…' : 'Remove (min. 99 % of the quote)'}</Button></div>}
              </Card>
            );
          })}
        </>}
        {note && <Notice>{note}</Notice>}
        {err && <PoolError err={err} merge={err === mergeErr} onMerge={() => nav.push('merge')} />}
        {!empty && <Button size="lg" icon={<PlusIcon size={17} />} disabled={!vp || paused} onClick={() => setMode('add')}>Add liquidity</Button>}
      </Body>
    </>
  );
}

function AddLiquidity({ vp, onBack }: { vp: VerifiedPool | null; onBack: () => void }) {
  const w = useWallet();
  const nav = useNav();
  const [mergeErr, setMergeErr] = useState<string | null>(null);
  const [kasText, setKasText] = useState('');
  const [tokText, setTokText] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [done, setDone] = useState<{ txid: string; confirmed: boolean } | null>(null);
  const [shares, setShares] = useState<bigint | null>(null);
  /** A worse quote to confirm; `merged`: the merges that went out before it (Daybreak [9]). */
  const [changed, setChanged] = useState<{ seen: bigint; now: bigint; merged: number } | null>(null);
  const kasIn = parseKasText(kasText), tokensIn = parseUsdtText(tokText);
  const paused = !!vp?.pool.state.paused;
  const clickedForm = useFormLock({ kasText, tokText });
  // The fee the deposit is shown with and held to (R15-CL-3).
  const feerate = usePoolFeerate(async () => (await w.ctx()).node.feerate(), w.active.network);

  useEffect(() => { if (vp && kasIn && kasIn > 0n) setTokText(plain(formatUnits(tokensForKas(vp.pool.state, kasIn), 6))); }, [kasText]);
  useEffect(() => {
    setChanged(null);
    (async () => {
      if (!vp || !kasIn || !tokensIn) { setShares(null); return; }
      const used = trimToShares(vp.pool.state, kasIn, tokensIn);
      setShares(quoteAdd(await w.ctx(), vp.pool.state, used.kasIn, used.tokensIn));
    })().catch(() => setShares(null));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [kasText, tokText, vp]);

  /** `quoted`: the shares the user saw; the 99 % floor stays from the form's quote. */
  async function go(quoted: bigint) {
    if (!vp || !kasIn || !tokensIn || !shares || busy || feerate == null) return;
    const shownFeerate = feerate;
    // What "Puts in" shows, on the pool state the shares were quoted on, is what is passed: the typed amounts, trimmed
    // again on a pool that moved since, could put in more of one side than shown (run 20, PUB20-1). The shown ones give
    // fewer shares there, which asks again (QuoteChanged); trimmed again, neither side ever grows.
    const shown = trimToShares(vp.pool.state, kasIn, tokensIn);
    // Max says it keeps FEE_KEEP for the network fee: a deposit of all the KAS it can put in may pay that, and what the
    // pool ratio leaves of the KAS besides, as the fee row shows (R17-CL-1).
    const acceptedFee = w.balances && vp ? maxKeep(kasIn, tokensIn, maxKasIn({ config: w.active.config }, 'add', w.balances.kasSpendable), vp.pool.state) : undefined;
    // The form is locked while this runs; should it have changed all the same, or been left, nothing more is signed.
    const signer = guardedSigner(w.signer, clickedForm());
    setBusy(true); setErr(null); setChanged(null);
    // The merges a deposit sends first: once one went out, "nothing was sent" is said of the deposit itself (Daybreak [9]).
    let merged = 0;
    try {
      const ctx = await w.ctx();
      const add = { kind: 'lp-add', kas: shown.kasIn.toString(), kusdt: shown.tokensIn.toString() } as const;
      const r = await followMaybeSent(ctx.network, add, () => addLiquidity(ctx, signer, w.kasAddresses, { kasIn: shown.kasIn, tokensIn: shown.tokensIn, minShares: minimumFor(shares, 100), quoted, shownFeerate, acceptedFee }, (t) => { merged++; addActivity(ctx.network, { kind: 'kusdt-merge', txid: t }).catch(() => {}); }));
      await addActivity(ctx.network, { ...add, kas: r.kasIn.toString(), kusdt: r.tokensIn.toString(), txid: r.txid, fee: r.built.fee.toString(), ...outcomeStatus(r.confirmed) });
      setDone({ txid: r.txid, confirmed: r.confirmed }); w.refresh();
    } catch (e) {
      if (e instanceof QuoteChanged && typeof e.now === 'bigint' && typeof e.seen === 'bigint') setChanged({ seen: e.seen, now: e.now, merged });
      else { const text = afterMerges(errText(e), merged, 'deposit'); setErr(text); setMergeErr(isMergeCoinsFirst(e) ? text : null); }
    } finally { setBusy(false); }
  }
  if (done) return <Done title="Add liquidity" heading={done.confirmed ? 'Liquidity added' : 'Deposit sent'} txid={done.txid}
    lines={done.confirmed ? ['Your position is in the Pool tab.'] : ['The network has not confirmed it yet. Your position shows in the Pool tab once it does.', UNCONFIRMED_NOTE]} onClose={onBack} />;
  const b = w.balances;
  const cfg = { config: w.active.config };
  const kasRoom = b ? maxKasIn(cfg, 'add', b.kasSpendable) : null;
  // Max KAS: what the wallet can put in, and no more than its whole kUSDT matches at the pool's ratio.
  const kasMax = kasRoom != null && vp ? (b?.kusdt != null && kasForTokens(vp.pool.state, b.kusdt) < kasRoom ? kasForTokens(vp.pool.state, b.kusdt) : kasRoom) : null;
  const overKas = kasIn != null && kasIn > 0n && kasRoom != null && kasIn > kasRoom;
  const overTok = tokensIn != null && tokensIn > 0n && b?.kusdt != null && tokensIn > b.kusdt;
  // What the deposit really puts in: only what the shares need, at the pool ratio.
  const used = vp && kasIn && tokensIn ? trimToShares(vp.pool.state, kasIn, tokensIn) : null;
  return (
    <>
      <Header title="Add liquidity" onBack={onBack} right={<NetworkButton network={w.active.network} />} />
      <NetworkBanner />
      <Body>
        {paused && <PausedNotice />}
        <Field label="KAS" right={b ? <BalanceMax text={`${fmtKasBalance(b.kasSpendable)} KAS`} /> : undefined}
          error={overKas ? `Keep ${fmtKas(lockedKasFor(cfg, 'add') + FEE_KEEP)} KAS for the position and the network fee.` : undefined}
          hint={`Max keeps ${fmtKas(lockedKasFor(cfg, 'add') + FEE_KEEP)} KAS: ${fmtKas(lockedKasFor(cfg, 'add'))} KAS for the position and ${fmtKas(FEE_KEEP)} KAS for the network fee.`}>
          <AmountInput label="KAS" value={kasText} onChange={setKasText} suffix="KAS" invalid={(!!kasText && kasIn == null) || overKas} disabled={busy}
            onMax={kasMax != null && kasMax > 0n && !paused ? () => setKasText(plain(fmtKas(kasMax))) : undefined} />
        </Field>
        <Field label={TOKEN_SYMBOL} right={b?.kusdt != null ? <BalanceMax text={`${fmtUsdt2(b.kusdt)} ${TOKEN_SYMBOL}`} /> : undefined}
          error={overTok ? 'That is more than you have.' : undefined} hint="Filled in at the pool's price; you can raise it.">
          <AmountInput label={TOKEN_SYMBOL} value={tokText} onChange={setTokText} suffix={TOKEN_SYMBOL} invalid={(!!tokText && tokensIn == null) || overTok} disabled={busy}
            onMax={b?.kusdt != null && b.kusdt > 0n && !paused ? () => setTokText(plain(fmtUsdt(b.kusdt!))) : undefined} />
        </Field>
        <Card pad="px-4 py-1.5">
          <Row label="Puts in" value={<span data-testid="add-used">{used && used.shares > 0n ? `${fmtKas(used.kasIn)} KAS + ${fmtUsdt(used.tokensIn)} ${TOKEN_SYMBOL}` : '-'}</span>} />
          <Row label="Shares" value={shares != null ? formatUnits(shares, 0) : '-'} strong />
          <Row label="Minimum shares" value={shares != null ? formatUnits(minimumFor(shares, 100), 0) : '-'} />
          <Row label="Kept in the position" value={`${fmtKas(BigInt(w.active.config.positionValue))} KAS`} />
          <Row label="Kept in your token (change)" value={`${fmtKas(BigInt(w.active.config.tokenValue))} KAS`} />
          <PoolFeeRow feerate={feerate} keep={kasIn && tokensIn && kasRoom != null && vp ? maxKeep(kasIn, tokensIn, kasRoom, vp.pool.state) : undefined} />
        </Card>
        {used && used.shares > 0n && feerate != null && poolFeeShareText(poolFeeAbout(feerate), used.kasIn) && <Notice tone="warn">{poolFeeShareText(poolFeeAbout(feerate), used.kasIn)}</Notice>}
        <Notice>Shares are the smaller of what your KAS and your {TOKEN_SYMBOL} buy at the pool's ratio, and only what those shares need is put in: the rest stays in your wallet. If the pool moves first, the wallet asks you before taking fewer shares, and stops below 99 % of these.</Notice>
        {changed && (
          <QuoteChangedCard confirm="Add at the new quote" busy={busy} merged={changed.merged} what="deposit" onConfirm={() => go(changed.now)} onCancel={() => setChanged(null)}>
            you would now get <b className="font-semibold tnum">{formatUnits(changed.now, 0)} shares</b> instead of {formatUnits(changed.seen, 0)}, for at most what it puts in above.
          </QuoteChangedCard>
        )}
        {err && <PoolError err={err} merge={err === mergeErr} onMerge={() => nav.push('merge')} />}
        <Button size="lg" disabled={busy || paused || !shares || shares <= 0n || overKas || overTok || !!changed || feerate == null} onClick={() => shares && go(shares)}>{busy ? 'Adding…' : 'Add'}</Button>
      </Body>
    </>
  );
}

/** The pool's first deposit: the user's KAS and kUSDT set its price (SPEC §15 `init`). */
function OpenPool({ vp, onBack }: { vp: VerifiedPool | null; onBack: () => void }) {
  const w = useWallet();
  const nav = useNav();
  const [mergeErr, setMergeErr] = useState<string | null>(null);
  const [kasText, setKasText] = useState('');
  const [tokText, setTokText] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [step, setStep] = useState<string | null>(null);
  const [done, setDone] = useState<{ txid: string; shares: bigint; confirmed: boolean } | null>(null);
  const kasIn = parseKasText(kasText), tokensIn = parseUsdtText(tokText);
  const paused = !!vp?.pool.state.paused;
  // The first deposit takes the pool admin's signature: only a wallet holding the admin's key can open it.
  const notAdmin = !!vp && vp.pool.state.admin !== w.signer.ownerHex;
  const b = w.balances;
  const cfg = { config: w.active.config };
  const clickedForm = useFormLock({ kasText, tokText });
  // The network fee shown, and what the opening and the merges it needs first are held to (Daybreak [9]).
  const feerate = usePoolFeerate(async () => (await w.ctx()).node.feerate(), w.active.network);

  async function go() {
    if (!kasIn || !tokensIn || busy || feerate == null) return;
    const shownFeerate = feerate;
    // Max says it keeps FEE_KEEP for the network fee: an opening of it may pay that, change the network does not keep included (R17-CL-1).
    const acceptedFee = b && kasIn === maxKasIn(cfg, 'open', b.kasSpendable) ? FEE_KEEP : undefined;
    // The form is locked while this runs; should it have changed all the same, or been left, nothing more is signed.
    const signer = guardedSigner(w.signer, clickedForm());
    setBusy(true); setErr(null);
    // The merges an opening sends first: once one went out, "nothing was sent" is said of the opening (Daybreak [9]).
    let merged = 0;
    try {
      const ctx = await w.ctx();
      const open = { kind: 'lp-open', kas: kasIn.toString(), kusdt: tokensIn.toString() } as const;
      const r = await followMaybeSent(ctx.network, open, () => openPool(ctx, signer, w.kasAddresses, { kasIn, tokensIn, shownFeerate, acceptedFee }, (t) => {
        merged++;
        setStep('Merged your tokens first; opening the pool…');
        addActivity(ctx.network, { kind: 'kusdt-merge', txid: t }).catch(() => {});
      }));
      await addActivity(ctx.network, { ...open, txid: r.txid, fee: r.built.fee.toString(), ...outcomeStatus(r.confirmed) });
      setDone({ txid: r.txid, shares: r.shares, confirmed: r.confirmed }); w.refresh();
    } catch (e) {
      const text = afterMerges(e instanceof PoolPaused ? e.message : errText(e), merged, 'opening');
      setErr(text); setMergeErr(isMergeCoinsFirst(e) ? text : null);
    } finally { setBusy(false); setStep(null); }
  }
  if (done) return <Done title="Open the pool" heading={done.confirmed ? 'Pool opened' : 'Opening sent'} txid={done.txid}
    lines={done.confirmed ? [`Your position has ${formatUnits(done.shares, 0)} shares; it is in the Pool tab.`]
      : [`The network has not confirmed it yet. Your position will have ${formatUnits(done.shares, 0)} shares; it shows in the Pool tab once it does.`, UNCONFIRMED_NOTE]} onClose={onBack} />;

  const kasRoom = b ? maxKasIn(cfg, 'open', b.kasSpendable) : null;
  const overKas = kasIn != null && kasIn > 0n && kasRoom != null && kasIn > kasRoom;
  const overTok = tokensIn != null && tokensIn > 0n && b?.kusdt != null && tokensIn > b.kusdt;
  const tooSmall = kasIn != null && kasIn > 0n && kasIn <= LOCKED_SHARES;
  const terms = kasIn && kasIn > LOCKED_SHARES && tokensIn && tokensIn > 0n ? openTerms(cfg, { kasIn, tokensIn }) : null;
  // The first price, both ways, exactly as the reserves will hold it.
  const kasPerToken = kasIn && tokensIn && tokensIn > 0n ? formatUnits((kasIn * 1_000_000n) / tokensIn, 8, 6) : null;
  const tokenPerKas = kasIn && tokensIn && kasIn > 0n ? formatUnits((tokensIn * 100_000_000n) / kasIn, 6, 6) : null;
  // What the 1000 locked shares hold, at the first deposit's reserves.
  const lockedKas = LOCKED_SHARES, lockedTok = kasIn && tokensIn && kasIn > 0n ? (tokensIn * LOCKED_SHARES) / kasIn : 0n;
  const kept = lockedKasFor(cfg, 'open') + FEE_KEEP;
  return (
    <>
      <Header title="Open the pool" onBack={onBack} right={<NetworkButton network={w.active.network} />} />
      <NetworkBanner />
      <Body>
        {paused && <PausedNotice />}
        <Notice>The pool has no liquidity yet. Its admin's deposit opens it, and the amounts put in set its first price.</Notice>
        {notAdmin && <Notice tone="warn">{ONLY_THE_ADMIN}</Notice>}
        <Field label="KAS" right={b ? <BalanceMax text={`${fmtKasBalance(b.kasSpendable)} KAS`} /> : undefined}
          error={overKas ? `Keep ${fmtKas(kept)} KAS for the new states and the network fee.` : tooSmall ? `Put in more than ${LOCKED_SHARES} sompi.` : undefined}
          hint={`Max keeps ${fmtKas(kept)} KAS: ${fmtKas(BigInt(w.active.config.positionValue))} KAS for your position, ${fmtKas(BigInt(w.active.config.tokenValue))} KAS for the pool's reserve token and ${fmtKas(FEE_KEEP)} KAS for the network fee.`}>
          <AmountInput label="KAS" value={kasText} onChange={setKasText} suffix="KAS" invalid={(!!kasText && kasIn == null) || overKas || tooSmall} disabled={busy}
            onMax={kasRoom != null && kasRoom > 0n && !paused ? () => setKasText(plain(fmtKas(kasRoom))) : undefined} />
        </Field>
        <Field label={TOKEN_SYMBOL} right={b?.kusdt != null ? <BalanceMax text={`${fmtUsdt2(b.kusdt)} ${TOKEN_SYMBOL}`} /> : undefined}
          error={overTok ? 'That is more than you have.' : undefined}>
          <AmountInput label={TOKEN_SYMBOL} value={tokText} onChange={setTokText} suffix={TOKEN_SYMBOL} invalid={(!!tokText && tokensIn == null) || overTok} disabled={busy}
            onMax={b?.kusdt != null && b.kusdt > 0n && !paused ? () => setTokText(plain(fmtUsdt(b.kusdt!))) : undefined} />
        </Field>
        <Card pad="px-4 py-1.5">
          <Row label="First price" value={<span data-testid="open-price">{kasPerToken ? <>1 {TOKEN_SYMBOL} = {kasPerToken} KAS<span className="block text-xs text-pearl-500 mt-0.5">1 KAS = {tokenPerKas} {TOKEN_SYMBOL}</span></> : '—'}</span>} strong />
          <Row label="Your position" value={terms ? `${formatUnits(terms.shares, 0)} shares` : '—'} />
          <Row label="Locked in the pool forever" value={<>{formatUnits(LOCKED_SHARES, 0)} shares<span className="block text-xs text-pearl-500 mt-0.5">{terms ? (lockedTok > 0n ? `${fmtKas(lockedKas)} KAS + ${fmtUsdt(lockedTok)} ${TOKEN_SYMBOL} now` : `${fmtKas(lockedKas)} KAS of it now`) : 'of the first deposit'}</span></>} />
          <Row label="Kept in the position" value={`${fmtKas(BigInt(w.active.config.positionValue))} KAS`} />
          <Row label="Kept in the pool's reserve token" value={`${fmtKas(BigInt(w.active.config.tokenValue))} KAS`} />
          <Row label="Kept in your token (change)" value={`${fmtKas(BigInt(w.active.config.tokenValue))} KAS`} />
          <PoolFeeRow feerate={feerate} keep={kasIn != null && kasRoom != null && kasIn === kasRoom ? FEE_KEEP : undefined} />
        </Card>
        <Notice tone="warn">Set the price you believe is right: if it is off the market, traders buy from or sell to the pool at your price, at your position's cost, until it is back in line. The covenant keeps the first {formatUnits(LOCKED_SHARES, 0)} shares unowned forever, so the pool can never be emptied.</Notice>
        {step && <Notice>{step}</Notice>}
        {err && <PoolError err={err} merge={err === mergeErr} onMerge={() => nav.push('merge')} />}
        <Button size="lg" disabled={busy || paused || notAdmin || !terms || overKas || overTok || feerate == null} onClick={go}>{busy ? 'Opening…' : 'Open the pool'}</Button>
      </Body>
    </>
  );
}
