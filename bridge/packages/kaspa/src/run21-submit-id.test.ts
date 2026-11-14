// Run 21, outside review (Daybreak [49]): submitPayment takes no other transaction's id for this payment's. It returned
// whatever id the node, or api.kaspa.org after it, answered with, so an endpoint could report another transaction as
// sent while it dropped this one. An answer naming another id is refused now, as kUSDT Wallet's own submissions
// (wallet/extension kusdt/submit.ts, kaspa/kas.ts) refuse it; the payment's own id, and a resend the node already
// holds, still count as sent. Through the real node and REST clients, against a scripted node and fetch. Since the
// round-2 follow-up the two clients refuse such an answer themselves (nodeSubmit, submitTransaction). Since round 2's
// review submitTransaction refuses it as it refuses everything else, with {error} and no id, rather than throwing:
// submitPayment, which answers with it, never threw before.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { submitPayment } from './wallet';
import { closeNode, nodeSubmit, resetResolverBackoff } from './node';
import { submitTransaction } from './api';
import { KASPA_NETWORKS } from './network';
import { p2pkScript, toRpcTransactionJson, toSubmitJson, transactionId, type KaspaTx } from './tx';

const MAIN = KASPA_NETWORKS.mainnet;
const script = p2pkScript(new Uint8Array(32).fill(1));
const tx: KaspaTx = {
  version: 0, lockTime: 0n, subnetworkId: new Uint8Array(20), gas: 0n, payload: new Uint8Array(0),
  inputs: [{ txid: 'ab'.repeat(32), index: 0, sequence: 0n, sigOpCount: 1, signatureScript: new Uint8Array(66), utxo: { amount: 500_000_000n, script } }],
  outputs: [{ amount: 100_000_000n, script }],
};
const OURS = transactionId(tx);
const OTHER = 'cd'.repeat(32);

/** The node's answer to submitTransaction; null: no node is reachable (every resolver is down). */
let node: { transactionId: string } | { error: { message: string } } | null;
/** api.kaspa.org's answer to POST /transactions. */
let rest: { status: number; body: unknown };

class FakeWebSocket {
  static OPEN = 1;
  readyState = 0;
  onopen: (() => void) | null = null;
  onmessage: ((m: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(readonly url: string) {
    setTimeout(() => { this.readyState = 1; this.onopen?.(); }, 0);
  }
  send(text: string) {
    const msg = JSON.parse(text);
    const answer = msg.method === 'getServerInfo'
      ? { params: { isSynced: true, hasUtxoIndex: true, networkId: 'mainnet', virtualDaaScore: 1 } }
      : node !== null && 'error' in node ? { error: node.error } : { params: { transactionId: node?.transactionId } };
    setTimeout(() => this.onmessage?.({ data: JSON.stringify({ id: msg.id, method: msg.method, ...answer }) }), 0);
  }
  close() { this.readyState = 3; this.onclose?.(); }
}

beforeEach(() => {
  closeNode();
  resetResolverBackoff();
  vi.stubGlobal('WebSocket', FakeWebSocket);
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (url.endsWith('/transactions')) return new Response(JSON.stringify(rest.body), { status: rest.status });
    if (node === null) throw new TypeError('Failed to fetch');
    return new Response(JSON.stringify({ url: 'wss://emma.kaspa.stream/kaspa/mainnet/wrpc/borsh' }));
  }));
});
afterEach(() => { closeNode(); vi.unstubAllGlobals(); });

describe('Daybreak [49]: submitPayment', () => {
  it('a node that answers with another transaction id is not taken at its word: api.kaspa.org is asked, and names it', async () => {
    node = { transactionId: OTHER };
    rest = { status: 200, body: { transactionId: OURS } };
    expect(await submitPayment(MAIN, tx, OURS)).toEqual({ txid: OURS });
  });

  it('a node and api.kaspa.org that both answer with another transaction id leave no id at all', async () => {
    node = { transactionId: OTHER };
    rest = { status: 200, body: { transactionId: OTHER } };
    const answer = await submitPayment(MAIN, tx, OURS);
    expect(answer.txid).toBeUndefined();
    expect(answer.error).toMatch(new RegExp(`api\\.kaspa\\.org answered with transaction ${OTHER}, not this payment's ${OURS}.*check Activity`));
  });

  it('nor is api.kaspa.org, when no node can be reached', async () => {
    node = null;
    rest = { status: 200, body: { transactionId: OTHER } };
    const answer = await submitPayment(MAIN, tx, OURS);
    expect(answer.txid).toBeUndefined();
    expect(answer.error).toContain(OTHER);
  });

  it("the payment's own id is sent, from the node or from api.kaspa.org, as is a resend already in the mempool", async () => {
    node = { transactionId: OURS };
    expect(await submitPayment(MAIN, tx, OURS)).toEqual({ txid: OURS });
    closeNode();
    node = null;
    rest = { status: 200, body: { transactionId: OURS } };
    expect(await submitPayment(MAIN, tx, OURS)).toEqual({ txid: OURS });
    rest = { status: 400, body: { error: `Rejected transaction ${OURS}: transaction ${OURS} is already in the mempool` } };
    expect(await submitPayment(MAIN, tx, OURS)).toEqual({ txid: OURS });
  });

  it("a node's refusal stays an answer, not a throw", async () => {
    node = { error: { message: 'transaction has insufficient fee' } };
    expect(await submitPayment(MAIN, tx, OURS)).toEqual({ error: 'transaction has insufficient fee' });
  });
});

describe('the two clients refuse an answer naming another transaction themselves', () => {
  it('nodeSubmit', async () => {
    node = { transactionId: OTHER };
    await expect(nodeSubmit(MAIN, toRpcTransactionJson(tx), OURS)).rejects.toThrow(OTHER);
    closeNode();
    node = { transactionId: OURS };
    expect(await nodeSubmit(MAIN, toRpcTransactionJson(tx), OURS)).toBe(OURS);
  });

  it('submitTransaction (api.kaspa.org), with an answer and no id, as for every other failure', async () => {
    rest = { status: 200, body: { transactionId: OTHER } };
    const answer = await submitTransaction(MAIN, toSubmitJson(tx), OURS);
    expect(answer.txid).toBeUndefined();
    expect(answer.error).toContain(OTHER);
    rest = { status: 200, body: { transactionId: OURS } };
    expect(await submitTransaction(MAIN, toSubmitJson(tx), OURS)).toEqual({ txid: OURS });
  });
});
