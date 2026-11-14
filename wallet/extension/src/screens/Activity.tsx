// Activity: KAS, kUSDT, swaps, liquidity, redemptions and deposits, with the
// release and mint status read from the coordinator. Home shows the latest
// three with the same rows.

import { useCallback, useEffect, useState, type ComponentType } from 'react';
import { TOKEN_SYMBOL } from '@/brand';
import { KASPA_NETWORKS, explorerTxUrl } from '@kusdt/kaspa';
import { fmtKas, fmtUsdt, shortHash } from '@/lib/format';
import { networkName } from '@/config/networks';
import { useWallet } from '@/popup/state';
import { TopBar } from '@/popup/nav';
import { LOST, MAYBE_SENT, UNCONFIRMED, listActivity, updateActivity, type Activity } from '@/activity/history';
import { redeemStatus } from '@/kusdt/redeem';
import { Body, EmptyState, IconButton, Pill, SectionTitle, Skeleton, shortAddress, shortEvm, type PillTone } from '@/ui/kit';
import {
  ActivityIcon, BridgeIcon, ExternalIcon, MergeIcon, MinusIcon, PlusIcon, ReceiveIcon, RefreshIcon, SendIcon, SwapIcon, type IconProps,
} from '@/ui/icons';

const TITLES: Record<Activity['kind'], string> = {
  'kas-send': 'Sent KAS', 'kas-receive': 'Received KAS', 'kusdt-send': `Sent ${TOKEN_SYMBOL}`, 'kusdt-receive': `Received ${TOKEN_SYMBOL}`,
  'kusdt-merge': `Merged ${TOKEN_SYMBOL} tokens`, 'swap-buy': `Bought ${TOKEN_SYMBOL}`, 'swap-sell': `Sold ${TOKEN_SYMBOL}`,
  'lp-add': 'Added liquidity', 'lp-open': 'Opened the pool', 'lp-remove': 'Removed liquidity', redeem: `Redeemed ${TOKEN_SYMBOL}`, deposit: 'Bridged USDT in',
};
const ICONS: Record<Activity['kind'], ComponentType<IconProps>> = {
  'kas-send': SendIcon, 'kusdt-send': SendIcon, 'kas-receive': ReceiveIcon, 'kusdt-receive': ReceiveIcon, 'kusdt-merge': MergeIcon,
  'swap-buy': SwapIcon, 'swap-sell': SwapIcon, 'lp-add': PlusIcon, 'lp-open': PlusIcon, 'lp-remove': MinusIcon, redeem: BridgeIcon, deposit: BridgeIcon,
};
const FINAL = new Set(['released', 'invalid', 'unpayable', 'minted', 'refunded']);
const REFUNDS = new Set(['skipped', 'blocked', 'queued', 'refunded']);

/** What a status means, where it needs saying. SPEC §9: a payout to an address the token blocks is held, and made once it doesn't. */
function statusNote(a: Activity, chain: string): { text: string; held: boolean } | null {
  if (a.status === MAYBE_SENT) return { held: true, text: 'The Kaspa node did not answer when this was sent, so it may or may not be on the network. Check the transaction before trying again.' };
  if (a.status === UNCONFIRMED) return { held: false, text: 'Sent, and not confirmed by the network yet. What it spends stays set aside until the wallet sees whether it went through.' };
  if (a.status === LOST) return { held: true, text: 'This did not go through: another transaction reached the pool first. Nothing left your wallet, and nothing arrived.' };
  if (a.kind === 'redeem' && a.status === 'blocked') return { held: true, text: `Held: USDT on ${chain} blocks this address, so the vault pays nothing to it. It is paid automatically if the address is unblocked.` };
  if (a.kind === 'redeem' && a.status === 'queued') return { held: false, text: 'This payout waits in the vault for a few minutes, so a stolen key can be stopped before anything leaves.' };
  if (a.kind !== 'deposit' || a.status === 'refunded') return null;
  if (a.refund === 'queued') return { held: false, text: 'Kaspa skipped this deposit. Its refund waits in the vault for a few minutes, so a stolen key can be stopped before anything leaves.' };
  if (a.refund === 'blocked') return { held: true, text: `Kaspa skipped this deposit, and its refund is held: USDT on ${chain} blocks your EVM address. It is refunded automatically if the address is unblocked.` };
  if (a.refund === 'skipped') return { held: false, text: 'Kaspa skipped this deposit: the vault refunds it to your EVM address.' };
  return null;
}

