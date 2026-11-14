// Sending KAS or kUSDT. Every send is reviewed before anything is signed;
// for kUSDT the review is of the transaction the core has already built.

import { useEffect, useState, type ReactNode } from 'react';
import { TOKEN_SYMBOL } from '@/brand';
import { KASPA_NETWORKS, hexToBytes } from '@kusdt/kaspa';
import { fmtKas, fmtKasBalance, fmtUsdt, fmtUsdt2, parseKasText, parseUsdtText, plain, shortHash } from '@/lib/format';
import { kusdtReady } from '@/config/settings';
import { NETWORKS, networkName } from '@/config/networks';
import { useWallet } from '@/popup/state';
import { NetworkBanner, NetworkButton } from '@/popup/nav';
import { checkedAgainstMainnet, planKasSend, sendKas, type KasSendPlan } from '@/kaspa/kas';
import { mainnetLookFor } from '@/wallet/context';
import { PartNeedsKas, planSend, executeSend, type SendPlan } from '@/kusdt/tokens';
import { ownerOfAddress, ownerWarningOf } from '@/kusdt/owner';
import { addActivity, afterMerges, followMaybeSent } from '@/activity/history';
import { AmountInput, Body, Button, Card, Checkbox, CopyButton, Field, Header, Notice, Row, TextArea, errText } from '@/ui/kit';
import { CheckIcon, ExternalIcon, TokenMark, type TokenKind } from '@/ui/icons';

/** The end of a flow: what was sent, its transaction, Done. */
export function Done({ title, heading = 'Sent', txid, lines, href, onClose }: { title: string; heading?: string; txid: string; lines?: string[]; href?: string; onClose: () => void }) {
  return (
    <>
      <Header title={title} />
      <Body className="justify-center">
        <div className="flex flex-col items-center text-center gap-3 px-2">
          <span className="icon-badge icon-badge-solid w-14 h-14"><CheckIcon size={26} /></span>
          <div className="text-lg font-semibold text-pearl-200">{heading}</div>
          {lines?.map((l, i) => <p key={i} className="text-[13px] text-pearl-500 leading-relaxed max-w-[310px]">{l}</p>)}
          <div className="flex items-center gap-2 mt-1">
            <span className="chip" title={txid}><span>{shortHash(txid)}</span><CopyButton text={txid} /></span>
            {href && <a href={href} target="_blank" rel="noreferrer" className="btn btn-quiet btn-sm">Explorer<ExternalIcon size={13} /></a>}
          </div>
        </div>
        <div className="mt-6"><Button size="lg" onClick={onClose}>Done</Button></div>
      </Body>
    </>
  );
}

/** Under a pool action that was sent and not seen confirmed while the wallet waited. */
export const UNCONFIRMED_NOTE = 'Activity shows it as not confirmed until then. If another transaction reaches the pool first, nothing leaves your wallet, and Activity says so.';

/** What the wallet shows about the KAS that travels inside token states. */
export function KeptInToken({ tokenValue, kept, feeFromIt }: { tokenValue: bigint; kept: bigint; /** The network fee was taken out of it (the wallet holds no other KAS). */ feeFromIt?: boolean }) {
  return (
    <>
      <Row label="KAS with the recipient's tokens" value={`${fmtKas(tokenValue, feeFromIt ? 4 : undefined)} KAS`} />
      {feeFromIt && <p className="text-xs text-amber leading-relaxed pb-1.5" data-testid="fee-from-token-kas">This wallet holds no other KAS, so the network fee is taken out of the KAS that goes with the tokens. The recipient can still send or redeem all of them; to send a part they need a little KAS of their own.</p>}
      {kept > 0n && <Row label="Kept in your token" value={`${fmtKas(kept)} KAS`} />}
      <p className="text-xs text-pearl-500 leading-relaxed pt-1 pb-1.5">Every token on Kaspa sits in its own coin, which holds some KAS for the network's storage rules. Your change stays in your token; the KAS that goes with the recipient's tokens is theirs.</p>
    </>
  );
}

/** The big "you send" line of a review. */
export function ReviewAmount({ label, kind, amount, symbol, children }: { label: string; kind: TokenKind; amount: string; symbol: string; children?: ReactNode }) {
  return (
    <div>
      <div className="text-xs font-medium text-pearl-500">{label}</div>
      <div className="flex items-center gap-3 mt-2">
        <TokenMark kind={kind} size={32} />
        <div className="text-[24px] font-semibold tnum text-pearl-200 leading-none">{amount} <span className="text-[15px] font-semibold text-pearl-500">{symbol}</span></div>
      </div>
      {children}
    </div>
  );
}

type Asset = 'kas' | 'kusdt';

