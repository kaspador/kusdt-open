// A stand-in Kaspa node for tests, on a loopback socket: it can answer with a message of any declared length without
// ever holding it, which no WebSocket library's server does. A real node sends getUtxosByAddresses as one frame, as
// long as the coins anyone sent the address; this is how a test sends 300 MB and sees what the client keeps of it.
// Not part of the package's exports.

import { createHash } from 'node:crypto';
import { createServer, type AddressInfo, type Server, type Socket } from 'node:net';

/** What the stand-in sends for one request: a whole answer, or a long one made of `count` copies of `item` between `open` and `close`. */
export type StandInAnswer = string | { open: string; item: string; count: number; close: string } | null;

export interface StandInNode {
  url: string;
  /** Every request received, in order. */
  asked: { id: number; method: string; params: any }[];
  /** Payload bytes written to the sockets, over all connections. */
  sent: () => number;
  /** Connections opened so far. */
  connections: () => number;
  close: () => Promise<void>;
}

function frameHeader(length: number): Buffer {
  if (length < 126) return Buffer.from([0x81, length]);
  if (length < 65_536) { const h = Buffer.alloc(4); h[0] = 0x81; h[1] = 126; h.writeUInt16BE(length, 2); return h; }
  const h = Buffer.alloc(10); h[0] = 0x81; h[1] = 127; h.writeBigUInt64BE(BigInt(length), 2); return h;
}

/** `answer` decides what each request gets; null answers nothing (the call times out). */
export async function standInNode(answer: (msg: { id: number; method: string; params: any }) => StandInAnswer): Promise<StandInNode> {
  const asked: StandInNode['asked'] = [];
  const sockets = new Set<Socket>();
  let sent = 0, connections = 0;
  const server: Server = createServer((sock) => {
    connections++;
    sockets.add(sock);
    sock.on('error', () => { /* the client dropped it */ });
    sock.on('close', () => sockets.delete(sock));
    let buffered = Buffer.alloc(0), shaken = false;
    const write = (b: Buffer | string) => { sent += typeof b === 'string' ? Buffer.byteLength(b) : b.length; return sock.write(b); };
    const reply = (msg: { id: number; method: string; params: any }) => {
      const a = answer(msg);
      if (a === null) return;
      if (typeof a === 'string') { sock.write(frameHeader(Buffer.byteLength(a))); write(a); return; }
      const item = Buffer.from(a.item);
      sock.write(frameHeader(Buffer.byteLength(a.open) + a.count * item.length + Buffer.byteLength(a.close)));
      write(a.open);
      const per = Math.max(1, Math.floor(65_536 / item.length));
      const chunk = Buffer.concat(Array.from({ length: per }, () => item));
      let left = a.count;
      const pump = () => {
        while (left > 0 && !sock.destroyed) {
          const n = Math.min(left, per);
          left -= n;
          if (!write(n === per ? chunk : chunk.subarray(0, n * item.length))) { sock.once('drain', pump); return; }
        }
        if (!sock.destroyed) write(a.close);
      };
      pump();
    };
    sock.on('data', (d) => {
      buffered = Buffer.concat([buffered, d]);
      if (!shaken) {
        const end = buffered.indexOf('\r\n\r\n');
        if (end < 0) return;
        const key = /sec-websocket-key: (.+)\r\n/i.exec(buffered.subarray(0, end + 2).toString())![1].trim();
        const accept = createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
        sock.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
        shaken = true;
        buffered = buffered.subarray(end + 4);
      }
      // The client's frames: masked, and short (a request).
      for (;;) {
        if (buffered.length < 2) return;
        const opcode = buffered[0] & 0x0f;
        let length = buffered[1] & 0x7f, at = 2;
        if (length === 126) { if (buffered.length < 4) return; length = buffered.readUInt16BE(2); at = 4; }
        else if (length === 127) { if (buffered.length < 10) return; length = Number(buffered.readBigUInt64BE(2)); at = 10; }
        if (buffered.length < at + 4 + length) return;
        const mask = buffered.subarray(at, at + 4);
        const payload = Buffer.from(buffered.subarray(at + 4, at + 4 + length));
        for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i % 4];
        buffered = buffered.subarray(at + 4 + length);
        if (opcode === 8) { sock.destroy(); return; }
        if (opcode !== 1) continue;
        const msg = JSON.parse(payload.toString());
        asked.push(msg);
        reply(msg);
      }
    });
  });
  await new Promise<void>((ok) => server.listen(0, '127.0.0.1', () => ok()));
  return {
    url: `ws://127.0.0.1:${(server.address() as AddressInfo).port}`,
    asked,
    sent: () => sent,
    connections: () => connections,
    close: () => new Promise<void>((ok) => { for (const s of sockets) s.destroy(); server.close(() => ok()); }),
  };
}