// What the coordinator's statuses mean to people (SPEC §13), per kind.
const DEPOSIT_STATUS: Record<string, [string, PillTone]> = {
  pending: ['Pending', 'outline'], final: ['Confirmed', 'outline'], minting: ['Minting', 'outline'], minted: ['Minted', 'done'], refunded: ['Refunded', 'done'],
};
const REDEEM_STATUS: Record<string, [string, PillTone]> = {
  unreported: ['Sent', 'outline'], seen: ['Pending', 'outline'], final: ['Confirmed', 'outline'], signing: ['Signing', 'outline'], queued: ['Safety wait', 'outline'], released: ['Paid', 'done'],
  blocked: ['Held', 'warn'], invalid: ['Invalid', 'error'], unpayable: ['Not payable', 'error'], unknown: ['Unknown', 'neutral'], [MAYBE_SENT]: ['May have been sent', 'warn'],
  [UNCONFIRMED]: ['Not confirmed yet', 'outline'], [LOST]: ['Did not go through', 'warn'],
};

/** The status pill of a deposit or a redemption (what the coordinator last said). */
function statusPill(a: Activity): [string, PillTone] | null {
  if (a.kind === 'deposit' && a.refund && a.status !== 'refunded') {
    return a.refund === 'blocked' ? ['Refund held', 'warn'] : a.refund === 'refunded' ? ['Refunded', 'done'] : ['Refund pending', 'outline'];
  }
  if (!a.status) return null;
  return (a.kind === 'deposit' ? DEPOSIT_STATUS : REDEEM_STATUS)[a.status] ?? [a.status.charAt(0).toUpperCase() + a.status.slice(1), 'neutral'];
}

/** The amounts of a row: what changed in the wallet, signed (− out, + in). */
function amountsOf(a: Activity): [string | null, string | null] {
  const k = a.kusdt ? `${fmtUsdt(BigInt(a.kusdt), 2)} ${TOKEN_SYMBOL}` : null;
  const s = a.kas ? `${fmtKas(BigInt(a.kas), 4)} KAS` : null;
  const out = (v: string | null) => (v ? `−${v}` : null), inn = (v: string | null) => (v ? `+${v}` : null);
  switch (a.kind) {
    case 'kas-send': return [out(s), null];
    case 'kas-receive': return [inn(s), null];
    case 'kusdt-send': case 'redeem': return [out(k), null];
    case 'kusdt-receive': case 'deposit': return [inn(k), null];
    case 'swap-buy': return [inn(k), out(s)];
    case 'swap-sell': return [inn(s), out(k)];
    case 'lp-add': case 'lp-open': return [out(s), out(k)];
    case 'lp-remove': return [inn(s), inn(k)];
    default: return [null, null];
  }
}

/** "11:07 AM" today, "Nov 3" before. */
const when = (at: number) => {
  const d = new Date(at);
  return d.toDateString() === new Date().toDateString()
    ? d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
    : d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', ...(d.getFullYear() === new Date().getFullYear() ? {} : { year: 'numeric' }) });
};

