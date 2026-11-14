// The approval window for a site's window.kusdt request (SPEC §14). It shows
// what the request does, built by the wallet itself, and acts only when the
// user approves. It can only act on the request whose id it was opened for.
//
// A pool request whose quote gets worse before it goes in is not sent: the
// window shows the new numbers and waits for the user to approve again. A
// network switch (kaspa_switchNetwork) saves the network and keeps the site
// connected there; the background then tells every tab.
//
// A request whose kUSDT is spread over more states than one transaction takes
// first merges them, and those merges go out before it does: each is put in
// Activity, and should the request stop after them, the window says they went
// out (Daybreak [9]).

import { useEffect, useRef, useState, type MouseEvent } from 'react';
import { TOKEN_SYMBOL } from '@/brand';
import { fmtKas, fmtUsdt, formatUnits } from '@/lib/format';
import { useWallet } from '@/popup/state';
import { connectionsKey, ERR, type Connection, type PendingRequest } from '@/provider/protocol';
import { finishRequest, markSending, readPending } from '@/provider/answer';
import { local } from '@/lib/storage';
import { chooseStates, loadTokens, planSend, executeSend, singleStateOf, type SendPlan } from '@/kusdt/tokens';
import { ownerOfAddress, siteSendWarningOf } from '@/kusdt/owner';
import { planRedeem, executeRedeem, highFeeText } from '@/kusdt/redeem';
import {
  QuoteChanged, freshPool, largestSellWithin, maxBuyAcceptedFee, quoteBuy, quoteSellAt, quoteAdd, quoteRemove, minimumFor, sellNowDaa, secondsUntilDaa, swap, addLiquidity, removeLiquidity, loadPositions, windowOver, addRatioProblem, trimToShares,
  poolFeeAbout, poolFeeShareText } from '@/kusdt/pool';
import { addActivity, afterMerges, followMaybeSent, mergedFirst, outcomeStatus } from '@/activity/history';
import { kasBalance } from '@/kaspa/kas';
import { isNetworkName, loadSettings, networkLive, saveSettings } from '@/config/settings';
import type { KaspaNetworkName } from '@/config/defaults';
import { NETWORKS, chainsLine, networkName } from '@/config/networks';
import { TERMS_REFUSAL, termsAccepted } from '@/config/terms';
import { keysFor } from '@/wallet/context';
import { NetDot, NetworkBanner, NetworkButton } from '@/popup/nav';
import { Body, Button, Card, Footer, Header, Notice, Row, Spinner, errText } from '@/ui/kit';
import { ArrowDownIcon, GlobeIcon } from '@/ui/icons';
import { KeptInToken } from './Send';
import { RedeemKasRows } from './Bridge';
import { waitText } from './PoolParts';

