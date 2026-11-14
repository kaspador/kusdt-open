// The wallet: the account, its balances, Send and Receive, and the latest
// activity. Receive is here too.

import { useEffect, useState, type ReactNode } from 'react';
import { BRAND, TOKEN_SYMBOL } from '@/brand';
import { fmtKas, fmtKasBalance, fmtUsdt, fmtUsdt2 } from '@/lib/format';
import { sweepEmptyStates } from '@/kusdt/tokens';
import { errText } from '@/ui/kit';
import { kusdtReady } from '@/config/settings';
import { NETWORKS, evmChainsText, networkName } from '@/config/networks';
import { useWallet } from '@/popup/state';
import { NetworkBanner, NetworkButton, TopBar, useNav } from '@/popup/nav';
import { RecentActivity } from './Activity';
import { AddressChip, Body, Button, Card, CopyButton, Header, IconButton, Notice, Qr, Skeleton } from '@/ui/kit';
import { ReceiveIcon, RefreshIcon, SendIcon, TokenMark, type TokenKind } from '@/ui/icons';

function AssetRow({ kind, name, sub, value, extra }: { kind: TokenKind; name: string; sub: string; value: ReactNode; extra?: ReactNode }) {
  return (
    <div className="flex items-center gap-3 py-2.5">
      <TokenMark kind={kind} />
      <div className="flex-1 min-w-0">
        <div className="text-[14px] font-semibold text-pearl-200 leading-tight">{name}</div>
        <div className="text-xs text-pearl-500 mt-0.5">{sub}</div>
      </div>
      <div className="text-right min-w-0">
        <div className="text-[18px] font-semibold text-pearl-200 tnum leading-tight" data-balance={kind}>{value}</div>
        {extra && <div className="text-xs text-pearl-500 tnum mt-0.5">{extra}</div>}
      </div>
    </div>
  );
}

/** Local only: the local stack restarted, so its deployment is new; one tap pins it. */
export function LocalStackNotice() {
  const w = useWallet();
  if (!w.localUpdate || w.active.network !== 'simnet') return null;
  const fresh = !w.active.config.covenantId;
  return (
    <Notice action={<Button size="sm" full={false} onClick={() => w.takeLocalUpdate()}>Use its {fresh ? '' : 'new '}deployment</Button>}>
      {fresh ? 'A local stack is running on this computer.' : 'The local stack restarted with a new deployment.'}
    </Notice>
  );
}

export function Home() {
  const w = useWallet();
  const nav = useNav();
  const b = w.balances;
  const ready = kusdtReady(w.active.config);
  const name = networkName(w.active.network);
  // Fresh balances when coming back here (after a swap, a deposit…), and every 20 s while open.
  const { refresh, refreshedAt } = w;
  useEffect(() => {
    if (refreshedAt && Date.now() - refreshedAt > 5_000) refresh();
    const t = setInterval(() => refresh(), 20_000);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refresh]);
  return (
    <>
      <TopBar title={BRAND} brand />
      <Body>
        <LocalStackNotice />
        <div className="hero-card px-4 pt-3.5 pb-1.5">
          <div className="flex items-center justify-between gap-2">
            <AddressChip address={w.keys.main.address} />
            <IconButton label="Refresh balances" small onClick={() => w.refresh()} disabled={w.refreshing}>
              <RefreshIcon size={14} className={w.refreshing ? 'spin' : ''} />
            </IconButton>
          </div>
          <div className="mt-1.5">
            <AssetRow kind="kusdt" name={TOKEN_SYMBOL} sub="on Kaspa"
              value={b?.kusdt != null ? fmtUsdt2(b.kusdt) : b ? <span className="text-pearl-600">—</span> : <Skeleton className="h-5 w-16 ml-auto" />} />
            <div className="h-px bg-ink-700" />
            <AssetRow kind="kas" name="KAS" sub="Kaspa"
              value={b ? fmtKasBalance(b.kas) : <Skeleton className="h-5 w-20 ml-auto" />}
              extra={b && b.kasSpendable !== b.kas ? `${fmtKasBalance(b.kasSpendable)} spendable now` : undefined} />
          </div>
        </div>
        <div className="grid grid-cols-2 gap-2">
          <Button size="lg" icon={<SendIcon size={17} />} onClick={() => nav.push('send')}>Send</Button>
          <Button size="lg" kind="secondary" icon={<ReceiveIcon size={17} />} onClick={() => nav.push('receive')}>Receive</Button>
        </div>
        {w.balanceError && <Notice tone="error">{w.balanceError}</Notice>}
        {b?.kusdtError && (ready ? <Notice>{b.kusdtError}</Notice>
          : w.active.network === 'simnet' ? !w.localUpdate && <Notice>{TOKEN_SYMBOL} has no deployment on {name} yet. Start the local stack (bridge/devnet: npm run local:stack), then open the wallet again.</Notice>
          : <Notice action={<Button size="sm" kind="secondary" full={false} onClick={() => nav.push('network')}>Choose a network</Button>}>{TOKEN_SYMBOL} is not live on {name} yet. KAS works as usual.</Notice>)}
        {b && b.rejected > 0 && <Notice tone="warn">{b.rejected} token state{b.rejected === 1 ? '' : 's'} listed by the coordinator failed verification against the Kaspa node and {b.rejected === 1 ? 'is' : 'are'} not counted.</Notice>}
        {b && (b.unchecked ?? 0) > 0 && <Unchecked count={b.unchecked!} kusdt={b.uncheckedKusdt ?? 0n} onSend={() => nav.push('send')} />}
        {b?.kusdtFromMemory && <Notice>The bridge server did not answer for this wallet, so the {TOKEN_SYMBOL} above is what this wallet already knew of, found on the Kaspa node again. {TOKEN_SYMBOL} received since then shows once the bridge server answers.</Notice>}
        {b && b.emptyStates > 0 && <EmptyStates count={b.emptyStates} kas={b.emptyKas} />}
        <RecentActivity onAll={() => nav.setTab('activity')} />
      </Body>
    </>
  );
}

