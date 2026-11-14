// The wRPC client against a real WebSocket server: it reconnects when the node
// closes the connection, and when the connection goes silent (a replaced node
// container leaves the old TCP connection open but dead, so no close event
// comes). Without `reconnect`, it never reconnects on its own.

import { afterEach, describe, expect, it } from 'vitest';
// @ts-ignore: ws ships no types, and the test needs only its server and its client's size limit.
import { WebSocket as WsClient, WebSocketServer } from 'ws';
import { standInNode } from './rpc.stand-in';
type ServerSocket = { send(s: string): void; terminate(): void; on(e: string, f: (d: unknown) => void): void };
type Server = { once(e: string, f: () => void): void; on(e: string, f: (ws: ServerSocket) => void): void; close(f: () => void): void; address(): unknown };
import { KaspaRpc, MAX_MESSAGE_CHARS, RpcError, RpcTooLargeError, jsonArrayItems, nodeHost, type RpcSocket } from './rpc';

const servers: Server[] = [];
afterEach(async () => { for (const s of servers.splice(0)) await new Promise<void>((ok) => s.close(() => ok())); });

/** A tiny node: answers getBlockDagInfo with `daa`; `silent` swallows every request. */
async function node(port = 0, daa = '100') {
  const wss: Server = new WebSocketServer({ port, host: '127.0.0.1' });
  servers.push(wss);
  await new Promise<void>((ok) => wss.once('listening', () => ok()));
  const state = { silent: false, daa, sockets: [] as ServerSocket[] };
  wss.on('connection', (ws: ServerSocket) => {
    state.sockets.push(ws);
    ws.on('message', (data: unknown) => {
      if (state.silent) return;
      const msg = JSON.parse(String(data));
      ws.send(JSON.stringify({ id: msg.id, method: msg.method, params: { virtualDaaScore: state.daa } }));
    });
  });
  const url = `ws://127.0.0.1:${(wss.address() as { port: number }).port}`;
  return { wss, state, url, port: (wss.address() as { port: number }).port };
}

const daaOf = async (rpc: KaspaRpc) => (await rpc.call('getBlockDagInfo')).virtualDaaScore;