const requestId = () => (location.hash.match(/^#request=([A-Za-z0-9_-]{8,64})$/) ?? [])[1] ?? null;

interface Prepared {
  rows: [string, string][];
  notes: string[];
  warn?: string;
  /** Refused as it stands (a paused pool, the circuit breaker): Approve stays off. */
  blocked?: boolean;
  plan?: SendPlan;
  /** `onMerge`: told each merge the request sent first. */
  run: (onMerge: (txid: string) => void) => Promise<unknown>;
  /** What the window calls the request's own transaction when merges went out before it ("sale"). */
  what?: string;
  /** The same request on the new numbers of a worse quote, for the user to approve again, after `merged` merges went out. */
  requote?: (e: QuoteChanged, merged: number) => Prepared;
  /** kaspa_switchNetwork: the network the site asks for. */
  switchTo?: KaspaNetworkName;
}

/** How long the window must be visible, focused and showing the request before Approve can be clicked. */
export const ARM_MS = 1_000;

/**
 * Whether Approve may be clicked. A page knows where this window opens and can
 * keep the user clicking at that spot, so the button answers only ARM_MS after
 * the window is visible and focused with `shown` (the request as prepared, new
 * numbers included) on screen. Losing focus or sight of the window, the
 * pointer coming into it, or a press of the pointer or of a key during the
 * wait start the wait again: however fast someone keeps clicking or typing,
 * the button stays off (a page could have its visitor typing as well, run 21
 * round 2, R21-W2-1).
 */
export function useArmed(shown: object | null): boolean {
  const [armedFor, setArmedFor] = useState<object | null>(null);
  useEffect(() => {
    if (!shown) return;
    let timer: ReturnType<typeof setTimeout> | undefined, armed = false;
    const disarm = () => { clearTimeout(timer); armed = false; setArmedFor(null); };
    const restart = () => {
      disarm();
      if (document.visibilityState === 'visible' && document.hasFocus()) timer = setTimeout(() => { armed = true; setArmedFor(shown); }, ARM_MS);
    };
    const press = () => { if (!armed) restart(); };
    const page = document.documentElement;
    restart();
    window.addEventListener('focus', restart);
    window.addEventListener('blur', disarm);
    window.addEventListener('pointerdown', press, true);
    window.addEventListener('keydown', press, true);
    document.addEventListener('visibilitychange', restart);
    page.addEventListener('pointerenter', restart);
    return () => {
      clearTimeout(timer);
      window.removeEventListener('focus', restart);
      window.removeEventListener('blur', disarm);
      window.removeEventListener('pointerdown', press, true);
      window.removeEventListener('keydown', press, true);
      document.removeEventListener('visibilitychange', restart);
      page.removeEventListener('pointerenter', restart);
    };
  }, [shown]);
  return shown !== null && armedFor === shown;
}

const PAUSED = 'The pool is paused: swaps and new liquidity are stopped for now (withdrawals stay open). This request would be refused.';
const MOVED = 'The pool moved before this went in, and it now gives less than you approved. Nothing was sent. Check the new numbers and approve again to go ahead.';
/** MOVED, after `merged` merges went out first: then it is the request's own transaction (`what`) that was not sent. */
const moved = (merged: number, what: string): string => (merged
  ? `The pool moved before this went in, and it now gives less than you approved. The ${what} was not sent; ${mergedFirst(merged)} Check the new numbers and approve again to go ahead.`
  : MOVED);
/**
 * The change token a sale of a part of a state, or a deposit, leaves: it carries the deployment's tokenValue, and when
 * the state spent carries less (a send's fee can be taken out of it), the build tops it up from the wallet's KAS by
 * `topUp`. Shown, as the Pool screen shows the change it keeps (run 21 round 2, R21-W2-3): it stays the user's.
 */
const changeRow = (tokenValue: bigint, topUp: bigint): [string, string] =>
  ['Kept in your token (change)', `${fmtKas(tokenValue)} KAS${topUp > 0n ? ` (${fmtKas(topUp)} KAS of it from your KAS)` : ''}`];
/** What the build adds from the wallet's KAS to a change token made from `spent` (none when merges make it: a merge's state carries tokenValue). */
const topUpOf = (spent: { utxo: { amount: bigint } } | undefined, tokenValue: bigint): bigint =>
  (spent && spent.utxo.amount < tokenValue ? tokenValue - spent.utxo.amount : 0n);
/** A pool request's network fee row, at the feerate the node names now (round 15, R15-CL-3): the build is held to it. */
/** `keep`: what a Max buy keeps for the fee and may pay (maxBuyAcceptedFee), said as the Swap screen says it (PoolFeeRow). */
const poolFeeRow = (feerate: number, keep?: bigint): [string, string] => {
  const about = poolFeeAbout(feerate);
  return ['Network fee', keep != null && keep > about ? `up to ${fmtKas(keep, 4)} KAS (Max keeps it for the fee)` : `about ${fmtKas(about, 4)} KAS`];
};
// R17-CL-1: and change too small to keep is not paid to the network unasked (kusdt/pool.ts assertChangeKept).
const FEE_HELD = 'The network fee is held to the feerate shown: should the node ask more than half as much again by the time it is built, nothing is sent. Nor is anything sent that would give the network change too small for it to keep.';

/** One network, as the window names it: its dot and name, and the chains it joins. */
function NetLine({ label, network }: { label: string; network: KaspaNetworkName }) {
  return (
    <div className="flex items-start gap-3 py-1.5">
      <span className="text-xs font-medium text-pearl-500 w-9 pt-0.5 shrink-0">{label}</span>
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-1.5 text-[14px] font-semibold text-pearl-200"><NetDot network={network} />{NETWORKS[network].name}</span>
        <span className="block text-xs text-pearl-500 mt-0.5">{chainsLine(network)}</span>
      </span>
    </div>
  );
}

export function Approve() {
  const w = useWallet();
  const [req, setReq] = useState<PendingRequest | null | undefined>(undefined);
  const [prep, setPrep] = useState<Prepared | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [finished, setFinished] = useState<string | null>(null);
  const armed = useArmed(prep);
  // When the last two keys went down, and when the focus last moved (run 21 round 2, R21-W2-1). Once Approve is on,
  // Tab, Tab and Enter typed into a page that opened this window would reach it and click it: a click the keyboard
  // makes (`detail` 0, Enter or Space on the focused button) counts only once Approve has held the focus for ARM_MS
  // with no key pressed since but the one that clicks.
  const keys = useRef({ last: 0, before: 0, focusedAt: 0 });
  const [keyTooSoon, setKeyTooSoon] = useState(false);
  useEffect(() => {
    const down = () => { keys.current.before = keys.current.last; keys.current.last = Date.now(); };
    const focus = () => { keys.current.focusedAt = Date.now(); };
    window.addEventListener('keydown', down, true);
    window.addEventListener('focusin', focus, true);
    return () => { window.removeEventListener('keydown', down, true); window.removeEventListener('focusin', focus, true); };
  }, []);
  function onApprove(e: MouseEvent<HTMLButtonElement>) {
    const held = document.activeElement === e.currentTarget && Date.now() - Math.max(keys.current.focusedAt, keys.current.before) >= ARM_MS;
    const tooSoon = e.detail === 0 && !held;
    setKeyTooSoon(tooSoon);
    if (!tooSoon) void approve();
  }

  useEffect(() => {
    readPending().then(p => setReq(p && p.id === requestId() ? p : null));
  }, []);

  useEffect(() => {
    if (!req) return;
    if (req.network !== w.active.network) { setErr(`The wallet switched to ${networkName(w.active.network)} while this request waited. Nothing was done: ask again from the page.`); return; }
    (req.method === 'kaspa_requestAccounts' ? answerIfConnected(req) : Promise.resolve(false))
      .then(answered => (answered ? undefined : prepare(req).then(setPrep)))
      .catch(e => setErr(errText(e)));
  }, [req]);

  /**
   * A site already connected with this wallet's address on this network asked for its account while the wallet was
   * locked (background/provider.ts sends that here, as the window asks for the password first). Unlocked now, it is
   * answered the account it has, as it would have been at once: nothing new is approved. Any other site is asked.
   */
  async function answerIfConnected(r: PendingRequest): Promise<boolean> {
    const conn = ((await local.get<Record<string, Connection>>(connectionsKey(r.network))) ?? {})[r.origin];
    if (conn?.address !== w.keys.main.address || !(await termsAccepted())) return false;
    await finishRequest(r, { result: [w.keys.main.address] });
    setFinished('This site is already connected: it has its account again. You can close this window.');
    setTimeout(() => window.close(), 1200);
    return true;
  }

  async function prepare(r: PendingRequest): Promise<Prepared> {
    const p = r.params;
    if (p.method === 'kaspa_requestAccounts') {
      return {
        rows: [['Site', r.origin], ['Account', w.keys.main.address]],
        notes: ['The site will see this address and your KAS and kUSDT balances. It can ask for transactions; each one opens this window for your approval.'],
        run: async () => {
          const key = connectionsKey(w.active.network);
          const all = (await local.get<Record<string, Connection>>(key)) ?? {};
          all[r.origin] = { origin: r.origin, address: w.keys.main.address, ownerHex: w.keys.ownerHex, kasAddresses: w.kasAddresses, at: Date.now() };
          await local.set({ [key]: all });
          return [w.keys.main.address];
        },
      };
    }
    if (p.method === 'kaspa_switchNetwork') {
      const to = p.network;
      if (!networkLive(to, (await loadSettings()).overrides)) throw new Error(`Nothing is deployed on ${NETWORKS[to].name} yet, so the wallet can't switch to it.`);
      return {
        rows: [], switchTo: to,
        notes: [`The site stays connected on ${NETWORKS[to].name}, with your ${NETWORKS[to].name} account. The whole wallet switches: balances, activity and the pool are those of ${NETWORKS[to].name}. You can switch back at any time.`],
        warn: NETWORKS[to].tone === 'main' ? 'Mainnet uses real funds.' : undefined,
        run: async () => {
          if (!networkLive(to, (await loadSettings()).overrides)) throw new Error(`Nothing is deployed on ${NETWORKS[to].name} yet.`);
          // The site's connection on the target network first (that network's account), so the page needs no new Connect;
          // then the network itself, which the background broadcasts (networkChanged, accountsChanged) to every tab.
          const keys = keysFor(w.hd, to);
          const key = connectionsKey(to);
          const all = (await local.get<Record<string, Connection>>(key)) ?? {};
          all[r.origin] = { origin: r.origin, address: keys.main.address, ownerHex: keys.ownerHex, kasAddresses: keys.scan.map(k => k.address), at: all[r.origin]?.at ?? Date.now() };
          await local.set({ [key]: all });
          await saveSettings({ network: to });
          return to;
        },
      };
    }
    const ctx = await w.ctx();
    if (p.method === 'kusdt_send') {
      const amount = BigInt(p.amount);
      const plan = await planSend(ctx, w.signer, w.kasAddresses, { to: ownerOfAddress(p.to, ctx.net.prefix), amount });
      return {
        rows: [['Send', `${fmtUsdt(amount)} ${TOKEN_SYMBOL}`], ['To', p.to], ['Network fee', plan.built ? `${fmtKas(plan.built.fee)} KAS` : 'per step']],
        notes: plan.merges ? [`Merges your tokens first (${plan.merges} extra transaction${plan.merges > 1 ? 's' : ''}).`] : [], plan,
        // A site chooses this address: a script or an ECDSA one is warned about, as on the Send screen, and of the
        // owner the plan pays (kusdt/owner.ts siteSendWarningOf).
        warn: siteSendWarningOf(plan.to) ?? undefined,
        what: 'transfer',
        run: async (onMerge) => {
          await markSending(r);
          const send = { kind: 'kusdt-send', kusdt: p.amount, counterparty: p.to } as const;
          const { txid, built } = await followMaybeSent(ctx.network, send, () => executeSend(ctx, w.signer, w.kasAddresses, plan, onMerge));
          await addActivity(ctx.network, { ...send, txid, fee: built.fee.toString() });
          return { txid };
        },
      };
    }
    if (p.method === 'kusdt_redeem') {
      const amount = BigInt(p.amount);
      const ch = ctx.config.chains[p.chain];
      // The SPEC §9 checks inside planRedeem: the recipient (GET /recipients; a blocked one is refused), then
      // capacity, allowance now, backing and fee on the newest /status. executeRedeem asks about the recipient again.
      const plan = await planRedeem(ctx, w.signer, w.kasAddresses, { chain: p.chain, address: p.address, amount });
      const fee = plan.releaseFee;
      return {
        // The KAS rows (burn, change, network fee, balance) come from RedeemKasRows with the plan.
        rows: [['Redeem', `${fmtUsdt(amount)} ${TOKEN_SYMBOL}`], ['Paid to', p.address], ['On', ch.name], ['Release fee', `${fmtUsdt(fee)} USDT`], ['You receive', `${fmtUsdt(amount - fee)} USDT`]],
        notes: [], plan,
        warn: [highFeeText(amount, fee), `A redemption can't be undone: the ${TOKEN_SYMBOL} is burnt and the USDT can only go to the address above on ${ch.name}.`].filter(Boolean).join(' '),
        what: 'burn',
        run: async (onMerge) => {
          await markSending(r);
          const burn = { kind: 'redeem', outputIndex: 0, chain: p.chain, address: p.address, kusdt: p.amount } as const;
          const res = await followMaybeSent(ctx.network, burn, () => executeRedeem(ctx, w.signer, w.kasAddresses, plan, onMerge));
          await addActivity(ctx.network, { ...burn, txid: res.txid, status: res.reported ? 'seen' : 'unreported' });
          return { txid: res.txid, redeemIds: res.redeemIds };
        },
      };
    }
    if (p.method === 'kusdt_swap') {
      const [vp, feerate] = await Promise.all([freshPool(ctx), ctx.node.feerate()]);
      if (!vp.reserve || vp.pool.state.totalShares === 0n) throw new Error('The pool has no liquidity yet, so there is nothing to swap with.');
      const state = vp.pool.state;
      const amountIn = BigInt(p.amountIn), minOut = BigInt(p.minOut);
      // A buy of all the KAS the site's Max lets in keeps FEE_KEEP for the network fee, as on the Swap screen: it may
      // pay that, change too small to keep included. Worked out from this wallet's own coins, never from the site
      // (round 18, R18-CL-2: the window passed no fee, and such a buy was refused at every try while fees were high).
      const spendable = p.side === 'buy' ? await kasBalance(ctx.node, ctx.network, w.kasAddresses).then(k => k.spendable, () => null) : null;
      const acceptedFee = maxBuyAcceptedFee(ctx, p.side, amountIn, spendable);
      const fmtIn = p.side === 'buy' ? `${fmtKas(amountIn)} KAS` : `${fmtUsdt(amountIn)} ${TOKEN_SYMBOL}`;
      const fmtOut = (v: bigint) => (p.side === 'buy' ? `${fmtUsdt(v)} ${TOKEN_SYMBOL}` : `${fmtKas(v)} KAS`);
      let q: bigint, breaker: string | undefined;
      if (p.side === 'buy') q = quoteBuy(ctx, state, amountIn);
      else {
        // The circuit breaker at the wallet's clock (SPEC §15): a sell it would refuse is never built.
        const nowDaa = sellNowDaa(state, await ctx.node.virtualDaa());
        const s = quoteSellAt(ctx, state, amountIn, nowDaa, vp.pool.utxo.blockDaaScore);
        q = s.kasOut;
        if (!s.breaker.allowed) {
          const fit = largestSellWithin(ctx, state, s.breaker.maxKasOut, amountIn);
          const until = windowOver(s.breaker.windowEndsDaa, nowDaa) ? '' : `, until it has refilled ${waitText(secondsUntilDaa(s.breaker.windowEndsDaa, nowDaa))}`;
          breaker = `The pool's circuit breaker lets sells take out at most ${fmtKas(s.breaker.maxKasOut, 2)} KAS more${until}, and this sell would take ${fmtKas(q, 2)} KAS: it would be refused. ${fit > 0n ? `The most that fits now is ${fmtUsdt(fit)} ${TOKEN_SYMBOL}.` : 'No sell fits until then.'}`;
        }
      }
      // A buy also moves the KAS its new kUSDT state carries (tokenValue): still the user's, but it goes with that kUSDT
      // when it is sent on. Said here as the Swap screen says it (run 21, R21-WALLET-2). A sale of a part of a state
      // leaves the rest in a change token, which keeps tokenValue (R21-W2-3); one of the whole state leaves none.
      const tokenValue = BigInt(ctx.config.tokenValue);
      let kept: [string, string][] = [];
      if (p.side === 'buy') kept = [['Kept in your token', `${fmtKas(tokenValue)} KAS`]];
      else {
        const { states } = await loadTokens(ctx, w.signer);
        const spent = singleStateOf(states, amountIn);
        // With no state enough alone, the ones picked are merged into one first, whose whole amount the sale spends from.
        const total = spent?.state.amount ?? chooseStates(states, amountIn).picked.reduce((t, s) => t + s.state.amount, 0n);
        if (total > amountIn) kept = [changeRow(tokenValue, topUpOf(spent, tokenValue))];
      }
      const make = (quoted: bigint, before?: bigint, merged = 0): Prepared => ({
        rows: [['Pay', fmtIn], [before != null ? 'New quote' : 'Quote now', fmtOut(quoted)], ...(before != null ? [['You saw', fmtOut(before)] as [string, string]] : []), ['Minimum the site set', fmtOut(minOut)], poolFeeRow(feerate, acceptedFee), ...kept],
        notes: ['If the pool moves first, the wallet quotes again (up to 3 times). It goes ahead on its own only for at least this quote; for less it asks you here again, and never goes below the minimum.', FEE_HELD],
        warn: [state.paused ? PAUSED : breaker ?? (quoted < minOut ? 'The pool pays less than the minimum right now: this swap would be refused.' : before != null ? moved(merged, 'sale') : undefined),
          poolFeeShareText(poolFeeAbout(feerate), p.side === 'buy' ? amountIn : quoted)].filter(Boolean).join(' ') || undefined,
        blocked: state.paused || !!breaker,
        what: p.side === 'buy' ? 'buy' : 'sale',
        run: async (onMerge) => {
          await markSending(r);
          const res = await followMaybeSent(ctx.network, p.side === 'buy' ? { kind: 'swap-buy', kas: p.amountIn, kusdt: quoted.toString() } : { kind: 'swap-sell', kusdt: p.amountIn, kas: quoted.toString() },
            () => swap(ctx, w.signer, w.kasAddresses, { side: p.side, amountIn, minOut, quoted, shownFeerate: feerate, acceptedFee }, onMerge));
          await addActivity(ctx.network, p.side === 'buy'
            ? { kind: 'swap-buy', txid: res.txid, kas: p.amountIn, kusdt: res.amountOut.toString(), fee: res.built.fee.toString(), ...outcomeStatus(res.confirmed) }
            : { kind: 'swap-sell', txid: res.txid, kusdt: p.amountIn, kas: res.amountOut.toString(), fee: res.built.fee.toString(), ...outcomeStatus(res.confirmed) });
          // `confirmed`: the node showed it accepted. False: sent, and not seen accepted while the wallet waited (SPEC §14).
          return { txid: res.txid, amountOut: res.amountOut.toString(), confirmed: res.confirmed };
        },
        requote: (e, merged) => make(e.now as bigint, e.seen as bigint, merged),
      });
      return make(q);
    }
    if (p.method === 'kusdt_addLiquidity') {
      const [vp, feerate] = await Promise.all([freshPool(ctx), ctx.node.feerate()]);
      if (!vp.reserve || vp.pool.state.totalShares === 0n) throw new Error('The pool has no liquidity yet: its first deposit is made in the wallet (Pool → Open the pool).');
      const kasIn = BigInt(p.kasIn), tokensIn = BigInt(p.tokensIn);
      // Only what the shares need goes in: what the site asked above the pool ratio stays with the wallet.
      const used = trimToShares(vp.pool.state, kasIn, tokensIn);
      const shares = quoteAdd(ctx, vp.pool.state, used.kasIn, used.tokensIn);
      // A site can name any ratio: too far off it and the deposit would be mostly one side's leftover.
      const off = addRatioProblem(vp.pool.state, kasIn, tokensIn);
      const trimmed = used.kasIn !== kasIn || used.tokensIn !== tokensIn;
      // A deposit always leaves a change token (an empty one when it uses a whole state), which keeps tokenValue (R21-W2-3).
      const tokenValue = BigInt(ctx.config.tokenValue);
      const change = changeRow(tokenValue, topUpOf(singleStateOf((await loadTokens(ctx, w.signer)).states, used.tokensIn), tokenValue));
      const make = (quoted: bigint, before?: bigint, merged = 0): Prepared => ({
        rows: [[before != null ? 'Add at most' : 'Add', `${fmtKas(used.kasIn)} KAS + ${fmtUsdt(used.tokensIn)} ${TOKEN_SYMBOL}`], ...(trimmed ? [['The site asked', `${fmtKas(kasIn)} KAS + ${fmtUsdt(tokensIn)} ${TOKEN_SYMBOL}`] as [string, string]] : []), [before != null ? 'New shares' : 'Shares', formatUnits(quoted, 0)], ...(before != null ? [['You saw', formatUnits(before, 0)] as [string, string]] : []), ['Kept in the position', `${fmtKas(BigInt(ctx.config.positionValue))} KAS`], change, poolFeeRow(feerate)],
        notes: ['Only what the shares need is put in, at the pool ratio: the rest stays in your wallet. For fewer shares the wallet asks you again; it never takes below 99 % of the first quote.', FEE_HELD],
        warn: [vp.pool.state.paused ? PAUSED : off ?? (before != null ? moved(merged, 'deposit') : undefined), poolFeeShareText(poolFeeAbout(feerate), used.kasIn)].filter(Boolean).join(' ') || undefined,
        blocked: vp.pool.state.paused || !!off,
        what: 'deposit',
        run: async (onMerge) => {
          await markSending(r);
          const add = { kind: 'lp-add', kas: used.kasIn.toString(), kusdt: used.tokensIn.toString() } as const;
          // The amounts shown, not the site's: on a pool that moved since, the site's would be trimmed again and could put in
          // more of one side than the window showed (run 20, PUB20-1). The shown ones give fewer shares there, and fewer
          // shares ask the user again (QuoteChanged); trimmed again, neither side ever grows.
          const res = await followMaybeSent(ctx.network, add, () => addLiquidity(ctx, w.signer, w.kasAddresses, { kasIn: used.kasIn, tokensIn: used.tokensIn, minShares: minimumFor(shares, 100), quoted, shownFeerate: feerate }, onMerge));
          await addActivity(ctx.network, { ...add, kas: res.kasIn.toString(), kusdt: res.tokensIn.toString(), txid: res.txid, fee: res.built.fee.toString(), ...outcomeStatus(res.confirmed) });
          return { txid: res.txid, shares: res.shares.toString(), confirmed: res.confirmed };
        },
        requote: (e, merged) => make(e.now as bigint, e.seen as bigint, merged),
      });
      return make(shares);
    }
    if (p.method === 'kusdt_removeLiquidity') {
      const pos = (await loadPositions(ctx, w.signer)).find(x => x.id === p.position);
      if (!pos) throw new Error('That position is not one of this wallet\'s.');
      const [vp, feerate] = await Promise.all([freshPool(ctx), ctx.node.feerate()]);
      const q = quoteRemove(ctx, vp.pool.state, pos.located.state.shares);
      const both = (v: { kasOut: bigint; tokensOut: bigint }) => `${fmtKas(v.kasOut)} KAS + ${fmtUsdt(v.tokensOut)} ${TOKEN_SYMBOL}`;
      const make = (quoted: { kasOut: bigint; tokensOut: bigint }, before?: { kasOut: bigint; tokensOut: bigint }): Prepared => ({
        rows: [['Remove', `${formatUnits(pos.located.state.shares, 0)} shares`], [before ? 'You now receive about' : 'You receive about', both(quoted)], ...(before ? [['You saw', both(before)] as [string, string]] : []), poolFeeRow(feerate)],
        notes: [
          'For less of either the wallet asks you again; it never takes below 99 % of the first quote. Removing stays open while the pool is paused.', FEE_HELD,
          // A position the node could not show (its address cannot be listed): said here too, where a site asked for the removal.
          ...(pos.unread ? ['This position could not be checked on the Kaspa node: the address it sits at can\'t be listed right now. It is shown from its record. If it is not there as recorded, the node refuses the removal and nothing is sent.'] : []),
        ],
        warn: [before ? MOVED : undefined, poolFeeShareText(poolFeeAbout(feerate), quoted.kasOut)].filter(Boolean).join(' ') || undefined,
        run: async () => {
          await markSending(r);
          const res = await followMaybeSent(ctx.network, { kind: 'lp-remove', kas: quoted.kasOut.toString(), kusdt: quoted.tokensOut.toString() },
            () => removeLiquidity(ctx, w.signer, w.kasAddresses, { position: p.position, minKas: minimumFor(q.kasOut, 100), minTokens: minimumFor(q.tokensOut, 100), quoted, shownFeerate: feerate }));
          await addActivity(ctx.network, { kind: 'lp-remove', txid: res.txid, kas: res.kasOut.toString(), kusdt: res.tokensOut.toString(), fee: res.built.fee.toString(), ...outcomeStatus(res.confirmed) });
          return { txid: res.txid, confirmed: res.confirmed };
        },
        requote: (e) => make(e.now as { kasOut: bigint; tokensOut: bigint }, e.seen as { kasOut: bigint; tokensOut: bigint }),
      });
      return make(q);
    }
    throw new Error('Unsupported request.');
  }

  async function approve() {
    if (!req || !prep) return;
    setBusy(true); setErr(null);
    // The merges the request sends first, each put in Activity as the wallet's own screens put theirs.
    const merges: string[] = [];
    const onMerge = (txid: string) => { merges.push(txid); addActivity(req.network, { kind: 'kusdt-merge', txid }).catch(() => {}); };
    try {
      // The window opens on the terms first when they wait (popup/App.tsx); this holds should it ever be reached
      // without them. Nothing is answered: the request stays open, and closing the window rejects it.
      if (!(await termsAccepted())) { setErr(TERMS_REFUSAL); return; }
      const result = await prep.run(onMerge);
      await finishRequest(req, { result });
      setFinished(prep.switchTo ? `Switched to ${NETWORKS[prep.switchTo].name}. You can close this window.` : 'Done. You can close this window.');
      if (!prep.switchTo) w.refresh();
      setTimeout(() => window.close(), 1200);
    } catch (e) {
      if (e instanceof QuoteChanged && prep.requote) {
        // The request's own transaction was not sent (merges before it may have been): it stays open for the user to
        // approve the new numbers (or reject).
        await markSending(req, false);
        setPrep(prep.requote(e, merges.length));
        return;
      }
      // After merges went out, "nothing was sent" is said of the request's own transaction, and what did go out is said.
      const text = afterMerges(errText(e), merges.length, prep.what ?? 'request');
      await finishRequest(req, { error: { code: ERR.internal, message: text } }, false);
      setErr(text);
    } finally { setBusy(false); }
  }
  async function reject() {
    if (req) await finishRequest(req, { error: { code: ERR.rejected, message: 'The user rejected the request.' } });
    window.close();
  }

  if (req === undefined) return <div className="flex-1 flex items-center justify-center"><Spinner size={18} /></div>;
  if (req === null) return (<><Header title="Request" /><Body><Notice>This request is no longer waiting.</Notice></Body><Footer><Button onClick={() => window.close()}>Close</Button></Footer></>);
  const connect = req.method === 'kaspa_requestAccounts';
  const switching = req.params.method === 'kaspa_switchNetwork' ? req.params.network : null;
  const title = connect ? 'Connect a site' : switching ? 'Switch network' : 'Approve a transaction';
  // The network the request was made on (the wallet's when it was asked); a mismatch is refused above.
  const net = isNetworkName(req.network) ? req.network : w.active.network;
  let host = req.origin;
  try { host = new URL(req.origin).host; } catch { /* shown as is */ }
  const isAddress = (v: string) => /^(kaspa|kaspatest|kaspasim):/.test(v) || /^0x[0-9a-fA-F]{40}$/.test(v);
  const asks = connect ? 'wants to connect to your wallet' : switching ? `asks to switch to ${NETWORKS[switching].name}` : 'asks you to approve what the wallet built';
  return (
    <>
      <Header title={title} right={<NetworkButton network={net} />} />
      <NetworkBanner network={net} />
      <Body>
        <Card pad="p-4">
          <div className="flex items-center gap-3">
            <span className="icon-badge w-10 h-10"><GlobeIcon size={18} /></span>
            <div className="min-w-0 flex-1">
              <div className="text-[14px] font-semibold text-pearl-200 truncate">{host}</div>
              <div className="text-xs text-pearl-500 truncate" data-testid="approve-asks">{asks}</div>
            </div>
          </div>
          <div className="mt-3 pt-1.5 border-t border-ink-700">
            <Row label="Site" value={req.origin} />
            {!switching && <>
              <Row label="Network" value={<span className="inline-flex items-center gap-1.5 font-semibold text-pearl-200"><NetDot network={net} />{NETWORKS[net].name}</span>} />
              <div className="text-xs text-pearl-500 text-right -mt-1 pb-1">{chainsLine(net)}</div>
            </>}
          </div>
        </Card>
        {switching && (
          <Card pad="px-4 py-2">
            <div data-testid="switch-networks" className="flex flex-col">
              <NetLine label="From" network={net} />
              <div className="flex items-center gap-3 py-0.5"><span className="w-9 shrink-0" /><ArrowDownIcon size={14} className="text-pearl-500" /></div>
              <NetLine label="To" network={switching} />
            </div>
          </Card>
        )}
        {!prep && !err && <div className="flex justify-center py-6"><Spinner size={18} /></div>}
        {prep && prep.rows.length > 0 && <Card pad="px-4 py-1.5">{prep.rows.filter(([k]) => k !== 'Site').map(([k, v]) => <Row key={k} label={k} mono={isAddress(v)} value={<span className="break-all">{v}</span>} />)}
          {prep.plan && (prep.plan.redeem ? <RedeemKasRows plan={prep.plan} /> : <KeptInToken tokenValue={prep.plan.tokenValue} kept={prep.plan.keptInToken} feeFromIt={prep.plan.feeFromTokenKas} />)}</Card>}
        {prep?.warn && <Notice tone="warn">{prep.warn}</Notice>}
        {prep?.notes.map((n, i) => <Notice key={i}>{n}</Notice>)}
        {keyTooSoon && <Notice>To approve with the keyboard, keep the focus on Approve for a second without pressing another key, then press Enter.</Notice>}
        {finished && <Notice>{finished}</Notice>}
        {err && <Notice tone="error">{err}</Notice>}
      </Body>
      <Footer row>
        <Button kind="secondary" size="lg" disabled={busy || !!finished} onClick={reject}>Reject</Button>
        <Button size="lg" disabled={busy || !armed || !prep || !!finished || !!err || !!prep?.blocked} onClick={onApprove}>{busy ? 'Working…' : connect ? 'Connect' : switching ? 'Switch' : 'Approve'}</Button>
      </Footer>
    </>
  );
}
