// A submission the node never answered may be on the network: the page and the
// user hear so, with its txid, its inputs stay out of selection, and it goes in
// Activity. Never a plain failure the page can simply retry.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
// @ts-ignore: ws ships no types, and the test needs only its server.
import { WebSocketServer } from 'ws';
import { button, checkbox, cleanup, click, fakeWindow, field, flush, mount, toggle, typeIn, until } from './fake-dom';
import { A, BOB, fixture, noNetwork, resetStores, type Fixture } from './screen-fixture';
import { KaspaNodeClient, MaybeSent, NoAnswer, NodeRejected } from '@/kaspa/node';
import { MAYBE_SENT, followMaybeSent, listActivity } from '@/activity/history';
import { planKasSend, sendKas } from '@/kaspa/kas';
import { kaspaPrivateKey } from '@/keys/derive';
import { inputsOf, pendingSet } from '@/kusdt/pending';
import { executeRedeem, planRedeem } from '@/kusdt/redeem';
import { withFreshPool } from '@/kusdt/pool';
import { executeSend, loadTokens, planSend } from '@/kusdt/tokens';
import { ownerOfAddress } from '@/kusdt/owner';
import { session } from '@/lib/storage';
import { MSG_ANSWER, REQUEST_KEY, type PendingRequest } from '@/provider/protocol';
import { NavContext, type Nav } from '@/popup/nav';
import { ActivityRow } from '@/screens/Activity';
import { Approve, ARM_MS } from '@/screens/Approve';
import { Bridge } from '@/screens/Bridge';
import { Send } from '@/screens/Send';

const h = vi.hoisted(() => ({ wallet: null as unknown }));
vi.mock('@/popup/state', () => ({ useWallet: () => h.wallet }));

type ServerSocket = { send(s: string): void; terminate(): void; on(e: string, f: (d: unknown) => void): void };
type Server = { once(e: string, f: () => void): void; on(e: string, f: (ws: ServerSocket) => void): void; close(f: () => void): void; address(): unknown };
const servers: Server[] = [], sockets: ServerSocket[] = [];

/** A simnet node that takes submitTransaction and then goes silent, or closes the connection. */
async function nodeThat(end: 'goes silent' | 'closes'): Promise<KaspaNodeClient> {
  const wss: Server = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  servers.push(wss);
  await new Promise<void>((ok) => wss.once('listening', () => ok()));
  wss.on('connection', (ws: ServerSocket) => {
    sockets.push(ws);
    ws.on('message', (data: unknown) => {
      const msg = JSON.parse(String(data));
      if (msg.method === 'getServerInfo') ws.send(JSON.stringify({ id: msg.id, params: { networkId: 'simnet', hasUtxoIndex: true } }));
      else if (end === 'closes') ws.terminate();
    });
  });
  return new KaspaNodeClient('simnet', `ws://127.0.0.1:${(wss.address() as { port: number }).port}`, 500);
}

/** Submissions go to the real node client: every other read stays on the fake node. */
const submitsTo = (fx: Fixture, client: KaspaNodeClient) => { fx.node.submit = async (json) => { fx.node.submitted.push(json); return client.submit(json); }; };

const noAnswer = async (): Promise<never> => { throw new NoAnswer('submitTransaction: timed out'); };
const NET = 'simnet';

beforeEach(async () => { await resetStores(); vi.stubGlobal('fetch', noNetwork); });
afterEach(async () => {
  cleanup();
  vi.unstubAllGlobals();
  for (const c of sockets.splice(0)) c.terminate();
  for (const s of servers.splice(0)) await new Promise<void>((ok) => s.close(() => ok()));
});

const redeem = (fx: Fixture, amount = 20_000_000n) => planRedeem(fx.ctx, fx.wallet.signer, fx.wallet.kasAddresses, { chain: 'ethereum', address: A, amount });

