// The bridge: USDT on Ethereum or BNB Chain → kUSDT on Kaspa (deposit), and
// kUSDT → USDT (redeem). The two sides are drawn as From and To cards; the EVM
// chain is picked inside its card.

import { useEffect, useRef, useState, type ReactNode } from 'react';
import { TOKEN_SYMBOL } from '@/brand';
import { KASPA_NETWORKS, explorerTxUrl } from '@kusdt/kaspa';
import { fmtKas, fmtUsdt, fmtUsdt2, parseUsdtText, formatUnits, plain, shortHash } from '@/lib/format';
import { CHAIN_KEYS, type ChainKey } from '@/config/defaults';
import { chainReady, kusdtReady } from '@/config/settings';
import { NETWORKS, networkName, timeToExpect } from '@/config/networks';
import { useWallet } from '@/popup/state';
import { NetworkBanner, NetworkButton, TopBar } from '@/popup/nav';
import { EthRpc } from '@/evm/rpc';
import { deposit, depositFeeQuote, feeMaxText, minMintedOf, tokenAmount, tokenBalance, unitsOf, vaultQuote, waitMined, type VaultInfo } from '@/evm/vault';
import { FormChanged, useFormLock } from '@/lib/formLock';
import { NoGas, TEST_USDT_WHOLE, mintTestUsdt, testUsdtOffered } from '@/evm/faucet';
import { isEvmAddressStrict } from '@/keys/derive';
import { burnTarget, executeRedeem, highFeeText, kasBalanceChange, planRedeem, recipientCheck, redeemCheck, type RecipientCheck, type RedeemCheck } from '@/kusdt/redeem';
import { minterPaused } from '@/kusdt/api';
import { PartNeedsKas, type SendPlan } from '@/kusdt/tokens';
import { addActivity, afterMerges, followMaybeSent } from '@/activity/history';
import { AddressChip, Body, Button, Card, Checkbox, EmptyState, Header, IconButton, Input, Notice, Row, Segmented, Spinner, errText } from '@/ui/kit';
import { ArrowDownIcon, BridgeIcon, CheckIcon, ExternalIcon, PencilIcon, TokenMark } from '@/ui/icons';
import { TokenChip } from './Swap';
import { Done, ReviewAmount } from './Send';

/**
 * The KAS side of a redemption: what the burn locks for good (burnValue), what
 * stays in the change token (still yours), the network fee, and the net change
 * to the KAS balance (the burnt states' KAS comes back, less those).
 */
export function RedeemKasRows({ plan }: { plan: Pick<SendPlan, 'picked' | 'built' | 'tokenValue' | 'keptInToken'> }) {
  const net = kasBalanceChange(plan);
  return (
    <>
      <Row label="Locked with the burn, for good" value={`${fmtKas(plan.tokenValue)} KAS`} />
      {plan.keptInToken > 0n && <Row label="Stays in your kUSDT change (yours)" value={`${fmtKas(plan.keptInToken)} KAS`} />}
      <Row label="Network fee" value={plan.built ? `${fmtKas(plan.built.fee)} KAS` : 'shown per step'} />
      {net != null && <Row label="Your KAS balance" value={`${net >= 0n ? '+' : '−'}${fmtKas(net >= 0n ? net : -net)} KAS`} />}
    </>
  );
}

export const rpcFor = (ch:{ rpcUrls: string[]; chainId: number; name: string; gasSymbol: string }) => new EthRpc(ch.rpcUrls, ch.chainId, ch.name, ch.gasSymbol);

type Direction = 'in' | 'out';

export function Bridge() {
  const w = useWallet();
  const [dir, setDir] = useState<Direction>('in');
  const [chain, setChain] = useState<ChainKey>('ethereum');
  const name = networkName(w.active.network);
  if (!kusdtReady(w.active.config)) return (
    <>
      <TopBar title="Bridge" />
      <Body>
        <EmptyState icon={<BridgeIcon size={20} />} title={`The bridge is not live on ${name} yet`}>
          It moves USDT between {w.active.config.chains.ethereum.name} or {w.active.config.chains.bsc.name} and {TOKEN_SYMBOL} on Kaspa, once {name} has a deployment.
        </EmptyState>
      </Body>
    </>
  );
  // Locked while a deposit or a redemption runs: switching would take its form off the screen.
  const direction = (locked: boolean) => (
    <Segmented label="Direction" value={dir} onChange={setDir}
      options={[{ value: 'in', label: `USDT → ${TOKEN_SYMBOL}`, disabled: locked }, { value: 'out', label: `${TOKEN_SYMBOL} → USDT`, disabled: locked }]} />
  );
  return dir === 'in'
    ? <Deposit chain={chain} setChain={setChain} direction={direction} />
    : <Redeem chain={chain} setChain={setChain} direction={direction} />;
}