describe('the wRPC client', () => {
  it('reconnects after the node closes the connection (a restart)', async () => {
    const n = await node();
    const rpc = await new KaspaRpc(n.url, 1_000, { reconnect: true }).connect();
    expect(await daaOf(rpc)).toBe('100');
    for (const s of n.state.sockets) s.terminate();
    await new Promise((r) => setTimeout(r, 50));
    n.state.daa = '101';
    expect(await daaOf(rpc)).toBe('101');
    expect(rpc.reconnects).toBe(1);
    rpc.close();
  });

  it('reconnects when the connection goes silent: two timeouts in a row, then a new socket', async () => {
    const n = await node();
    const rpc = await new KaspaRpc(n.url, 300, { reconnect: true }).connect();
    expect(await daaOf(rpc)).toBe('100');
    // The old connection stays open but answers nothing, like a socket to a node that was replaced.
    n.state.silent = true;
    await expect(daaOf(rpc)).rejects.toThrow(/timed out/);
    await expect(daaOf(rpc)).rejects.toThrow(/timed out/);
    // The node is back (the new container): new connections are answered again.
    n.state.silent = false;
    n.state.daa = '102';
    expect(await daaOf(rpc)).toBe('102');
    expect(rpc.reconnects).toBe(1);
    expect(n.state.sockets.length).toBe(2);
    rpc.close();
  });

  it('one timeout alone keeps the connection', async () => {
    const n = await node();
    const rpc = await new KaspaRpc(n.url, 300, { reconnect: true }).connect();
    n.state.silent = true;
    await expect(daaOf(rpc)).rejects.toThrow(/timed out/);
    n.state.silent = false;
    expect(await daaOf(rpc)).toBe('100');
    expect(rpc.reconnects).toBe(0);
    rpc.close();
  });

  it('waits for a node that is down, then reconnects once it is back on the same address', async () => {
    const n = await node();
    const rpc = await new KaspaRpc(n.url, 500, { reconnect: true }).connect();
    for (const s of n.state.sockets) s.terminate();
    await new Promise<void>((ok) => n.wss.close(() => ok()));
    servers.splice(servers.indexOf(n.wss), 1);
    await new Promise((r) => setTimeout(r, 50));
    await expect(daaOf(rpc)).rejects.toThrow(/cannot reach/);
    const again = await node(n.port, '103');
    expect(again.url).toBe(n.url);
    expect(await daaOf(rpc)).toBe('103');
    rpc.close();
  });

  // Round 10, services M1: getUtxosByAddresses answers every coin at an address, and anyone can send an address coins.
  it('an answer over the limit is refused unparsed with a clear error, and the connection goes on', async () => {
    const n = await node();
    const rpc = await new KaspaRpc(n.url, 1_000, { reconnect: true, maxMessageChars: 10_000 }).connect();
    n.state.daa = '7'.repeat(20_000);
    const refused = await rpc.call('getUtxosByAddresses').catch((e) => e);
    expect(refused).toBeInstanceOf(RpcTooLargeError);
    expect(refused.message).toMatch(/^getUtxosByAddresses: the node's answer is 2\d{4} characters, over the limit of 10000/);
    expect(refused.limit).toBe(10_000);
    // The raw read (getBlocks) is held to it as well.
    await expect(rpc.callRaw('getBlocks')).rejects.toBeInstanceOf(RpcTooLargeError);
    // Refused at once, not at the timeout, and on the same socket: the next answer is read as before.
    n.state.daa = '104';
    expect(await daaOf(rpc)).toBe('104');
    expect(rpc.reconnects).toBe(0);
    rpc.close();
  });

  it('a raw read that asks for it is handed a longer answer unparsed, up to what it asked for', async () => {
    const n = await node();
    const rpc = await new KaspaRpc(n.url, 1_000, { reconnect: true, maxMessageChars: 10_000 }).connect();
    n.state.daa = '7'.repeat(20_000);
    const raw = await rpc.callRaw('getUtxosByAddresses', {}, { unparsedUpTo: 50_000 });
    expect(raw.length).toBeGreaterThan(20_000);
    expect(raw.startsWith('{"id":')).toBe(true);
    n.state.daa = '7'.repeat(60_000);
    const refused = await rpc.callRaw('getUtxosByAddresses', {}, { unparsedUpTo: 50_000 }).catch((e) => e);
    expect(refused).toBeInstanceOf(RpcTooLargeError);
    expect(refused.limit).toBe(50_000);
    // A parsed call is never handed more than the limit, whatever it asks.
    await expect(rpc.call('getUtxosByAddresses')).rejects.toBeInstanceOf(RpcTooLargeError);
    rpc.close();
  });

  it('a list is read item by item from the raw text', () => {
    const items = (text: string) => [...jsonArrayItems(text, 'entries')];
    expect(items('{"id":1,"params":{"entries":[]}}')).toEqual([]);
    expect(items('{"params":{"entries":[{"a":1}]},"id":1}')).toEqual(['{"a":1}']);
    const tricky = ['{"a":"],}\\"[{","b":[1,[2,{"c":"}"}]]}', '7', '"x,]y"', '[1,2]', 'null', '{"d":{"e":[]}}'];
    expect(items(`{"params":{"entries":[${tricky.join(' , ')}],"after":[9]}}`)).toEqual(tricky);
    expect(items(`{"entries":[${tricky.join(',')}]}`).map((t) => JSON.parse(t))).toEqual(tricky.map((t) => JSON.parse(t)));
    expect(() => items('{"params":{}}')).toThrow(/no "entries" array/);
    expect(() => items('{"params":{"entries":[{"a":1},{"b":')).toThrow(/unterminated/);
  });

  it('the default limit is far above an honest answer', async () => {
    expect(MAX_MESSAGE_CHARS).toBeGreaterThanOrEqual(4 * 14_000_000);
    const n = await node();
    const rpc = await new KaspaRpc(n.url, 5_000).connect();
    n.state.daa = '7'.repeat(1_000_000);
    expect((await daaOf(rpc)).length).toBe(1_000_000);
    rpc.close();
  });

  // Round 11, R11-ST-1: the limit above is looked at once the whole message is a string in memory. A socket that
  // refuses a message at its frame header never holds it.
  describe('with a socket that refuses a long message at its first bytes', () => {
    const LIMIT = 1_000_000;
    const bounded = (url: string) => new WsClient(url, { maxPayload: LIMIT, perMessageDeflate: false }) as unknown as RpcSocket;
    const coin = `{"outpoint":{"transactionId":"${'ab'.repeat(32)}","index":0},"utxoEntry":{"amount":10000000,"scriptPublicKey":"0000${'cd'.repeat(35)}","blockDaaScore":123456789,"isCoinbase":false}},`;
    /** Answers getUtxosByAddresses with `coins` coins in one frame, and anything else at once. */
    const flooded = (coins: number) => standInNode((msg) => (msg.method === 'getUtxosByAddresses'
      ? { open: `{"id":${msg.id},"method":"getUtxosByAddresses","params":{"entries":[`, item: coin, count: coins, close: '{}]}}' }
      : `{"id":${msg.id},"method":"${msg.method}","params":{"virtualDaaScore":"105"}}`));

    it('a 300 MB answer is refused unread: the call is told why, the memory stays where it was, and the next call gets a new connection', async () => {
      const coins = Math.ceil(300_000_000 / coin.length);
      const n = await flooded(coins);
      const rpc = await new KaspaRpc(n.url, 20_000, { reconnect: true, socket: bounded, maxFrameBytes: LIMIT }).connect();
      expect(await daaOf(rpc)).toBe('105');
      const before = process.memoryUsage().rss;
      let peak = before;
      const sampling = setInterval(() => { peak = Math.max(peak, process.memoryUsage().rss); }, 5);
      const refused = await rpc.callRaw('getUtxosByAddresses', { addresses: ['kaspatest:qflooded'] }, { unparsedUpTo: 400_000_000 }).catch((e) => e);
      // The stand-in goes on writing until its socket is gone: what the client kept of that is what is measured.
      await new Promise((r) => setTimeout(r, 300));
      clearInterval(sampling);
      expect(refused).toBeInstanceOf(RpcTooLargeError);
      expect(refused.chars).toBe(null);
      expect(refused.limit).toBe(LIMIT);
      expect(refused.message).toMatch(/^getUtxosByAddresses: the node's answer is over the limit of 1000000 bytes: refused at its first bytes/);
      // Held whole, this message is 300 MB as bytes and as much again as a string.
      expect(peak - before).toBeLessThan(100_000_000);
      // The node was cut off long before it had sent it all.
      expect(n.sent()).toBeLessThan(coins * coin.length);
      expect(rpc.refusals).toBe(1);
      expect(await daaOf(rpc)).toBe('105');
      expect(rpc.reconnects).toBe(1);
      expect(n.connections()).toBe(2);
      rpc.close();
      await n.close();
    }, 30_000);

    it('with two calls waiting, neither is told the long answer was its own', async () => {
      const n = await standInNode((msg) => (msg.method === 'getUtxosByAddresses'
        ? { open: `{"id":${msg.id},"params":{"entries":[`, item: coin, count: 10_000, close: '{}]}}' }
        : null));
      const rpc = await new KaspaRpc(n.url, 5_000, { reconnect: true, socket: bounded, maxFrameBytes: LIMIT }).connect();
      const [silent, long] = await Promise.all([rpc.call('getBlockDagInfo').catch((e) => e), rpc.call('getUtxosByAddresses').catch((e) => e)]);
      for (const e of [silent, long]) {
        expect(e).toBeInstanceOf(RpcError);
        expect(e).not.toBeInstanceOf(RpcTooLargeError);
        expect(e.message).toMatch(/the connection was dropped: the node sent a message over the limit of 1000000 bytes/);
      }
      rpc.close();
      await n.close();
    });

    it('an answer within the socket\'s limit is read as ever, and the limits on its length still hold', async () => {
      const n = await flooded(2_000);
      const rpc = await new KaspaRpc(n.url, 5_000, { reconnect: true, socket: bounded, maxFrameBytes: LIMIT, maxMessageChars: 100_000 }).connect();
      const raw = await rpc.callRaw('getUtxosByAddresses', {}, { unparsedUpTo: LIMIT });
      expect([...jsonArrayItems(raw, 'entries')].length).toBe(2_001);
      // Past the message limit, within the socket's: refused once it has arrived, as before, and the connection is kept.
      const refused = await rpc.call('getUtxosByAddresses').catch((e) => e);
      expect(refused).toBeInstanceOf(RpcTooLargeError);
      expect(refused.chars).toBeGreaterThan(100_000);
      expect(rpc.reconnects).toBe(0);
      rpc.close();
      await n.close();
    });
  });

  it('without reconnect it never reconnects, and close() is final', async () => {
    const n = await node();
    const plain = await new KaspaRpc(n.url, 300).connect();
    for (const s of n.state.sockets) s.terminate();
    await new Promise((r) => setTimeout(r, 50));
    await expect(daaOf(plain)).rejects.toThrow(/not connected/);
    const r = await new KaspaRpc(n.url, 300, { reconnect: true }).connect();
    r.close();
    await expect(daaOf(r)).rejects.toThrow(/not connected/);
  });
});

// Round 12 (R12-SVC-4): the client named a node it could not reach by its whole URL, and a hosted node's URL holds
// its key. That text is a service's last words when its node is not there, and a line of an operator's preflight.
describe('a node that cannot be reached is named by its scheme and host', () => {
  it('nodeHost cuts the path, the query and the user part, and keeps the port', () => {
    expect(nodeHost('wss://kaspa.provider.example/KEY/wrpc?token=T')).toBe('wss://kaspa.provider.example');
    expect(nodeHost('wss://user:pass@kaspa.provider.example:17110/x#y')).toBe('wss://kaspa.provider.example:17110');
    expect(nodeHost('ws://kaspad:16110')).toBe('ws://kaspad:16110');
    expect(nodeHost('ws://[fd00::7]:16110/x')).toBe('ws://[fd00::7]:16110');
    expect(nodeHost('no url at all, with a key in it')).toBe('the address it was given');
  });

  it('the connect error says the host and nothing after it', async () => {
    const refusing = (): RpcSocket => { const ws: any = { readyState: 3, send() {}, close() {} }; setTimeout(() => ws.onerror?.({}), 0); return ws; };
    const failed = await new KaspaRpc('wss://kaspa.provider.example/KEY/wrpc?token=T', 500, { socket: refusing }).connect().catch((e) => e);
    expect(failed.message).toBe('cannot reach the Kaspa node at wss://kaspa.provider.example');
  });
});