/** What the Send screen says when it opens to merge the wallet's KAS (a pool transaction found it in too many coins). */
export const MERGE_NOTE = 'This sends all of your KAS to your own address, so it comes back as one coin, less the network fee. A pool transaction takes at most a few coins: once this one is in, go back and try again.';

/**
 * `merge`: opened from a pool transaction that found the wallet's KAS in more coins than it takes (MergeCoinsFirst):
 * the form starts as a plain send of all of it (Max) to the wallet's own address. Nothing is signed before the
 * review, as for any send.
 */
export function Send({ onBack, merge }: { onBack: () => void; merge?: boolean }) {
  const w = useWallet();
  const ready = kusdtReady(w.active.config);
  const [asset, setAsset] = useState<Asset>(ready && !merge ? 'kusdt' : 'kas');
  const [to, setTo] = useState(merge ? w.keys.main.address : '');
  const [amountText, setAmountText] = useState(merge && w.balances ? plain(fmtKas(w.balances.kasSpendable)) : '');
  /** KAS only: everything spendable, the network fee taken out of it (the planner's sendMax). */
  const [sendMax, setSendMax] = useState(!!merge && !!w.balances);
  // A merge opened before the balance was read: Max once it is.
  useEffect(() => {
    if (merge && !amountText && w.balances) { setAmountText(plain(fmtKas(w.balances.kasSpendable))); setSendMax(true); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [merge, w.balances]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [kasPlan, setKasPlan] = useState<KasSendPlan | null>(null);
  /** With the address it was planned for, as `kasPlan` has its own: what the Review shows and Activity records. */
  const [tokenPlan, setTokenPlan] = useState<(SendPlan & { address: string }) | null>(null);
  const [step, setStep] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  /** A part can't be sent for lack of KAS: the reason, and all of it as the way that needs none. */
  const [partOffer, setPartOffer] = useState<PartNeedsKas | null>(null);
  /**
   * The user's word to also spend kUSDT the node could not show (its address cannot be listed: round 12, R12-WW-1).
   * Off unless ticked, and the review says what it means before anything is signed.
   */
  const [useUnchecked, setUseUnchecked] = useState(false);
  const prefix = KASPA_NETWORKS[w.active.network].prefix;
  const amount = asset === 'kas' ? parseKasText(amountText) : parseUsdtText(amountText);
  const b = w.balances;
  const name = networkName(w.active.network);
  const uncheckedKusdt = b?.uncheckedKusdt ?? 0n;
  /** The kUSDT a send may take: what the node shows, and with the box ticked what it could not show as well. */
  const kusdtToSend = b?.kusdt != null ? b.kusdt + (useUnchecked ? uncheckedKusdt : 0n) : null;
  /** More than the wallet holds (when it knows): said here, before any planning. */
  const over = amount != null && amount > 0n && !!b && (asset === 'kas' ? amount > b.kasSpendable : kusdtToSend != null && amount > kusdtToSend);

  let ownerWarning: string | null = null;
  let addressProblem: string | null = null;
  if (to.trim()) {
    try {
      const o = ownerOfAddress(to, prefix);
      if (asset === 'kusdt') ownerWarning = ownerWarningOf(o);
    } catch (e) { addressProblem = errText(e); }
  }

  function pick(a: Asset) { setAsset(a); setErr(null); setSendMax(false); setAmountText(''); }
  function max() {
    if (!b) return;
    if (asset === 'kas') { setAmountText(plain(fmtKas(b.kasSpendable))); setSendMax(true); }
    else if (kusdtToSend != null) setAmountText(plain(fmtUsdt(kusdtToSend)));
  }

  /** `all`: the amount of the offer just taken ("send all instead"), in place of the form's. */
  async function review(all?: bigint) {
    setErr(null); setPartOffer(null); setBusy(true);
    try {
      const sending = all ?? amount;
      if (!sending || sending <= 0n) throw new Error('Enter an amount.');
      const ctx = await w.ctx();
      const address = to.trim();
      if (asset === 'kas') setKasPlan(await planKasSend(ctx.node, ctx.network, ctx.net.prefix, { addresses: w.kasAddresses, changeAddress: w.keys.main.address, to: address, amount: sending, sendMax }));
      else setTokenPlan({ ...await planSend(ctx, w.signer, w.kasAddresses, { to: ownerOfAddress(address, ctx.net.prefix), amount: sending, unchecked: useUnchecked && uncheckedKusdt > 0n }), address });
    } catch (e) {
      // Said before anything is signed, with the way that works: all of it needs no other KAS.
      if (e instanceof PartNeedsKas) setPartOffer(e); else setErr(errText(e));
    } finally { setBusy(false); }
  }

  async function confirm() {
    setErr(null); setBusy(true);
    // The merges a kUSDT send needs first: once one went out, "nothing was sent" is said of the send (Daybreak [9]).
    let merged = 0;
    try {
      const ctx = await w.ctx();
      if (kasPlan) {
        // From the signer, which hands out no key once the wallet has locked (Daybreak [15]).
        const keyFor = (a: string) => { const hex = w.signer.secretFor(a); return hex ? hexToBytes(hex) : null; };
        const send = { kind: 'kas-send', kas: kasPlan.plan.amount.toString(), counterparty: kasPlan.to, fee: kasPlan.plan.fee.toString() } as const;
        // On Testnet the same keys hold the user's mainnet coins: a mainnet node is asked first that these are not those.
        const main = checkedAgainstMainnet(ctx.network) ? mainnetLookFor(w.active) : null;
        let txid: string;
        try { txid = await followMaybeSent(ctx.network, send, () => sendKas(ctx.node, ctx.network, ctx.net.prefix, kasPlan, keyFor, main?.look)); }
        finally { main?.close(); }
        await addActivity(ctx.network, { ...send, txid });
        setDone(txid);
      } else if (tokenPlan) {
        const send = { kind: 'kusdt-send', kusdt: tokenPlan.amount.toString(), counterparty: tokenPlan.address } as const;
        const { txid, built } = await followMaybeSent(ctx.network, send, () => executeSend(ctx, w.signer, w.kasAddresses, tokenPlan, (t) => {
          merged++;
          setStep(`Merged your tokens (${shortHash(t)}); building the send…`);
          addActivity(ctx.network, { kind: 'kusdt-merge', txid: t }).catch(() => {});
        }));
        await addActivity(ctx.network, { ...send, txid, fee: built.fee.toString() });
        setDone(txid);
      }
      w.refresh();
    } catch (e) { setErr(afterMerges(errText(e), merged, 'transfer')); } finally { setBusy(false); setStep(null); }
  }

  const net = KASPA_NETWORKS[w.active.network];
  if (done) return <Done title="Send" txid={done} href={net.explorerTx ? net.explorerTx.replace('{id}', done) : undefined}
    lines={[`On ${name}. It shows in Activity.`]} onClose={onBack} />;

  // The Review is of the planned transaction, the one Confirm submits: its recipient, never the form's.
  const plannedWarning = tokenPlan ? ownerWarningOf(tokenPlan.to) : null;
  if (kasPlan || tokenPlan) return (
    <>
      <Header title="Review" onBack={() => { setKasPlan(null); setTokenPlan(null); setErr(null); }} right={<NetworkButton network={w.active.network} />} />
      <NetworkBanner />
      <Body>
        <Card>
          {kasPlan && <ReviewAmount label="You send" kind="kas" amount={fmtKas(kasPlan.plan.amount)} symbol="KAS" />}
          {tokenPlan && <ReviewAmount label="You send" kind="kusdt" amount={fmtUsdt(tokenPlan.amount)} symbol={TOKEN_SYMBOL} />}
          <div className="text-xs font-medium text-pearl-500 mt-4">To</div>
          <div className="inset mt-1.5 px-3 py-2.5 mono text-xs break-all leading-relaxed text-pearl-300">{kasPlan?.to ?? tokenPlan?.address}</div>
        </Card>
        <Card pad="px-4 py-1.5">
          <Row label="Network" value={`${name} · ${NETWORKS[w.active.network].kaspa}`} />
          {kasPlan && <Row label="Network fee" value={`${fmtKas(kasPlan.plan.fee)} KAS`} />}
          {tokenPlan && <>
            <Row label="Network fee" value={tokenPlan.built ? `${fmtKas(tokenPlan.built.fee)} KAS` : 'shown per step'} />
            <KeptInToken tokenValue={tokenPlan.tokenValue} kept={tokenPlan.keptInToken} feeFromIt={tokenPlan.feeFromTokenKas} />
          </>}
        </Card>
        {tokenPlan && tokenPlan.merges > 0 && <Notice>Your {TOKEN_SYMBOL} is spread over {tokenPlan.picked.length} tokens and a transfer takes at most 3. The wallet first merges them ({tokenPlan.merges} extra transaction{tokenPlan.merges > 1 ? 's' : ''}, each with its own small fee), then sends.</Notice>}
        {plannedWarning && <Notice tone="warn">{plannedWarning}</Notice>}
        {tokenPlan && tokenPlan.unchecked > 0n && (
          <Notice tone="warn"><span data-testid="spends-unchecked">This spends {fmtUsdt(tokenPlan.unchecked)} {TOKEN_SYMBOL} that this wallet could not check on the Kaspa node, from its record of it. Everything this sends is as shown above. If that {TOKEN_SYMBOL} is not there exactly as recorded, the node refuses the transaction and nothing is sent.</span></Notice>
        )}
        {kasPlan && w.active.network !== 'mainnet' && (
          <Notice><span data-testid="shared-keys-note">{checkedAgainstMainnet(w.active.network) && !w.active.config.nodeUrl
            ? 'This wallet signs with the same keys on every Kaspa network. Before it signs this, it asks a mainnet node that the coins it spends are not real KAS, and stops if they are or if it cannot ask.'
            : 'This wallet signs with the same keys on every Kaspa network, and your own node says which network this is. For testing, use a recovery phrase that holds no real KAS.'}</span></Notice>
        )}
        {step && <Notice>{step}</Notice>}
        {err && <Notice tone="error">{err}</Notice>}
        <Button size="lg" disabled={busy} onClick={confirm}>{busy ? 'Sending…' : 'Confirm and send'}</Button>
      </Body>
    </>
  );

  const available = asset === 'kas' ? (b ? `${fmtKasBalance(b.kasSpendable)} KAS available` : null) : (b?.kusdt != null ? `${fmtUsdt2(b.kusdt)} ${TOKEN_SYMBOL} available` : null);
  return (
    <>
      <Header title="Send" onBack={onBack} right={<NetworkButton network={w.active.network} />} />
      <NetworkBanner />
      <Body>
        <div className="grid grid-cols-2 gap-2" role="radiogroup" aria-label="Asset">
          {([['kusdt', TOKEN_SYMBOL, b?.kusdt != null ? fmtUsdt2(b.kusdt) : '—', !ready], ['kas', 'KAS', b ? fmtKasBalance(b.kasSpendable) : '—', false]] as const).map(([v, sym, bal, off]) => (
            <button key={v} type="button" role="radio" aria-checked={asset === v} disabled={off || busy} onClick={() => pick(v)}
              className={`choice ${asset === v ? 'on' : ''} ${off ? 'opacity-50' : ''}`}>
              <TokenMark kind={v} size={30} />
              <span className="flex-1 min-w-0">
                <span className="block text-[13.5px] font-semibold text-pearl-200">{sym}</span>
                <span className="block text-xs text-pearl-500 tnum truncate">{bal}</span>
              </span>
              {asset === v && <span className="check-badge"><CheckIcon size={12} strokeWidth={3} /></span>}
            </button>
          ))}
        </div>
        <Field label="To" error={addressProblem} hint={!to ? `A ${name} Kaspa address (${prefix}:…)` : undefined}>
          <TextArea rows={2} value={to} onChange={e => setTo(e.target.value)} placeholder={`${prefix}:…`} className={`mono text-[12.5px] ${addressProblem ? 'invalid' : ''}`} disabled={busy} />
        </Field>
        <Field label="Amount" right={available} error={over ? 'That is more than you have.' : undefined}>
          <AmountInput value={amountText} onChange={v => { setAmountText(v); setSendMax(false); setPartOffer(null); }} suffix={asset === 'kas' ? 'KAS' : TOKEN_SYMBOL}
            onMax={b && (asset === 'kas' || b.kusdt != null) ? max : undefined} invalid={over || (!!amountText && amount == null)} disabled={busy} />
        </Field>
        {sendMax && asset === 'kas' && <p className="text-xs text-pearl-500 -mt-1">Everything spendable is sent; the network fee comes out of it.</p>}
        {merge && asset === 'kas' && to.trim() === w.keys.main.address && <Notice><span data-testid="merge-note">{MERGE_NOTE}</span></Notice>}
        {asset === 'kusdt' && ready && uncheckedKusdt > 0n && (
          <Checkbox checked={useUnchecked} onChange={(v) => { if (!busy) { setUseUnchecked(v); setPartOffer(null); } }}>
            Also use the {fmtUsdt(uncheckedKusdt)} {TOKEN_SYMBOL} this wallet could not check on the Kaspa node (the address it sits at can't be listed). It is spent first, so what is left of it moves to a new address.
          </Checkbox>
        )}
        {asset === 'kusdt' && !ready && <Notice>{TOKEN_SYMBOL} is not live on {name}.</Notice>}
        {ownerWarning && <Notice tone="warn">{ownerWarning}</Notice>}
        {err && <Notice tone="error">{err}</Notice>}
        {partOffer && asset === 'kusdt' && (
          <Notice tone="warn">
            <span data-testid="part-needs-kas">{partOffer.message}</span>
            <span className="block mt-2"><Button kind="secondary" size="sm" full={false} disabled={busy} onClick={() => { const all = partOffer.all; setAmountText(plain(fmtUsdt(all))); void review(all); }}>Send all {fmtUsdt(partOffer.all)} {TOKEN_SYMBOL} instead</Button></span>
          </Notice>
        )}
        <Button size="lg" disabled={busy || !to || !!addressProblem || !amount || over || (asset === 'kusdt' && !ready)} onClick={() => review()}>{busy ? 'Preparing…' : 'Review'}</Button>
      </Body>
    </>
  );
}