describe('submitting a transaction the node never answers about', () => {
  it('is not a plain failure: it says it may have been sent, names the txid, and keeps the inputs out of selection', async () => {
    const fx = fixture('c1');
    const plan = await redeem(fx);
    submitsTo(fx, await nodeThat('goes silent'));
    const e = await executeRedeem(fx.ctx, fx.wallet.signer, fx.wallet.kasAddresses, plan).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(MaybeSent);
    expect((e as MaybeSent).txid).toBe(plan.built!.txid);
    expect((e as MaybeSent).message).toMatch(/may have been sent/);
    expect((e as MaybeSent).message).toContain(plan.built!.txid);
    expect((e as MaybeSent).merge).toBe(false);
    const pending = await pendingSet(NET);
    for (const input of inputsOf(plan.built!.transaction)) expect(pending.has(input)).toBe(true);
    expect((await loadTokens(fx.ctx, fx.wallet.signer)).total).toBe(0n);
  });

  it('treats a connection closing while the request was out the same way', async () => {
    const fx = fixture('c2');
    const plan = await redeem(fx);
    submitsTo(fx, await nodeThat('closes'));
    const e = await executeRedeem(fx.ctx, fx.wallet.signer, fx.wallet.kasAddresses, plan).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(MaybeSent);
    expect((await pendingSet(NET)).has(fx.tokenOutpoints[0])).toBe(true);
  });

  it('leaves a refusal a plain failure, its inputs still selectable', async () => {
    const fx = fixture('c3');
    const plan = await redeem(fx);
    fx.node.submitImpl = async () => { throw new NodeRejected('transaction is a double spend'); };
    await expect(executeRedeem(fx.ctx, fx.wallet.signer, fx.wallet.kasAddresses, plan)).rejects.toBeInstanceOf(NodeRejected);
    expect((await pendingSet(NET)).size).toBe(0);
  });

  it('a double spend names the transaction and says "already": it is a refusal, never "sent"', async () => {
    const fx = fixture('c4');
    const plan = await redeem(fx);
    fx.node.submitImpl = async (tx: any) => { throw new NodeRejected(`Rejected transaction ${plan.built?.txid ?? 'ab'.repeat(32)}: output ${'cd'.repeat(32)}:0 already spent by transaction ${'ef'.repeat(32)} in the mempool`); };
    await expect(executeRedeem(fx.ctx, fx.wallet.signer, fx.wallet.kasAddresses, plan)).rejects.toBeInstanceOf(NodeRejected);
    expect((await pendingSet(NET)).size).toBe(0);
  });

  it('stops at a merge the node never answered about, and marks it a merge', async () => {
    const fx = fixture('c4', { tokens: [1_000_000n, 1_000_000n, 1_000_000n, 1_000_000n] });
    const plan = await planSend(fx.ctx, fx.wallet.signer, fx.wallet.kasAddresses, { to: ownerOfAddress(BOB, fx.ctx.net.prefix), amount: 4_000_000n });
    expect(plan.merges).toBe(1);
    fx.node.submitImpl = noAnswer;
    const e = await executeSend(fx.ctx, fx.wallet.signer, fx.wallet.kasAddresses, plan).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(MaybeSent);
    expect((e as MaybeSent).merge).toBe(true);
    expect(fx.node.submitted).toHaveLength(1); // the merge; the send itself was never attempted
  });

  it('applies to KAS sends too', async () => {
    const fx = fixture('c5');
    const plan = await planKasSend(fx.node, NET, fx.ctx.net.prefix, { addresses: fx.wallet.kasAddresses, changeAddress: fx.wallet.keys.main.address, to: BOB, amount: 500_000_000n });
    fx.node.submitImpl = noAnswer;
    const key = (a: string) => { const k = fx.wallet.keys.scan.find(x => x.address === a); return k ? kaspaPrivateKey(fx.wallet.hd, k) : null; };
    const e = await sendKas(fx.node, NET, fx.ctx.net.prefix, plan, key).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(MaybeSent);
    expect((e as MaybeSent).message).toMatch(/may have been sent/);
    expect((await pendingSet(NET)).has(fx.kasOutpoint)).toBe(true);
  });

  it("isn't retried on the pool's next state, and doesn't say that nothing was sent", async () => {
    const fx = fixture('c6');
    let tries = 0;
    const attempt = async () => { tries++; throw new MaybeSent('ab'.repeat(32)); };
    await expect(withFreshPool(fx.ctx, attempt, 3, {} as never)).rejects.toThrow(/may have been sent/);
    expect(tries).toBe(1);
  });
});