/**
 * kUSDT the node could neither show nor deny, because it could not list the address it sits at (round 12, R12-WW-1):
 * said apart from the balance, with what the user can do. `kusdt` is what the records of it say (0 with none).
 */
function Unchecked({ count, kusdt, onSend }: { count: number; kusdt: bigint; onSend: () => void }) {
  const one = count === 1;
  return (
    <Notice tone="warn" action={kusdt > 0n ? <Button size="sm" kind="secondary" full={false} onClick={onSend}>Send</Button> : undefined}>
      {count} {TOKEN_SYMBOL} coin{one ? '' : 's'}{kusdt > 0n ? ` holding ${fmtUsdt(kusdt)} ${TOKEN_SYMBOL} by this wallet's record` : ''} could not be checked on the Kaspa node: the address {one ? 'it sits' : 'they sit'} at can't be listed right now (it holds too many coins, or the node is slow). {one ? 'It is' : 'They are'} not in the balance above.
      {kusdt > 0n ? ` You can still move ${one ? 'it' : 'them'}: in Send, tick the box to use ${one ? 'it' : 'them'}. The node then decides, and nothing is sent unless the ${TOKEN_SYMBOL} is there.` : ''}
    </Notice>
  );
}

/** Empty kUSDT states (a deposit's change when it used a whole state) still hold KAS: one tap frees it. */
function EmptyStates({ count, kas }: { count: number; kas: bigint }) {
  const w = useWallet();
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  async function sweep() {
    setBusy(true); setNote(null);
    try {
      const r = await sweepEmptyStates(await w.ctx(), w.signer, w.kasAddresses);
      setNote(`Freed about ${fmtKas(r.freed)} KAS.`);
      w.refresh();
    } catch (e) { setNote(errText(e)); } finally { setBusy(false); }
  }
  return (
    <Notice action={<Button size="sm" kind="secondary" full={false} disabled={busy} onClick={sweep}>{busy ? 'Freeing…' : 'Free it'}</Button>}>
      {count} empty {TOKEN_SYMBOL} state{count === 1 ? '' : 's'} (left by a deposit that used a whole state) hold{count === 1 ? 's' : ''} {fmtKas(kas)} KAS.{note ? ` ${note}` : ''}
    </Notice>
  );
}

/** The full address, the start and the end set off, for checking it by eye. */
function AddressText({ address }: { address: string }) {
  const i = address.indexOf(':');
  const prefix = address.slice(0, i + 1), body = address.slice(i + 1);
  return (
    <div className="mono text-[12.5px] leading-relaxed break-all text-pearl-500 max-w-[300px]">
      {prefix}<span className="text-pearl-200 font-semibold">{body.slice(0, 6)}</span>{body.slice(6, -6)}<span className="text-pearl-200 font-semibold">{body.slice(-6)}</span>
    </div>
  );
}

export function Receive({ onBack }: { onBack: () => void }) {
  const w = useWallet();
  const a = w.keys.main.address;
  const name = networkName(w.active.network);
  return (
    <>
      <Header title="Receive" onBack={onBack} right={<NetworkButton network={w.active.network} />} />
      <NetworkBanner />
      <Body>
        <Card className="flex flex-col items-center gap-2.5 text-center" pad="px-4 pt-3.5 pb-4">
          <div className="text-xs font-medium text-pearl-500">Your Kaspa address on {name}</div>
          <Qr value={a} size={132} />
          <AddressText address={a} />
          <CopyButton text={a} label="Copy address" />
        </Card>
        <Notice>It receives KAS and {TOKEN_SYMBOL} on {NETWORKS[w.active.network].kaspa}. Senders of {TOKEN_SYMBOL} need a wallet that supports KCC-20 tokens.</Notice>
        <Card pad="px-4 py-3" className="flex items-center justify-between gap-3">
          <div className="min-w-0">
            <div className="text-[13px] font-semibold text-pearl-200">Your EVM account</div>
            <div className="text-xs text-pearl-500 mt-0.5 truncate" title={`To bridge USDT in from ${evmChainsText(w.active.config)}`}>To bridge USDT in</div>
          </div>
          <AddressChip address={w.keys.evmAddress} head={6} tail={4} />
        </Card>
      </Body>
    </>
  );
}
