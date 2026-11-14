// Run 21, Daybreak [4] (the part a browser can bound): the public resolvers' answers were read whole, with
// Response.json(), before anything looked at them. A resolver whose answer never ends (or that sends a small compressed
// body that inflates to hundreds of megabytes) filled the memory of the page or of the wallet's background, which use
// this resolver to find a node. A resolver's answer is a node's URL in a little JSON, so it is now read up to 16 KB and
// refused past that. (The node's own WebSocket answers are another matter: a browser takes a message whole, and no
// script can bound it first.)

import { afterEach, describe, expect, it, vi } from 'vitest';
import { resolveNode, resetResolverBackoff } from './node';
import { KASPA_NETWORKS } from './network';

const MAIN = KASPA_NETWORKS.mainnet;
const NODE = 'wss://emma.kaspa.stream/kaspa/mainnet/wrpc/borsh';
const CHUNK = 65_536;

/**
 * An answer of `bytes` of JSON whitespace, in pieces of `chunk`, before a valid one. `read` counts what was taken of it:
 * the stream makes a piece only when it is read (no read-ahead).
 */
function longAnswer(bytes: number, read: { bytes: number }, { chunk = CHUNK, headers }: { chunk?: number; headers?: Record<string, string> } = {}): Response {
  const spaces = new TextEncoder().encode(' '.repeat(chunk));
  let sent = 0;
  return new Response(new ReadableStream<Uint8Array>({
    pull(c) {
      if (sent >= bytes) { c.enqueue(new TextEncoder().encode(JSON.stringify({ url: NODE }))); c.close(); return; }
      c.enqueue(spaces);
      sent += chunk;
      read.bytes += chunk;
    },
  }, { highWaterMark: 0 }), { headers });
}

afterEach(() => { vi.unstubAllGlobals(); resetResolverBackoff(); });

describe('Daybreak [4]: a resolver\'s answer is read up to a bound, never whole', () => {
  it('an answer that runs on for megabytes is refused after its first kilobytes, from every resolver', async () => {
    const read = { bytes: 0 };
    vi.stubGlobal('fetch', vi.fn(async () => longAnswer(8_000_000, read)));
    await expect(resolveNode(MAIN)).rejects.toThrow(/No public Kaspa node/);
    // All 16 resolvers asked, each read stopped at its first piece: not 8 MB from any of them.
    expect(read.bytes).toBeLessThanOrEqual(16 * CHUNK);
  });

  it('one that says it is longer than the bound is not read at all', async () => {
    const read = { bytes: 0 };
    vi.stubGlobal('fetch', vi.fn(async () => longAnswer(CHUNK, read, { headers: { 'content-length': '50000000' } })));
    await expect(resolveNode(MAIN)).rejects.toThrow(/No public Kaspa node/);
    expect(read.bytes).toBe(0);
  });

  it('an honest answer, whole or in pieces, still names its node', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ uid: 'x', url: NODE }))));
    expect(await resolveNode(MAIN)).toBe('wss://emma.kaspa.stream/kaspa/mainnet/wrpc/json');
    const read = { bytes: 0 };
    resetResolverBackoff();
    vi.stubGlobal('fetch', vi.fn(async () => longAnswer(8_192, read, { chunk: 1_024 })));
    expect(await resolveNode(MAIN)).toBe('wss://emma.kaspa.stream/kaspa/mainnet/wrpc/json');
    expect(read.bytes).toBeGreaterThanOrEqual(8_192);
  });
});
