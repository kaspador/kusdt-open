// The wallet's node client against a real WebSocket server: a connection that
// goes silent (a node that stalls, or one replaced behind its address) is
// dropped on a timeout and a read is asked once more on a fresh connection;
// a transaction is never sent twice by itself.

import { afterEach, describe, expect, it } from 'vitest';
// @ts-ignore: ws ships no types, and the test needs only its server.
import { WebSocketServer } from 'ws';
import { KaspaNodeClient, NoAnswer, NodeRejected } from '@/kaspa/node';

type ServerSocket = { send(s: string): void; terminate(): void; on(e: string, f: (d: unknown) => void): void };
type Server = { once(e: string, f: () => void): void; on(e: string, f: (ws: ServerSocket) => void): void; close(f: () => void): void; address(): unknown };
const servers: Server[] = [];
const sockets: ServerSocket[] = [];
// ws waits for every client before its server closes: end them first.
afterEach(async () => {
  for (const c of sockets.splice(0)) c.terminate();
  for (const s of servers.splice(0)) await new Promise<void>((ok) => s.close(() => ok()));
});

/** A testnet-10 node; the first connection answers getServerInfo only, then goes silent. */
async function stallingNode() {
  const wss: Server = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  servers.push(wss);
  await new Promise<void>((ok) => wss.once('listening', () => ok()));
  const seen = { connections: 0, submits: 0 };
  wss.on('connection', (ws: ServerSocket) => {
    const n = ++seen.connections;
    sockets.push(ws);
    ws.on('message', (data: unknown) => {
      const msg = JSON.parse(String(data));
      if (msg.method === 'getServerInfo') {
        ws.send(JSON.stringify({ id: msg.id, params: { networkId: 'testnet-10', hasUtxoIndex: true, isSynced: true } }));
        return;
      }
      if (msg.method === 'submitTransaction') seen.submits++;
      if (n === 1) return; // silent from here on
      if (msg.method === 'getUtxosByAddresses') ws.send(JSON.stringify({ id: msg.id, params: { entries: [] } }));
    });
  });
  return { url: `ws://127.0.0.1:${(wss.address() as { port: number }).port}`, seen };
}

describe('the wallet’s node client', () => {
  it('drops a silent connection on a timeout and answers a read from a fresh one', async () => {
    const n = await stallingNode();
    const client = new KaspaNodeClient('testnet-10', n.url, 300);
    expect(await client.utxos(['kaspatest:qzuv4u0sp5tee8e09kl3h9r2yq6rpxvahvudxx0smfuyv064fx5s69ydr0acz'])).toEqual([]);
    expect(n.seen.connections).toBe(2);
  });

  it('never sends a transaction twice by itself', async () => {
    const n = await stallingNode();
    const client = new KaspaNodeClient('testnet-10', n.url, 300);
    await expect(client.submit('{"version":0}')).rejects.toThrow();
    expect(n.seen.submits).toBe(1);
  });

  /** A testnet-10 node whose answer to the first request after getServerInfo the test decides. */
  async function scriptedNode(onRequest: (ws: ServerSocket, msg: { id: number; method: string }) => void) {
    const wss: Server = new WebSocketServer({ port: 0, host: '127.0.0.1' });
    servers.push(wss);
    await new Promise<void>((ok) => wss.once('listening', () => ok()));
    const seen = { submits: 0 };
    wss.on('connection', (ws: ServerSocket) => {
      sockets.push(ws);
      ws.on('message', (data: unknown) => {
        const msg = JSON.parse(String(data));
        if (msg.method === 'getServerInfo') { ws.send(JSON.stringify({ id: msg.id, params: { networkId: 'testnet-10', hasUtxoIndex: true, isSynced: true } })); return; }
        if (msg.method === 'submitTransaction') seen.submits++;
        onRequest(ws, msg);
      });
    });
    return { url: `ws://127.0.0.1:${(wss.address() as { port: number }).port}`, seen };
  }

  it('calls a submission the node never answered "no answer", whether it went silent or closed the connection', async () => {
    const silent = await scriptedNode(() => {});
    await expect(new KaspaNodeClient('testnet-10', silent.url, 300).submit('{"version":0}')).rejects.toBeInstanceOf(NoAnswer);
    expect(silent.seen.submits).toBe(1);
    const closing = await scriptedNode(ws => ws.terminate());
    await expect(new KaspaNodeClient('testnet-10', closing.url, 2_000).submit('{"version":0}')).rejects.toBeInstanceOf(NoAnswer);
    expect(closing.seen.submits).toBe(1);
  });

  it('keeps a refusal a refusal', async () => {
    const n = await scriptedNode((ws, msg) => ws.send(JSON.stringify({ id: msg.id, method: 'submitTransaction', error: 'transaction is a double spend' })));
    const e = await new KaspaNodeClient('testnet-10', n.url, 2_000).submit('{"version":0}').catch((x: unknown) => x);
    expect(e).toBeInstanceOf(NodeRejected);
    expect(e).not.toBeInstanceOf(NoAnswer);
  });

  it("doesn't call a failure from before the request left \"no answer\": nothing went out", async () => {
    // The connection never got past the node's own greeting.
    const wss: Server = new WebSocketServer({ port: 0, host: '127.0.0.1' });
    servers.push(wss);
    await new Promise<void>((ok) => wss.once('listening', () => ok()));
    let submits = 0;
    wss.on('connection', (ws: ServerSocket) => {
      sockets.push(ws);
      ws.on('message', (data: unknown) => { if (JSON.parse(String(data)).method === 'getServerInfo') ws.terminate(); else submits++; });
    });
    const url = `ws://127.0.0.1:${(wss.address() as { port: number }).port}`;
    const e = await new KaspaNodeClient('testnet-10', url, 2_000).submit('{"version":0}').catch((x: unknown) => x);
    expect(e).toBeInstanceOf(Error);
    expect(e).not.toBeInstanceOf(NoAnswer);
    expect(submits).toBe(0);

    // And a connection that dropped before the request: the node saw nothing.
    const later = await scriptedNode((ws, msg) => { if (msg.method === 'getFeeEstimate') ws.send(JSON.stringify({ id: msg.id, params: {} })); });
    const client = new KaspaNodeClient('testnet-10', later.url, 2_000);
    await client.feerate(); // the connection is up, and stays open
    for (const c of sockets.splice(0)) c.terminate();
    await new Promise(r => setTimeout(r, 100));
    const gone = await client.submit('{"version":0}').catch((x: unknown) => x);
    expect(gone).not.toBeInstanceOf(NoAnswer);
    expect(later.seen.submits).toBe(0);
  });
});