describe('Activity', () => {
  const txid = 'ab'.repeat(32);

  it('records what may have been sent, and leaves anything else out', async () => {
    const what = { kind: 'kusdt-send', kusdt: '5', counterparty: BOB } as const;
    await expect(followMaybeSent(NET, what, async () => { throw new MaybeSent(txid); })).rejects.toBeInstanceOf(MaybeSent);
    expect(await listActivity(NET)).toMatchObject([{ ...what, txid, status: MAYBE_SENT }]);
    await resetStores();
    await expect(followMaybeSent(NET, what, async () => { throw new Error('refused'); })).rejects.toThrow('refused');
    expect(await listActivity(NET)).toEqual([]);
    await expect(followMaybeSent(NET, what, async () => 'sent')).resolves.toBe('sent');
    expect(await listActivity(NET)).toEqual([]);
  });

  it('records a merge as the merge', async () => {
    await expect(followMaybeSent(NET, { kind: 'redeem', kusdt: '5' }, async () => { throw new MaybeSent(txid, true); })).rejects.toBeInstanceOf(MaybeSent);
    expect(await listActivity(NET)).toMatchObject([{ kind: 'kusdt-merge', txid, status: MAYBE_SENT }]);
  });

  it('shows it plainly, not as sent', async () => {
    h.wallet = fixture('c7').wallet;
    const { root } = await mount(createElement(ActivityRow, { full: true, a: { id: 'x', kind: 'redeem', at: Date.now(), txid, kusdt: '5000000', chain: 'ethereum', address: A, outputIndex: 0, status: MAYBE_SENT } }));
    await until('the row', () => root.textContent.includes('Redeemed'));
    expect(root.textContent).toContain('May have been sent');
    expect(root.textContent).toContain('may or may not be on the network');
    expect(root.textContent).not.toContain('Sent');
  });
});

describe('the approval window', () => {
  const answers: { kind: string; id: string; body: { error?: { code: number; message: string }; result?: unknown } }[] = [];
  beforeEach(() => {
    answers.length = 0;
    vi.stubGlobal('chrome', { tabs: { sendMessage: (_tab: number, msg: (typeof answers)[number], cb?: () => void) => { answers.push(msg); cb?.(); } }, runtime: {} });
  });

  /** The window for a page's request, with what it prepared on screen and Approve armed. */
  async function windowFor(fx: Fixture, params: PendingRequest['params']) {
    h.wallet = fx.wallet;
    const id = 'window-1234';
    const pending = { id, method: params.method, params, origin: 'https://page.example', tabId: 7, at: 1, network: 'simnet' } as PendingRequest;
    await session.set({ [REQUEST_KEY]: pending });
    fakeWindow.location.hash = `#request=${id}`;
    const { root } = await mount(createElement(Approve));
    await until('Approve', () => button(root, 'Approve'));
    await until('Approve to arm', () => !button(root, 'Approve').disabled, ARM_MS + 3_000);
    return root;
  }

  it('tells the page and the user a burn may have been sent, names it, and records it', async () => {
    const fx = fixture('d1');
    submitsTo(fx, await nodeThat('goes silent'));
    const root = await windowFor(fx, { method: 'kusdt_redeem', chain: 'ethereum', address: A, amount: '20000000' });
    await click(button(root, 'Approve'));
    await until('the answer to the page', () => answers.length > 0);
    await until('the window to say so', () => root.textContent.includes('may have been sent'));

    const [a] = await listActivity(NET);
    expect(a).toMatchObject({ kind: 'redeem', chain: 'ethereum', address: A, kusdt: '20000000', outputIndex: 0, status: MAYBE_SENT });
    expect(answers[0].kind).toBe(MSG_ANSWER);
    expect(answers[0].body.error?.message).toMatch(/may have been sent/);
    expect(answers[0].body.error?.message).toContain(a.txid);
    expect(root.textContent).toContain(a.txid);
    expect((await pendingSet(NET)).has(fx.tokenOutpoints[0])).toBe(true);
    expect(button(root, 'Approve').disabled).toBe(true); // this request is over: asking again takes a new window, and the user knows
  });

  it('does the same for a kUSDT send when the connection closes on it', async () => {
    const fx = fixture('d2');
    submitsTo(fx, await nodeThat('closes'));
    const root = await windowFor(fx, { method: 'kusdt_send', to: BOB, amount: '5000000' });
    await click(button(root, 'Approve'));
    await until('the answer to the page', () => answers.length > 0);
    const [a] = await listActivity(NET);
    expect(a).toMatchObject({ kind: 'kusdt-send', counterparty: BOB, kusdt: '5000000', status: MAYBE_SENT });
    expect(answers[0].body.error?.message).toContain(a.txid);
  });

  it('still answers a refusal as the plain failure it is, recording nothing', async () => {
    const fx = fixture('d3');
    fx.node.submitImpl = async () => { throw new NodeRejected('transaction is a double spend'); };
    const root = await windowFor(fx, { method: 'kusdt_redeem', chain: 'ethereum', address: A, amount: '20000000' });
    await click(button(root, 'Approve'));
    await until('the answer to the page', () => answers.length > 0);
    expect(answers[0].body.error?.message).toMatch(/double spend/);
    expect(answers[0].body.error?.message).not.toMatch(/may have been sent/);
    expect(await listActivity(NET)).toEqual([]);
  });
});