/** The wallet's activity on its network, followed: open deposits and redemptions are asked about every 20 s. */
export function useActivity() {
  const w = useWallet();
  const [list, setList] = useState<Activity[] | null>(null);
  const load = useCallback(async () => setList(await listActivity(w.active.network)), [w.active.network]);

  const follow = useCallback(async () => {
    const all = await listActivity(w.active.network);
    const open = all.filter(a => (a.kind === 'redeem' || a.kind === 'deposit') && !FINAL.has(a.status ?? ''));
    if (!open.length) return;
    try {
      const ctx = await w.ctx();
      for (const a of open) {
        try {
          if (a.kind === 'redeem') {
            const s = await redeemStatus(ctx, a.txid, a.outputIndex ?? 0);
            await updateActivity(ctx.network, a.id, { status: s.status, doneTx: s.evmTxHash });
          } else if (a.chain && a.nonce && ctx.api) {
            const d = await ctx.api.deposit(a.chain, BigInt(a.nonce));
            if (typeof d?.status === 'string') await updateActivity(ctx.network, a.id, {
              status: d.status, doneTx: typeof d.kaspaTxid === 'string' ? d.kaspaTxid : undefined,
              refund: REFUNDS.has(d.refund?.status) ? d.refund.status : undefined,
            });
          }
        } catch { /* not known yet */ }
      }
    } catch { /* no coordinator */ }
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [w.active.network]);

  useEffect(() => { load(); follow(); const t = setInterval(follow, 20_000); return () => clearInterval(t); }, [load, follow]);
  return { list, follow, load };
}

export function ActivityRow({ a, full = false }: { a: Activity; full?: boolean }) {
  const w = useWallet();
  const chainName = a.chain ? w.active.config.chains[a.chain].name : '?';
  const note = statusNote(a, chainName);
  const pill = statusPill(a);
  const [primary, secondary] = amountsOf(a);
  const Icon = ICONS[a.kind];
  const net = KASPA_NETWORKS[w.active.network];
  const url = a.kind === 'deposit' && a.chain ? w.active.config.chains[a.chain].explorerTx.replace('{tx}', a.txid) : net.explorerTx ? explorerTxUrl(net, a.txid) : '';
  const context = a.kind === 'redeem' ? `to ${chainName}`
    : a.kind === 'deposit' ? `from ${chainName}`
    : a.counterparty ? `to ${shortAddress(a.counterparty, 6, 4).replace(/^[a-z]+:/, '')}`
    : a.kind.startsWith('swap') || a.kind.startsWith('lp') ? 'on the pool' : null;
  // Full rows (Activity) say more: the deposit number, the payout address, both transactions.
  const detail = a.kind === 'deposit' ? `Deposit #${a.nonce}` : a.kind === 'redeem' && a.address ? `Paid to ${shortEvm(a.address)}` : null;
  return (
    <div className="flex gap-3 px-3.5 py-3">
      <span className="icon-badge w-9 h-9 mt-0.5"><Icon size={16} /></span>
      <div className="flex-1 min-w-0">
        <div className="flex items-baseline justify-between gap-2">
          <span className="text-[13.5px] font-semibold text-pearl-200 truncate">{TITLES[a.kind]}</span>
          {primary && <span className="text-[13.5px] font-semibold text-pearl-200 tnum shrink-0">{primary}</span>}
        </div>
        <div className="flex items-center justify-between gap-2 mt-0.5 min-h-[20px]">
          <span className="text-xs text-pearl-500 truncate">{[when(a.at), context].filter(Boolean).join(' · ')}</span>
          {secondary ? <span className="text-xs text-pearl-500 tnum shrink-0">{secondary}</span> : pill && <Pill tone={pill[1]}>{pill[0]}</Pill>}
        </div>
        {secondary && pill && <div className="mt-1"><Pill tone={pill[1]}>{pill[0]}</Pill></div>}
        {full && note && <p className={`text-xs mt-1.5 leading-relaxed ${note.held ? 'text-amber-ink' : 'text-pearl-500'}`}>{note.text}</p>}
        {full && (
          <div className="flex items-center gap-x-3 gap-y-0.5 flex-wrap mt-1.5 text-xs text-pearl-500">
            {detail && <span className="whitespace-nowrap">{detail}</span>}
            <span className="mono whitespace-nowrap">
              {url ? <a href={url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 hover:text-pearl-200 underline-offset-2 hover:underline">{shortHash(a.txid)}<ExternalIcon size={11} /></a> : shortHash(a.txid)}
            </span>
            {a.doneTx && <span className="mono whitespace-nowrap" title={a.kind === 'deposit' ? 'The Kaspa mint' : 'The payout'}>→ {shortHash(a.doneTx)}</span>}
          </div>
        )}
      </div>
    </div>
  );
}

function ActivitySkeleton({ rows = 3 }: { rows?: number }) {
  return (
    <div className="list">
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="flex gap-3 px-3.5 py-3 items-center">
          <Skeleton className="w-9 h-9 rounded-full" />
          <div className="flex-1 flex flex-col gap-2"><Skeleton className="h-3 w-2/5" /><Skeleton className="h-2.5 w-3/5" /></div>
        </div>
      ))}
    </div>
  );
}

/** Home's "Recent activity": the latest three. */
export function RecentActivity({ onAll }: { onAll: () => void }) {
  const w = useWallet();
  const { list } = useActivity();
  return (
    <>
      <SectionTitle right={list && list.length > 0 && <button type="button" className="text-xs font-medium text-pearl-500 hover:text-pearl-200" onClick={onAll}>See all</button>}>Recent activity</SectionTitle>
      {list === null ? <ActivitySkeleton rows={2} />
        : list.length === 0 ? <div className="card px-4 py-5 text-center text-[13px] text-pearl-500">No activity on {networkName(w.active.network)} yet.</div>
        : <div className="list">{list.slice(0, 3).map(a => <ActivityRow key={a.id} a={a} />)}</div>}
    </>
  );
}

export function ActivityTab() {
  const w = useWallet();
  const { list, follow } = useActivity();
  const [busy, setBusy] = useState(false);
  const again = async () => { setBusy(true); try { await follow(); } finally { setBusy(false); } };
  return (
    <>
      <TopBar title="Activity" />
      <Body>
        <SectionTitle right={<IconButton label="Refresh" small onClick={again} disabled={busy}><RefreshIcon size={14} className={busy ? 'spin' : ''} /></IconButton>}>
          {list?.length ? `${list.length} on ${networkName(w.active.network)}` : `On ${networkName(w.active.network)}`}
        </SectionTitle>
        {list === null && <ActivitySkeleton />}
        {list?.length === 0 && (
          <EmptyState icon={<ActivityIcon size={20} />} title="No activity yet">
            What you send, receive, swap and bridge on {networkName(w.active.network)} shows up here, with the status of every bridge transfer.
          </EmptyState>
        )}
        {!!list?.length && <div className="list">{list.map(a => <ActivityRow key={a.id} a={a} full />)}</div>}
      </Body>
    </>
  );
}
