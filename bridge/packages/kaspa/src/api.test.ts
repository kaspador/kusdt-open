// Hedged requests: api.kaspa.org sometimes leaves one request hanging for a
// minute while an identical one answers at once. These pin how the client
// copes, with fetch replaced by a script of answers.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { hedged, submitTransaction, NOT_ANSWERING } from './api';
import { KASPA_NETWORKS } from './network';

type Step = 'hang' | 'neterr' | { status: number; body: unknown };

function scriptFetch(steps: Step[]) {
  const calls: { aborted: () => boolean }[] = [];
  vi.stubGlobal('fetch', vi.fn((_url: string, init: RequestInit) => {
    const step = steps[calls.length] ?? 'hang';
    const signal = init.signal!;
    calls.push({ aborted: () => signal.aborted });
    return new Promise((resolve, reject) => {
      signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
      if (step === 'hang') return;
      if (step === 'neterr') return reject(new TypeError('Failed to fetch'));
      resolve(new Response(JSON.stringify(step.body), { status: step.status }));
    });
  }));
  return calls;
}

afterEach(() => { vi.unstubAllGlobals(); });

const fast = { hedgeAt: [30, 60], deadline: 400 };

describe('hedged requests', () => {
  it('a hanging request is overtaken by the resend, which wins; the hanging one is cancelled', async () => {
    const calls = scriptFetch(['hang', { status: 200, body: { ok: 1 } }]);
    const res = await hedged('https://x/a', {}, fast);
    expect(res).toEqual({ ok: true, status: 200, data: { ok: 1 } });
    expect(calls.length).toBe(2);
    expect(calls[0].aborted()).toBe(true);
  });

  it('a fast answer needs no resend', async () => {
    const calls = scriptFetch([{ status: 200, body: [] }]);
    await hedged('https://x/a', {}, fast);
    await new Promise(r => setTimeout(r, 100));
    expect(calls.length).toBe(1);
  });

  it('gateway errors and dropped connections are retried', async () => {
    scriptFetch([{ status: 502, body: 'bad gateway' }, 'neterr', { status: 200, body: 'fine' }]);
    expect((await hedged('https://x/a', {}, fast)).data).toBe('fine');
  });

  it('a 4xx is an answer, not retried', async () => {
    const calls = scriptFetch([{ status: 400, body: { error: 'bad address' } }]);
    const res = await hedged('https://x/a', {}, fast);
    expect(res.status).toBe(400);
    expect(calls.length).toBe(1);
  });

  it('gives up with a readable message, never "signal is aborted"', async () => {
    scriptFetch(['hang', 'hang', 'hang', 'hang']);
    await expect(hedged('https://x/a', {}, fast)).rejects.toThrow(NOT_ANSWERING);
    scriptFetch(['neterr', 'neterr', 'neterr', 'neterr']);
    await expect(hedged('https://x/a', {}, fast)).rejects.toThrow('Could not connect to api.kaspa.org.');
  });
});

describe('submitting a payment', () => {
  const id = 'ab'.repeat(32);

  it('returns the id the network accepted', async () => {
    scriptFetch([{ status: 200, body: { transactionId: id } }]);
    expect(await submitTransaction(KASPA_NETWORKS.mainnet, '{}', id)).toEqual({ txid: id });
  });

  it('a resend that finds the first copy already in the mempool counts as sent', async () => {
    scriptFetch([{ status: 400, body: { error: `Rejected transaction ${id}: transaction ${id} is already in the mempool` } }]);
    expect(await submitTransaction(KASPA_NETWORKS.mainnet, '{}', id)).toEqual({ txid: id });
  });

  it('a double spend also says "already" and names the transaction: that is a refusal', async () => {
    const detail = `Rejected transaction ${id}: output ${'cd'.repeat(32)}:0 already spent by transaction ${'ef'.repeat(32)} in the mempool`;
    scriptFetch([{ status: 400, body: { error: detail } }]);
    expect(await submitTransaction(KASPA_NETWORKS.mainnet, '{}', id)).toEqual({ error: detail });
  });

  it('a real rejection is reported as an error', async () => {
    scriptFetch([{ status: 400, body: { error: 'transaction has insufficient fee' } }]);
    expect(await submitTransaction(KASPA_NETWORKS.mainnet, '{}', id)).toEqual({ error: 'transaction has insufficient fee' });
  });
});