const nav: Nav = { tab: 'bridge', setTab() {}, push() {}, back() {}, lock() {} };

describe('the wallet\'s own screens', () => {
  it('Redeem says a burn may have been sent, names it, and Activity has it', async () => {
    const fx = fixture('e1');
    h.wallet = fx.wallet;
    submitsTo(fx, await nodeThat('goes silent'));
    const { root } = await mount(createElement(NavContext.Provider, { value: nav }, createElement(Bridge)));
    await until('the Bridge screen', () => root.textContent.includes('Bridge'));
    await click(button(root, /→ USDT$/));
    await until('the Redeem form', () => root.textContent.includes('Your account') || root.textContent.includes('Paid'));
    await click(button(root, 'Pay another address'));
    await typeIn(field(root, /Pay USDT to/), A);
    await typeIn(field(root, 'kUSDT to redeem'), '20');
    await until('the checks', () => !button(root, 'Review').disabled);
    await click(button(root, 'Review'));
    await until('the Review', () => root.textContent.includes('You burn'));
    await toggle(checkbox(root));
    await until('Redeem to be enabled', () => !button(root, 'Redeem').disabled);
    await click(button(root, 'Redeem'));
    await until('the answer', () => root.textContent.includes('may have been sent'));
    const [a] = await listActivity(NET);
    expect(a).toMatchObject({ kind: 'redeem', chain: 'ethereum', address: A, kusdt: '20000000', status: MAYBE_SENT });
    expect(root.textContent).toContain(a.txid);
    expect(root.textContent).not.toContain('Redemption sent');
  });

  it('Send says a KAS send may have been sent, names it, and Activity has it', async () => {
    const fx = fixture('e2');
    h.wallet = fx.wallet;
    submitsTo(fx, await nodeThat('closes'));
    const { root } = await mount(createElement(Send, { onBack() {} }));
    await until('the Send screen', () => root.textContent.includes('Send'));
    await click(button(root, /^KAS/));
    await typeIn(field(root, 'kaspasim:…'), BOB);
    await typeIn(field(root, 'Amount'), '5');
    await until('Review to be enabled', () => !button(root, 'Review').disabled);
    await click(button(root, 'Review'));
    await until('the Review', () => root.textContent.includes('You send'));
    await click(button(root, 'Confirm and send'));
    await until('the answer', () => root.textContent.includes('may have been sent'));
    await flush();
    const [a] = await listActivity(NET);
    expect(a).toMatchObject({ kind: 'kas-send', counterparty: BOB, kas: '500000000', status: MAYBE_SENT });
    expect(root.textContent).toContain(a.txid);
    expect((await pendingSet(NET)).has(fx.kasOutpoint)).toBe(true);
  });
});