/** The EVM chain, picked inside its card. */
function ChainChooser({ chain, setChain, disabled }: { chain: ChainKey; setChain: (c: ChainKey) => void; disabled?: boolean }) {
  const w = useWallet();
  return <Segmented small label="Chain" value={chain} onChange={setChain} options={CHAIN_KEYS.map(k => ({ value: k, label: w.active.config.chains[k].name, disabled }))} />;
}

/** One side of a transfer: where from or to, the asset, the amount, the account. */
function SideCard({ label, right, children }: { label: string; right?: ReactNode; children: ReactNode }) {
  return (
    <div className="panel flex flex-col gap-1.5">
      <div className="flex items-center justify-between gap-2 min-h-[26px]">
        <span className="text-xs font-medium text-pearl-500">{label}</span>
        {right}
      </div>
      {children}
    </div>
  );
}

function Sides({ from, to }: { from: ReactNode; to: ReactNode }) {
  return (
    <div className="flex flex-col gap-1">
      {from}
      <div className="relative h-0"><span className="flip-btn" aria-hidden="true"><ArrowDownIcon size={16} /></span></div>
      {to}
    </div>
  );
}

function KaspaSide() {
  const w = useWallet();
  return <span className="text-xs font-semibold text-pearl-300">{NETWORKS[w.active.network].kaspa}</span>;
}

function TimeRow({ direction, chain }: { direction: Direction; chain: ChainKey }) {
  const w = useWallet();
  const t = timeToExpect(w.active.network, direction, chain, w.active.config.chains[chain].name);
  return <Row label="Time to expect" value={<>{t.time}{t.why && <span className="block text-xs text-pearl-500 mt-0.5">{t.why}</span>}</>} />;
}

/** The wallet's own USDT and gas on `chain` (read-only); `bump` reads them again. */
function useEvmBalances(chain: ChainKey, bump = 0) {
  const w = useWallet();
  const ch = w.active.config.chains[chain];
  const [bal, setBal] = useState<{ usdt: bigint; gas: bigint } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    setBal(null); setErr(null);
    if (!chainReady(ch)) return;
    let alive = true;
    const rpc = rpcFor(ch);
    Promise.all([tokenBalance(rpc, ch.token, w.keys.evmAddress), rpc.balance(w.keys.evmAddress)])
      .then(([usdt, gas]) => { if (alive) setBal({ usdt, gas }); }).catch(e => { if (alive) setErr(errText(e)); });
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chain, w.active.network, bump]);
  return { bal, err };
}

