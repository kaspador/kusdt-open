// Round 14, R14-CL-2: the wallet read the coordinator's and the EVM RPCs' answers whole before looking at them. A
// server that streamed hundreds of megabytes within the request's time had all of it held in the popup or the
// background. Every answer is now read through a capped reader that stops past a limit.

import { describe, expect, it } from 'vitest';
import { CoordinatorClient } from '@/kusdt/api';
import { EthRpc } from '@/evm/rpc';
import { readLocalDeployment } from '@/config/local';
import { readCapped, AnswerTooLong, MAX_API_ANSWER_BYTES, MAX_RPC_ANSWER_BYTES, MAX_SMALL_ANSWER_BYTES } from '@/lib/capped-read';

const CHUNK = 1 << 20;

/** A body of `total` bytes, made only as it is read; `pulled()` says how much was. */
function endless(total: number, first = '{"states":[') {
  let sent = 0;
  const head = new TextEncoder().encode(first);
  const stream = new ReadableStream<Uint8Array>({
    pull(c) {
      if (sent >= total) { c.close(); return; }
      const n = Math.min(CHUNK, total - sent);
      const part = new Uint8Array(n).fill(0x20);
      if (sent === 0) part.set(head.subarray(0, Math.min(head.length, n)));
      sent += n;
      c.enqueue(part);
    },
  }, { highWaterMark: 0 });
  return { stream, pulled: () => sent };
}

describe('the coordinator\'s answers (R14-CL-2)', () => {
  it('stop being read past the limit, and count as no answer', async () => {
    const body = endless(4 * MAX_API_ANSWER_BYTES);
    const api = new CoordinatorClient('https://api.example', (async () => new Response(body.stream, { status: 200 })) as typeof fetch);
    await expect(api.tokens('ab'.repeat(32))).rejects.toThrow(/coordinator/i);
    expect(body.pulled()).toBeLessThanOrEqual(MAX_API_ANSWER_BYTES + CHUNK);
  });

  it('an answer that says it is too long is not read at all', async () => {
    const body = endless(4 * MAX_API_ANSWER_BYTES);
    const api = new CoordinatorClient('https://api.example', (async () => new Response(body.stream, { status: 200, headers: { 'content-length': String(4 * MAX_API_ANSWER_BYTES) } })) as typeof fetch);
    await expect(api.status()).rejects.toThrow();
    expect(body.pulled()).toBeLessThanOrEqual(CHUNK);
  });

  it('an answer within the limit is read as before', async () => {
    const api = new CoordinatorClient('https://api.example', (async () => new Response(JSON.stringify({ states: [], unread: [] }), { status: 200 })) as typeof fetch);
    expect(await api.tokens('ab'.repeat(32))).toEqual({ states: [], unread: [] });
  });
});

describe('an EVM RPC\'s answers (R14-CL-2)', () => {
  it('stop being read past the limit, at every endpoint asked', async () => {
    const bodies: ReturnType<typeof endless>[] = [];
    const fetcher = (async () => { const b = endless(4 * MAX_RPC_ANSWER_BYTES, '{"jsonrpc":"2.0","id":1,"result":"0x'); bodies.push(b); return new Response(b.stream, { status: 200 }); }) as typeof fetch;
    const rpc = new EthRpc(['https://a.example', 'https://b.example'], 1, 'Ethereum', 'ETH', fetcher);
    await expect(rpc.call('eth_call', [{ to: '0x' + '11'.repeat(20), data: '0x' }, 'latest'])).rejects.toThrow(/Could not reach/);
    expect(bodies.length).toBe(2);
    for (const b of bodies) expect(b.pulled()).toBeLessThanOrEqual(MAX_RPC_ANSWER_BYTES + CHUNK);
  });

  it('one endpoint that answers too much is passed over for the next', async () => {
    let n = 0;
    const fetcher = (async (url: string, init?: RequestInit) => {
      const { id, method } = JSON.parse(String(init?.body));
      if (url.startsWith('https://a.')) return new Response(endless(4 * MAX_RPC_ANSWER_BYTES).stream, { status: 200 });
      n++;
      return new Response(JSON.stringify({ jsonrpc: '2.0', id, result: method === 'eth_chainId' ? '0x1' : '0x2a' }), { status: 200 });
    }) as typeof fetch;
    const rpc = new EthRpc(['https://a.example', 'https://b.example'], 1, 'Ethereum', 'ETH', fetcher);
    expect(await rpc.call<string>('eth_blockNumber', [])).toBe('0x2a');
    expect(n).toBe(2);
  });
});

describe('the local stack\'s deployment (R14-CL-2)', () => {
  it('is no deployment when the answer is too long', async () => {
    const bodies: ReturnType<typeof endless>[] = [];
    const fetcher = (async () => { const b = endless(4 * MAX_SMALL_ANSWER_BYTES); bodies.push(b); return new Response(b.stream, { status: 200 }); }) as typeof fetch;
    expect(await readLocalDeployment('simnet', 'http://127.0.0.1:9300', fetcher)).toBeNull();
    // The faucet's /stack, then the coordinator's /status.
    expect(bodies.length).toBe(2);
    for (const b of bodies) expect(b.pulled()).toBeLessThanOrEqual(MAX_SMALL_ANSWER_BYTES + CHUNK);
  });
});

describe('readCapped', () => {
  it('reads text split across chunks, a character cut in two included', async () => {
    const bytes = new TextEncoder().encode('{"a":"é€"}');
    const stream = new ReadableStream<Uint8Array>({ start(c) { for (const b of bytes) c.enqueue(new Uint8Array([b])); c.close(); } });
    expect(await readCapped(new Response(stream), 100)).toBe('{"a":"é€"}');
  });

  it('allows exactly the limit and refuses one byte more', async () => {
    expect(await readCapped(new Response('x'.repeat(10)), 10)).toBe('x'.repeat(10));
    await expect(readCapped(new Response('x'.repeat(11)), 10)).rejects.toBeInstanceOf(AnswerTooLong);
  });
});
