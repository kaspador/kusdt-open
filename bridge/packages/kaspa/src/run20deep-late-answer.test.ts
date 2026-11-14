// The deep round of the second outside review of rc.22 (run 20), D2-2. An answer that arrives after its call timed out
// is waited for by nobody. A long one (past UNPARSED_FROM, within the message limit) was parsed whole all the same, on
// the one thread, and then handed to any listener of its method's name as if it were a notification: the reviewer
// measured 0.4 s of the thread and 228 MB for a 56 MB getBlocks answer. Now a long message whose id names no call that
// waits is dropped unparsed; a notification (which names no id) is read as ever. On a real socket (loopback).
import { afterEach, describe, expect, it, vi } from 'vitest';
// @ts-ignore: ws ships no types, and the test needs only its server.
import { WebSocketServer } from 'ws';

vi.mock('./exactJson', async (importOriginal) => {
  const real = await importOriginal<typeof import('./exactJson')>();
  return { ...real, parseExactJson: vi.fn(real.parseExactJson) };
});
import { parseExactJson } from './exactJson';
import { KaspaRpc, UNPARSED_FROM } from './rpc';

const servers: any[] = [];
const clients: KaspaRpc[] = [];
afterEach(async () => {
  for (const c of clients.splice(0)) c.close();
  for (const s of servers.splice(0)) { for (const ws of s.clients) ws.terminate(); await new Promise<void>((ok) => s.close(() => ok())); }
  vi.mocked(parseExactJson).mockClear();
});

/** About `mb` MB of blocks, as a getBlocks answer lists them. */
const blocks = (mb: number) => {
  const one = `{"header":{"daaScore":"1000"},"transactions":[],"verboseData":{"hash":"${'ab'.repeat(32)}"}}`;
  return `[${Array.from({ length: Math.ceil((mb * 1_000_000) / one.length) }, () => one).join(',')}]`;
};

/** A node that answers getBlocks with `mb` MB after `lateMs`, a long notification when asked to, and anything else at once. */
async function node(mb: number, lateMs: number) {
  const wss: any = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  servers.push(wss);
  await new Promise<void>((ok) => wss.once('listening', () => ok()));
  wss.on('connection', (ws: any) => ws.on('message', (data: unknown) => {
    const msg = JSON.parse(String(data));
    if (msg.method === 'getBlocks') { setTimeout(() => ws.send(`{"id":${msg.id},"method":"getBlocks","params":{"blockHashes":[],"blocks":${blocks(mb)}}}`), lateMs); return; }
    if (msg.method === 'notifyMe') { ws.send(`{"method":"blockAddedNotification","params":{"block":${blocks(mb)}}}`); return; }
    ws.send(JSON.stringify({ id: msg.id, method: msg.method, params: { virtualDaaScore: '105' } }));
  }));
  return `ws://127.0.0.1:${wss.address().port}`;
}

const longParses = () => vi.mocked(parseExactJson).mock.calls.filter(([text]) => String(text).length > UNPARSED_FROM).length;
const until = async (what: () => boolean, ms = 5_000) => { for (const end = Date.now() + ms; !what();) { if (Date.now() > end) throw new Error('waited too long'); await new Promise((r) => setTimeout(r, 10)); } };

describe('D2-2: a long answer whose call is no longer waited for is not parsed', () => {
  it('a 20 MB getBlocks answer after its call timed out is dropped unread, and the connection goes on', async () => {
    const url = await node(20, 600);
    // One timeout keeps the connection (deadAfter 2, as the money loops' connection has): the late answer arrives on it.
    const rpc = await new KaspaRpc(url, 300, { reconnect: true }).connect();
    clients.push(rpc);
    const heard = vi.fn();
    rpc.on('getBlocks', heard);
    await expect(rpc.callRaw('getBlocks', { lowHash: 'C0' })).rejects.toThrow(/getBlocks: timed out/);
    // The answer is sent 600 ms after the ask, and 20 MB take a moment on loopback.
    await new Promise((r) => setTimeout(r, 2_000));
    // On rc.24: parsed whole once, then handed to the method's listeners as if the node had sent a notification.
    expect(longParses()).toBe(0);
    expect(heard).not.toHaveBeenCalled();
    expect(rpc.lateDropped).toBe(1);
    // The connection was kept, and the next call is answered on it.
    expect((await rpc.call('getBlockDagInfo')).virtualDaaScore).toBe('105');
    expect(rpc.reconnects).toBe(0);
  }, 20_000);

  it('a short answer after its call timed out is not handed to listeners as a notification either', async () => {
    const url = await node(0.0001, 500);
    const rpc = await new KaspaRpc(url, 200, { reconnect: true }).connect();
    clients.push(rpc);
    const heard = vi.fn();
    rpc.on('getBlocks', heard);
    await expect(rpc.callRaw('getBlocks', { lowHash: 'C0' })).rejects.toThrow(/timed out/);
    await new Promise((r) => setTimeout(r, 800));
    expect(heard).not.toHaveBeenCalled();
    expect((await rpc.call('getBlockDagInfo')).virtualDaaScore).toBe('105');
  });

  it('a long answer that is waited for is still read, and a long notification still reaches its listener', async () => {
    const url = await node(3, 0);
    const rpc = await new KaspaRpc(url, 5_000, { reconnect: true }).connect();
    clients.push(rpc);
    // Waited for, with unparsedUpTo: handed back unparsed, as the followers read it.
    const raw = await rpc.callRaw('getBlocks', { lowHash: 'C0' }, { unparsedUpTo: 10_000_000 });
    expect(raw.length).toBeGreaterThan(UNPARSED_FROM);
    expect(longParses()).toBe(0);
    // Waited for, by a plain call: parsed once, as before.
    expect((await rpc.call<any>('getBlocks', { lowHash: 'C0' })).blocks.length).toBeGreaterThan(1_000);
    expect(longParses()).toBe(1);
    // A notification names no id: it is read and handed to its listeners, whatever its length.
    const added = vi.fn();
    rpc.on('blockAddedNotification', added);
    void rpc.call('notifyMe').catch(() => undefined);
    await until(() => added.mock.calls.length === 1);
    expect(rpc.lateDropped ?? 0).toBe(0);
  }, 20_000);
});