/** Whether minting on Kaspa is paused, asked of the coordinator every 30 s. A deposit still goes in, and waits. No answer says nothing. */
function useMinterPaused(): boolean {
  const w = useWallet();
  const [paused, setPaused] = useState(false);
  useEffect(() => {
    let alive = true;
    const read = async () => {
      try { const s = await (await w.ctx()).api?.status(); if (alive) setPaused(minterPaused(s)); }
      catch { /* the last answer stands */ }
    };
    read();
    const t = setInterval(read, 30_000);
    return () => { alive = false; clearInterval(t); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [w.active.network]);
  return paused;
}

type FaucetState = { phase: 'idle' } | { phase: 'busy' } | { phase: 'done'; hash: string } | { phase: 'no-gas' } | { phase: 'error'; message: string };

/**
 * Testnet and Local only: 1,000 test USDT from the deployment's MockUSDT
 * (anyone may mint it), minted by the wallet's EVM account to itself.
 */
function TestUsdt({ chain, onMinted, locked }: { chain: ChainKey; onMinted: () => void; locked?: boolean }) {
  const w = useWallet();
  const ch = w.active.config.chains[chain];
  const [st, setSt] = useState<FaucetState>({ phase: 'idle' });
  useEffect(() => { setSt({ phase: 'idle' }); }, [chain, w.active.network]);
  if (!testUsdtOffered(w.active.network) || !chainReady(ch)) return null;
  async function get() {
    setSt({ phase: 'busy' });
    const key = w.evmKey();
    try {
      const rpc = rpcFor(ch);
      const hash = await mintTestUsdt({ network: w.active.network, rpc, token: ch.token, decimals: ch.decimals, from: w.keys.evmAddress, key });
      const r = await waitMined(rpc, hash);
      if (!r.ok) throw new Error(`The mint failed on ${ch.name}.`);
      setSt({ phase: 'done', hash });
      onMinted();
    } catch (e) { setSt(e instanceof NoGas ? { phase: 'no-gas' } : { phase: 'error', message: errText(e) }); } finally { key.fill(0); }
  }
  const link = st.phase === 'done' && ch.explorerTx ? ch.explorerTx.replace('{tx}', st.hash) : null;
  return (
    <div className="flex flex-col gap-1.5" data-testid="test-usdt">
      <div className="flex items-center justify-between gap-2 px-0.5">
        <span className="text-xs text-pearl-500 leading-snug">Test USDT on {ch.name}, free to mint</span>
        <Button kind="secondary" size="sm" full={false} disabled={st.phase === 'busy' || locked} onClick={get}>
          {st.phase === 'busy' ? <><Spinner size={12} />Minting…</> : `Get ${TEST_USDT_WHOLE.toLocaleString('en-US')} test USDT`}
        </Button>
      </div>
      {st.phase === 'done' && (
        <Notice action={<span className="flex items-center gap-2">
          <span className="chip" title={st.hash}><span>{shortHash(st.hash)}</span></span>
          {link && <a href={link} target="_blank" rel="noreferrer" className="btn btn-quiet btn-sm">View the transaction<ExternalIcon size={13} /></a>}
        </span>}>{TEST_USDT_WHOLE.toLocaleString('en-US')} test USDT minted to your EVM account on {ch.name}.</Notice>
      )}
      {st.phase === 'no-gas' && (
        <Notice tone="warn" action={<AddressChip address={w.keys.evmAddress} head={8} tail={6} />}>
          Your EVM account has no {ch.gasSymbol} on {ch.name} for the network fee. Send a little {ch.gasSymbol} to it first:
        </Notice>
      )}
      {st.phase === 'error' && <Notice tone="error">{st.message}</Notice>}
    </div>
  );
}

/** What the vault says about a deposit of `units` on `chain`, and the most its transactions may cost (null until that is read). */
interface DepositQuote { chain: ChainKey; units: bigint; info: VaultInfo; feeMax: bigint | null; feeNote?: string | null }

function Deposit({ chain, setChain, direction }: { chain: ChainKey; setChain: (c: ChainKey) => void; direction: (locked: boolean) => ReactNode }) {
  const w = useWallet();
  const ch = w.active.config.chains[chain];
  const [amountText, setAmountText] = useState('');
  const [bump, setBump] = useState(0);
  const { bal, err: balErr } = useEvmBalances(chain, bump);
  const paused = useMinterPaused();
  const [quote, setQuote] = useState<DepositQuote | null>(null);
  const [quoteErr, setQuoteErr] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const running = useRef(false);
  const [steps, setSteps] = useState<string[]>([]);
  // What was sent, as it was sent: the chain is the deposit's, not the one the form shows afterwards.
  const [done, setDone] = useState<{ hash: string; nonce: bigint; minted: bigint; chain: ChainKey } | null>(null);
  const units = parseUsdtText(amountText);
  const ready = chainReady(ch);
  // Only an answer about this very amount on this chain counts: one for an amount typed before is not shown or used.
  const current = quote && units != null && quote.units === units && quote.chain === chain ? quote : null;
  const info = current?.info ?? null;
  const feeMax = current?.feeMax ?? null;
  const feeNote = current?.feeNote ?? null;
  const clickedForm = useFormLock({ chain, amountText, network: w.active.network });

  useEffect(() => { setQuote(null); setErr(null); }, [chain, w.active.network]);

  useEffect(() => {
    setQuoteErr(null);
    if (!ready || !units || units <= 0n) { setQuote(null); return; }
    let alive = true;
    const read = async () => {
      // Not under a running deposit: what it holds to is what the click saw.
      if (running.current) return;
      try {
        const rpc = rpcFor(ch);
        const info = await vaultQuote(rpc, ch.vault, units);
        if (!alive || running.current) return;
        setQuote(q => ({ chain, units, info, feeMax: q && q.chain === chain && q.units === units ? q.feeMax : null }));
        if (info.minted <= 0n) return;
        const { max: feeMax, note: feeNote } = await depositFeeQuote({
          rpc, vault: ch.vault, token: ch.token, decimals: ch.decimals, resetAllowanceFirst: chain === 'ethereum',
          from: w.keys.evmAddress, units, ownerScheme: 0, ownerHex: w.keys.ownerHex, minMinted: minMintedOf(info.minted, units),
        });
        if (alive && !running.current) { setQuote({ chain, units, info, feeMax, feeNote }); setQuoteErr(null); }
      } catch (e) { if (alive) setQuoteErr(errText(e)); }
    };
    const t = setTimeout(read, 300);
    // The fees move: the maximum shown is read again while the form waits.
    const again = setInterval(read, 30_000);
    return () => { alive = false; clearTimeout(t); clearInterval(again); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [amountText, chain, bump]);

  const problem = !units ? null
    : info?.paused ? 'The vault is paused.'
    : info && (units < info.minDeposit || units > info.maxDeposit) ? `Deposits are ${fmtUsdt(info.minDeposit)} to ${fmtUsdt(info.maxDeposit)} USDT.`
    : bal && tokenAmount(units, ch.decimals) > bal.usdt ? 'Not enough USDT.'
    : null;

  async function go() {
    if (!units || !info || feeMax == null || running.current) return;
    // The form is locked while this runs; should it have changed all the same, or been left, nothing more is signed.
    const unchanged = clickedForm();
    running.current = true;
    setBusy(true); setErr(null); setSteps([]);
    const key = w.evmKey();
    try {
      const rpc = rpcFor(ch);
      const r = await deposit({
        rpc, vault: ch.vault, token: ch.token, decimals: ch.decimals, resetAllowanceFirst: chain === 'ethereum',
        from: w.keys.evmAddress, key, units, ownerScheme: 0, ownerHex: w.keys.ownerHex,
        // No less than the screen shows now (the vault's own answer), but for the slack: it reverts otherwise and takes nothing.
        minMinted: minMintedOf(info.minted, units),
        // No more in network fees than the screen shows now.
        maxNetworkFee: feeMax,
        beforeSign: () => { if (!unchanged()) throw new FormChanged(); },
        onStep: (s, h) => setSteps(x => [...x, `${s === 'reset' ? 'Allowance reset to 0' : s === 'approve' ? 'Approved' : 'Deposit sent'}: ${shortHash(h)}`]),
      });
      await addActivity(w.active.network, { kind: 'deposit', txid: r.hash, chain, nonce: r.event.nonce.toString(), kusdt: r.event.minted.toString(), status: 'pending' });
      setDone({ hash: r.hash, nonce: r.event.nonce, minted: r.event.minted, chain });
    } catch (e) { setErr(errText(e)); } finally {
      key.fill(0); running.current = false; setBusy(false);
      // The balances and the fee figure as they are after it (after a fee that rose, the new maximum).
      setBump(n => n + 1);
    }
  }

  if (done) {
    const sentOn = w.active.config.chains[done.chain];
    return <Done title="Bridge" heading="Deposit sent" txid={done.hash} href={sentOn.explorerTx ? sentOn.explorerTx.replace('{tx}', done.hash) : undefined}
      lines={[`Deposit #${done.nonce} on ${sentOn.name}.`, `${fmtUsdt(done.minted)} ${TOKEN_SYMBOL} will be minted to your Kaspa address once the deposit is final (${timeToExpect(w.active.network, 'in', done.chain, sentOn.name).time.toLowerCase()}). Follow it in Activity.`]}
      onClose={() => { setDone(null); setAmountText(''); setSteps([]); }} />;
  }

  const quoted = info && units != null && units > 0n;
  return (
    <>
      <TopBar title="Bridge" />
      <Body dense>
        {direction(busy)}
        <Sides
          from={
            <SideCard label="From" right={<ChainChooser chain={chain} setChain={setChain} disabled={busy} />}>
              <div className="flex items-center gap-3 h-8">
                <input className="amount-input" value={amountText} onChange={e => { if (!running.current) setAmountText(e.target.value); }} inputMode="decimal" placeholder="0.00"
                  aria-label="USDT to bridge" spellCheck={false} autoComplete="off" disabled={!ready || busy} />
                <TokenChip kind="usdt" symbol="USDT" />
              </div>
              <div className="flex items-center justify-between gap-2">
                <AddressChip address={w.keys.evmAddress} head={6} tail={4} />
                <div className="flex items-center gap-2 text-xs text-pearl-500 tnum">
                  <span>{bal ? formatUnits(bal.usdt, ch.decimals, 2) : '—'} USDT</span>
                  {bal && bal.usdt > 0n && <button type="button" className="max-btn" disabled={busy} onClick={() => setAmountText(plain(fmtUsdt(unitsOf(bal.usdt, ch.decimals))))}>Max</button>}
                </div>
              </div>
            </SideCard>
          }
          to={
            <SideCard label="To" right={<KaspaSide />}>
              <div className="flex items-center gap-3 h-8">
                <span className={`panel-amount ${quoted ? '' : 'text-pearl-800'}`} aria-label="You receive">{quoted ? fmtUsdt(info!.minted) : '0.00'}</span>
                <TokenChip kind="kusdt" symbol={TOKEN_SYMBOL} />
              </div>
              <div className="flex items-center justify-between gap-2">
                <AddressChip address={w.keys.main.address} head={6} tail={5} />
                <span className="text-xs text-pearl-500 tnum">{w.balances?.kusdt != null ? fmtUsdt2(w.balances.kusdt) : '—'} {TOKEN_SYMBOL}</span>
              </div>
            </SideCard>
          } />
        {!ready && <Notice>{ch.name} is not configured on {networkName(w.active.network)} (Network → Advanced: vault, USDT and RPC).</Notice>}
        <TestUsdt chain={chain} onMinted={() => setBump(n => n + 1)} locked={busy} />
        <Card pad="px-4 py-1">
          {quoted && <Row label="You receive" value={`${fmtUsdt(info!.minted)} ${TOKEN_SYMBOL}`} strong />}
          {quoted && <Row label="Bridge fee" value={`${fmtUsdt(info!.fee)} USDT`} />}
          {quoted && <Row label="Network fee" value={<span data-testid="deposit-fee-max">{feeMax != null ? `at most ${feeMaxText(feeMax)} ${ch.gasSymbol}` : 'checking'}</span>} />}
          <TimeRow direction="in" chain={chain} />
          <p className="text-xs text-pearl-500 leading-relaxed pt-0.5 pb-1.5">
            Approve exactly this amount, then deposit{chain === 'ethereum' ? ' (an older approval is reset to 0 first)' : ''}. Fees in {ch.gasSymbol}{bal ? `: you have ${formatUnits(bal.gas, 18, 4)}` : ''}.
          </p>
        </Card>
        {steps.length > 0 && <div className="flex flex-col gap-1">{steps.map((s, i) => <div key={i} className="flex items-center gap-2 text-xs text-pearl-400"><CheckIcon size={13} />{s}</div>)}</div>}
        {quoted && feeNote && <Notice tone="warn"><span data-testid="deposit-fee-spread">{feeNote}</span></Notice>}
        {paused && <Notice tone="warn">Minting on Kaspa is paused by the guardian. New deposits wait until it is unpaused.</Notice>}
        {problem && <Notice tone="warn">{problem}</Notice>}
        {balErr && <Notice tone="error">{balErr}</Notice>}
        {quoteErr && !busy && <Notice tone="error">{quoteErr}</Notice>}
        {err && <Notice tone="error">{err}</Notice>}
        <Button size="lg" disabled={busy || !ready || !units || !info || !!problem || info.minted <= 0n || feeMax == null} onClick={go}>{busy ? 'Bridging…' : 'Approve and deposit'}</Button>
      </Body>
    </>
  );
}

function Redeem({ chain, setChain, direction }: { chain: ChainKey; setChain: (c: ChainKey) => void; direction: (locked: boolean) => ReactNode }) {
  const w = useWallet();
  const ch = w.active.config.chains[chain];
  const [address, setAddress] = useState(w.keys.evmAddress);
  const [editing, setEditing] = useState(false);
  const [amountText, setAmountText] = useState('');
  const [check, setCheck] = useState<RedeemCheck | null>(null);
  const [recipient, setRecipient] = useState<RecipientCheck | null>(null);
  const [asked, setAsked] = useState(0);
  const [plan, setPlan] = useState<(SendPlan & { releaseFee: bigint }) | null>(null);
  const [agree, setAgree] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [done, setDone] = useState<{ txid: string; chain: ChainKey } | null>(null);
  /** A part can't be redeemed for lack of KAS: the reason, and all of it as the way that needs none. */
  const [partOffer, setPartOffer] = useState<PartNeedsKas | null>(null);
  const { bal } = useEvmBalances(chain);
  const units = parseUsdtText(amountText);
  const addrOk = isEvmAddressStrict(address.trim()) && !/^0x0{40}$/i.test(address.trim());
  const own = address.trim().toLowerCase() === w.keys.evmAddress.toLowerCase();

  useEffect(() => {
    setCheck(null); setErr(null); setPartOffer(null);
    if (!units || units <= 0n) return;
    let alive = true;
    const t = setTimeout(async () => {
      // SPEC §9: the vault must be able to pay this (capacity, allowance now, backing), and it must be above the fee.
      try { const c = await redeemCheck(await w.ctx(), chain, units, addrOk ? address.trim() : undefined); if (alive) setCheck(c); }
      catch (e) { if (alive) setErr(errText(e)); }
    }, 300);
    return () => { alive = false; clearTimeout(t); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [amountText, chain, address]);

  useEffect(() => {
    setRecipient(null);
    if (!addrOk) return;
    let alive = true;
    const t = setTimeout(async () => {
      // SPEC §9: a blocked recipient is never paid, so the vault must be willing to pay this address.
      try { const r = await recipientCheck(await w.ctx(), chain, address.trim()); if (alive) setRecipient(r); }
      catch (e) { if (alive) setRecipient({ payable: false, problem: errText(e), checked: false, blocked: false }); }
    }, 300);
    return () => { alive = false; clearTimeout(t); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [address, chain, asked]);

  async function review() {
    if (!units || !check || check.problem || !recipient?.payable) return;
    setBusy(true); setErr(null); setPartOffer(null);
    try { setPlan(await planRedeem(await w.ctx(), w.signer, w.kasAddresses, { chain, address: address.trim(), amount: units })); }
    // A part that can't be redeemed for lack of KAS: said before anything is signed, with the way that works.
    catch (e) { if (e instanceof PartNeedsKas) setPartOffer(e); else setErr(errText(e)); } finally { setBusy(false); }
  }

  async function confirm() {
    if (!plan) return;
    setBusy(true); setErr(null);
    // The merges a burn needs first: once one went out, the error says so, and that the burn itself was not sent (Daybreak [9]).
    let merged = 0;
    try {
      const ctx = await w.ctx();
      // What is recorded is what the burn commits to: the plan, not the form.
      const { chain: paidOn, address: paidTo } = burnTarget(plan);
      const redeem = { kind: 'redeem', outputIndex: 0, chain: paidOn, address: paidTo, kusdt: plan.amount.toString() } as const;
      const r = await followMaybeSent(ctx.network, redeem, () => executeRedeem(ctx, w.signer, w.kasAddresses, plan, (t) => { merged++; addActivity(ctx.network, { kind: 'kusdt-merge', txid: t }).catch(() => {}); }));
      await addActivity(ctx.network, { ...redeem, txid: r.txid, outputIndex: r.outputIndex, status: r.reported ? 'seen' : 'unreported' });
      setDone({ txid: r.txid, chain: paidOn }); w.refresh();
    } catch (e) { setErr(afterMerges(errText(e), merged, 'burn')); } finally { setBusy(false); }
  }

  const net = KASPA_NETWORKS[w.active.network];
  if (done) return <Done title="Bridge" heading="Redemption sent" txid={done.txid} href={net.explorerTx ? explorerTxUrl(net, done.txid) : undefined}
    lines={[`USDT is paid on ${w.active.config.chains[done.chain].name} once the burn is final and 3 of 5 signers sign. Follow it in Activity.`]}
    onClose={() => { setDone(null); setPlan(null); setAgree(false); setAmountText(''); }} />;
  // A recipient the vault wouldn't pay is the problem shown, and then no other chain is offered (SPEC §9).
  const refused = recipient != null && !recipient.payable;
  const asking = addrOk && recipient == null;

  // The Review is of the planned burn, the one Redeem submits: its chain and address, never the form's.
  const paid = plan ? burnTarget(plan) : null;
  const paidOnName = paid ? w.active.config.chains[paid.chain].name : '';
  if (plan && paid) return (
    <>
      <Header title="Review" onBack={() => { setPlan(null); setAgree(false); }} right={<NetworkButton network={w.active.network} />} />
      <NetworkBanner />
      <Body>
        <Card>
          <ReviewAmount label="You burn" kind="kusdt" amount={fmtUsdt(plan.amount)} symbol={TOKEN_SYMBOL} />
          <div className="text-xs font-medium text-pearl-500 mt-4">Paid to, on {paidOnName}</div>
          <div className="inset mt-1.5 px-3 py-2.5 mono text-xs break-all leading-relaxed text-pearl-300">{paid.address}</div>
        </Card>
        <Card pad="px-4 py-1.5">
          <Row label="You receive" value={`${fmtUsdt(plan.amount - plan.releaseFee)} USDT`} strong />
          <Row label="On" value={paidOnName} />
          <Row label="Release fee" value={`${fmtUsdt(plan.releaseFee)} USDT`} />
          <RedeemKasRows plan={plan} />
          <TimeRow direction="out" chain={paid.chain} />
          {/* What the burn is checked against again, after any merges, right before it goes (Daybreak [2], [19], [24]). */}
          <p className="text-xs text-pearl-500 leading-relaxed pt-0.5 pb-1.5" data-testid="redeem-rechecks">The release fee and the limits are the {paidOnName} vault's own, read over its RPCs. Just before the burn, after any merges, the wallet asks again: the bridge server, and the USDT token where it keeps a blocklist, that this address can be paid, and the vault that its fee is not above the one shown. Otherwise nothing is burnt.</p>
        </Card>
        {highFeeText(plan.amount, plan.releaseFee) && <Notice tone="warn">{highFeeText(plan.amount, plan.releaseFee)}</Notice>}
        <Notice tone="warn">A redemption can't be undone. The {TOKEN_SYMBOL} is burnt for good and the USDT can only go to the address above on {paidOnName}. Check the address and the network.</Notice>
        <Checkbox checked={agree} onChange={setAgree}>I checked the address and the network</Checkbox>
        {err && <Notice tone="error">{err}</Notice>}
        <div className="flex flex-col gap-2">
          <Button size="lg" disabled={busy || !agree} onClick={confirm}>{busy ? 'Redeeming…' : 'Redeem'}</Button>
          <Button kind="secondary" disabled={busy} onClick={() => { setPlan(null); setAgree(false); }}>Back</Button>
        </div>
      </Body>
    </>
  );

  const fee = check?.fee;
  const showsFee = fee != null && units != null && units > 0n;
  return (
    <>
      <TopBar title="Bridge" />
      <Body dense>
        {direction(busy)}
        <Sides
          from={
            <SideCard label="From" right={<KaspaSide />}>
              <div className="flex items-center gap-3 h-8">
                <input className="amount-input" value={amountText} onChange={e => setAmountText(e.target.value)} inputMode="decimal" placeholder="0.00"
                  aria-label={`${TOKEN_SYMBOL} to redeem`} spellCheck={false} autoComplete="off" disabled={busy} />
                <TokenChip kind="kusdt" symbol={TOKEN_SYMBOL} />
              </div>
              <div className="flex items-center justify-between gap-2">
                <AddressChip address={w.keys.main.address} head={6} tail={5} />
                <div className="flex items-center gap-2 text-xs text-pearl-500 tnum">
                  <span>{w.balances?.kusdt != null ? fmtUsdt2(w.balances.kusdt) : '—'} {TOKEN_SYMBOL}</span>
                  {w.balances?.kusdt != null && w.balances.kusdt > 0n && <button type="button" className="max-btn" disabled={busy} onClick={() => setAmountText(plain(fmtUsdt(w.balances!.kusdt!)))}>Max</button>}
                </div>
              </div>
            </SideCard>
          }
          to={
            <SideCard label="To" right={<ChainChooser chain={chain} setChain={setChain} disabled={busy} />}>
              <div className="flex items-center gap-3 h-8">
                <span className={`panel-amount ${showsFee && units! > fee! ? '' : 'text-pearl-800'}`} aria-label="You receive">{showsFee ? (units! > fee! ? fmtUsdt(units! - fee!) : '0') : '0.00'}</span>
                <TokenChip kind="usdt" symbol="USDT" />
              </div>
              {editing || !own ? (
                <div className="flex flex-col gap-1.5">
                  <div className="flex items-center gap-2">
                    <Input value={address} onChange={e => setAddress(e.target.value)} aria-label={`Pay USDT to (${ch.name} address)`} placeholder="0x…"
                      className={`mono text-[12px] h-9 ${address && !addrOk ? 'invalid' : ''}`} disabled={busy} />
                    {!own && <Button kind="quiet" size="sm" full={false} disabled={busy} onClick={() => { setAddress(w.keys.evmAddress); setEditing(false); }}>Mine</Button>}
                  </div>
                  <span className={`text-xs ${address && !addrOk ? 'text-rose-ink' : 'text-pearl-500'}`}>
                    {address && !addrOk ? 'Not a valid EVM address (check the capital letters).' : own ? 'Your own EVM account.' : `Paid to this address on ${ch.name}.`}
                  </span>
                </div>
              ) : (
                <div className="flex items-center justify-between gap-2">
                  <span className="flex items-center gap-1 min-w-0">
                    <AddressChip address={address} head={6} tail={4} />
                    <IconButton label="Pay another address" small disabled={busy} onClick={() => setEditing(true)}><PencilIcon size={13} /></IconButton>
                  </span>
                  <span className="text-xs text-pearl-500 tnum shrink-0">{bal ? `${formatUnits(bal.usdt, ch.decimals, 2)} USDT` : 'Your account'}</span>
                </div>
              )}
              {asking && <div className="flex items-center gap-2 text-xs text-pearl-500"><Spinner size={12} />Checking that the vault would pay this address…</div>}
            </SideCard>
          } />
        {refused && <Notice tone="warn" action={!recipient.checked && <Button kind="secondary" size="sm" full={false} disabled={busy} onClick={() => setAsked(n => n + 1)}>Check again</Button>}>{recipient.problem}</Notice>}
        <Card pad="px-4 py-1">
          {showsFee && <Row label="You receive" value={units! > fee! ? `${fmtUsdt(units! - fee!)} USDT` : 'nothing'} strong />}
          {showsFee && <Row label="Release fee" value={`${fmtUsdt(fee!)} USDT`} />}
          <TimeRow direction="out" chain={chain} />
        </Card>
        {!asking && units != null && units > 0n && !check && !err && <div className="flex items-center gap-2 text-xs text-pearl-500 px-0.5"><Spinner size={12} />Checking what the vault can pay…</div>}
        {!refused && !asking && check?.problem && <Notice tone="warn">{check.problem}</Notice>}
        {!refused && !asking && check?.other && <Button kind="secondary" disabled={busy} onClick={() => setChain(check.other!)}>Redeem on {w.active.config.chains[check.other].name} instead</Button>}
        {showsFee && !check?.problem && highFeeText(units!, fee!) && <Notice tone="warn">{highFeeText(units!, fee!)}</Notice>}
        <Notice tone="warn">A redemption can't be undone.</Notice>
        {err && <Notice tone="error">{err}</Notice>}
        {partOffer && (
          <Notice tone="warn" action={<Button kind="secondary" size="sm" full={false} disabled={busy} onClick={() => setAmountText(plain(fmtUsdt(partOffer.all)))}>Redeem all {fmtUsdt(partOffer.all)} {TOKEN_SYMBOL} instead</Button>}>
            <span data-testid="part-needs-kas">{partOffer.message}</span>
          </Notice>
        )}
        <Button size="lg" disabled={busy || !addrOk || !units || !check || !!check.problem || !recipient?.payable} onClick={review}>{busy ? 'Preparing…' : 'Review'}</Button>
      </Body>
    </>
  );
}
