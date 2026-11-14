// A Kaspa wRPC JSON client for services and scripts (Node 22+ or a browser).
//
// Large integers (sompi amounts, DAA scores) are parsed exactly: every number
// with 16 or more digits arrives as a bigint-safe string.

import { parseExactJson } from './exactJson';

/**
 * Whether a node's refusal means it already has this very transaction: in its mempool, or accepted. Every refusal names
 * the transaction ("Rejected transaction <id>: ..."), and a double spend says "already" too, so only the node's own words for these two count.
 */
export function nodeHasTransaction(message: string, txid: string): boolean {
  const id = txid.toLowerCase(), said = message.toLowerCase();
  return said.includes(`transaction ${id} is already in the mempool`) || said.includes(`transaction ${id} was already accepted`);
}

/**
 * What the client needs of a socket. The platform's WebSocket has it, and so does the `ws` package's, which can also
 * refuse a message at its frame header (`terminate` is its own: it drops the connection without a closing handshake).
 */
export interface RpcSocket {
  readonly readyState: number;
  send(data: string): void;
  close(): void;
  terminate?(): void;
  onopen: ((event: any) => void) | null;
  onerror: ((event: any) => void) | null;
  onmessage: ((event: any) => void) | null;
  onclose: ((event: any) => void) | null;
}

type Pending = { ok: (v: unknown) => void; fail: (e: Error) => void; timer: ReturnType<typeof setTimeout>; raw?: boolean; ws: RpcSocket; method: string; unparsedUpTo?: number };

export interface KaspaRpcOptions {
  /**
   * Reconnect on its own: when the socket closed, or when `deadAfter` calls in a
   * row timed out. A replaced node (a container recreated, a restart) can leave
   * the old TCP connection silent rather than closed, so no close event ever
   * comes; the timeouts are how the client finds out. For long-running services.
   */
  reconnect?: boolean;
  /** Consecutive timeouts after which the socket counts as dead (default 2). */
  deadAfter?: number;
  /**
   * The longest message taken from the node, in characters (a node's JSON is ASCII, so bytes). A longer one is not
   * parsed: its call fails with RpcTooLargeError. Default MAX_MESSAGE_CHARS.
   */
  maxMessageChars?: number;
  /**
   * Opens the socket; the platform's WebSocket when absent (a browser, a script). The platform's takes a message whole,
   * whatever its length, and only then can this client look at it: a 200 MB answer cost 850 MB of memory before it was
   * refused (round 11, R11-ST-1). A service passes a socket that refuses a message past `maxFrameBytes` at its frame
   * header, before any of it is kept (bridge/services/src/shared/kaspa.ts). Such a refusal ends the connection: the
   * node goes on sending the message, and there is no other way not to take it.
   */
  socket?: (url: string) => RpcSocket;
  /** The size `socket` refuses a message at, in bytes: the limit a refused call is told. */
  maxFrameBytes?: number;
}

/**
 * The longest message parsed unless a client is told otherwise. Some answers have no bound of their own:
 * getUtxosByAddresses answers every coin at an address, with no paging, and anyone can send an address coins. Parsed, a
 * message costs many times its length in memory, on the one thread: 800,000 coins (about 290 MB) ended a service at a
 * 768 MB heap (round 10, services M1). 64 MB is about 158,000 coins (kaspad 2.1.0 writes 405 characters a coin).
 *
 * It is not a limit for every answer. getBlocks and getVirtualChainFromBlock are bounded by consensus, and the bound is
 * above this: 250 full blocks are 65 to 100 MB of JSON (18.4 MB was the longest measured on TN10, on 2026-11-10). A
 * reader of those takes them unparsed (callRaw's `unparsedUpTo`) and reads them in parts, as the services' followers do;
 * refused here, the same answer would be refused at every retry.
 */
export const MAX_MESSAGE_CHARS = 64_000_000;
/** From this length on, an answer to a raw read that takes answers unparsed (callRaw's `unparsedUpTo`) is handed back unparsed; a shorter one is checked for an error first, as every other. No error answer is this long. */
export const UNPARSED_FROM = 1_000_000;

const OPEN = 1;

export class RpcError extends Error {
  constructor(readonly method: string, message: string) { super(`${method}: ${message}`); }
}

/**
 * The node's answer was longer than the client reads: it was dropped unparsed, and asking again gets the same.
 * `chars` is null when the socket refused it at its frame header: its length was never this client's to see.
 */
export class RpcTooLargeError extends RpcError {
  constructor(method: string, readonly chars: number | null, readonly limit: number) {
    super(method, chars === null
      ? `the node's answer is over ${limit ? `the limit of ${limit} bytes` : 'the socket\'s own limit'}: refused at its first bytes, unread, and the connection it came on was dropped`
      : `the node's answer is ${chars} characters, over the limit of ${limit}: refused unread`);
  }
}

/** Whether a socket's error or close event says a message was refused for its size: the `ws` package's error code, or the close code 1009 (RFC 6455, "message too big"). */
function refusedForSize(event: any): boolean {
  return event?.code === 1009 || event?.error?.code === 'WS_ERR_UNSUPPORTED_MESSAGE_LENGTH';
}

export { parseExactJson };

/**
 * A node's URL as an error may name it: its scheme and host. A hosted node's URL holds its key (in its path, its
 * query or its user part), and this client's errors travel: into logs, a preflight's output, a wallet's screen.
 */
export function nodeHost(url: string): string {
  const m = /^([a-z][a-z0-9+.-]*:\/\/)(?:[^/?#]*@)?([^/?#]*)/i.exec(String(url));
  return m ? m[1] + m[2] : 'the address it was given';
}

export class KaspaRpc {
  private ws: RpcSocket | null = null;
  private id = 0;
  private pending = new Map<number, Pending>();
  private listeners = new Map<string, Set<(params: any) => void>>();

  private opening: Promise<void> | null = null;
  private timeouts = 0;
  private closed = false;
  /** How many times the client reconnected on its own (for logs and tests). */
  reconnects = 0;
  /** How many times the socket refused a message for its size, and the connection was dropped for it. */
  refusals = 0;
  /** How many long answers came for calls nobody waited for any more (one that timed out), and were dropped unparsed. */
  lateDropped = 0;
  /**
   * When the node last sent anything on this client's connections (ms): an answer, an error answer or a notification.
   * A monitor tells a node it cannot reach from one that answers (round 30): none of it says the answers are right.
   */
  heardAt?: number;
  private readonly refusedSockets = new WeakSet<RpcSocket>();

  constructor(readonly url: string, readonly timeoutMs = 20_000, readonly options: KaspaRpcOptions = {}) {}

  async connect(): Promise<this> {
    this.closed = false;
    await this.open();
    return this;
  }

  /** Opens a socket (one at a time); the previous one, if any, is already dropped. */
  private open(): Promise<void> {
    if (this.opening) return this.opening;
    this.opening = (async () => {
      const ws: RpcSocket = this.options.socket ? this.options.socket(this.url) : (new WebSocket(this.url) as unknown as RpcSocket);
      await new Promise<void>((ok, fail) => {
        ws.onopen = () => ok();
        ws.onerror = () => fail(new Error(`cannot reach the Kaspa node at ${nodeHost(this.url)}`));
      });
      // Any other error: a close follows, and that is where the calls fail.
      ws.onerror = (event) => { if (refusedForSize(event)) this.refused(ws); };
      ws.onmessage = (event) => this.receive(String(event.data));
      ws.onclose = (event) => {
        if (refusedForSize(event)) this.refused(ws);
        // Only this socket's calls fail; a newer socket's calls are not its business.
        for (const [id, p] of this.pending) {
          if (p.ws !== ws) continue;
          clearTimeout(p.timer);
          this.pending.delete(id);
          p.fail(new Error('the Kaspa node closed the connection'));
        }
        if (this.ws === ws) this.ws = null;
      };
      this.ws = ws;
      this.timeouts = 0;
    })().finally(() => { this.opening = null; });
    return this.opening;
  }

  /**
   * The socket refused a message for its size, at the frame header: nothing of it was kept. Which call it answered is
   * not known (the id is in the message). With one call waiting on this socket it is that call's, and it is told so by
   * name (RpcTooLargeError), as when a message is refused after it arrived. With several, none is told it was its own:
   * each fails as on a closed connection, and a caller that must know asks alone (shared/kaspa.ts does, for address
   * reads). The connection is dropped at once: the node is still sending the message, and a socket left to close
   * politely would go on receiving it. The next call opens a new one (with `reconnect`).
   */
  private refused(ws: RpcSocket): void {
    // Once per socket: its error and its close can both say so.
    if (this.refusedSockets.has(ws)) return;
    this.refusedSockets.add(ws);
    const waiting = [...this.pending].filter(([, p]) => p.ws === ws);
    const limit = this.options.maxFrameBytes ?? 0;
    for (const [id, p] of waiting) {
      clearTimeout(p.timer);
      this.pending.delete(id);
      p.fail(waiting.length === 1
        ? new RpcTooLargeError(p.method, null, limit)
        : new RpcError(p.method, `the connection was dropped: the node sent a message over ${limit ? `the limit of ${limit} bytes` : 'the socket\'s own limit'}, this call's answer or another's`));
    }
    if (this.ws === ws) this.ws = null;
    this.refusals++;
    try { if (ws.terminate) ws.terminate(); else ws.close(); } catch { /* already gone */ }
  }

  /** The open socket; with `reconnect`, a new one when the last closed or went silent. */
  private async socket(): Promise<RpcSocket> {
    if (this.ws && this.ws.readyState === OPEN) return this.ws;
    if (!this.options.reconnect || this.closed) throw new Error('not connected');
    if (this.ws) { try { this.ws.close(); } catch { /* already gone */ } this.ws = null; }
    await this.open();
    this.reconnects++;
    return this.ws!;
  }

  /** A call timed out: after `deadAfter` in a row, the socket counts as dead and the next call reconnects. */
  private timedOut(ws: RpcSocket) {
    if (++this.timeouts < (this.options.deadAfter ?? 2) || !this.options.reconnect || this.ws !== ws) return;
    this.ws = null;
    // Without a closing handshake where the socket can: an answer that comes late must not go on arriving on it.
    try { if (ws.terminate) ws.terminate(); else ws.close(); } catch { /* already gone */ }
  }

  private send(raw: boolean, method: string, params: object | string, unparsedUpTo?: number): Promise<any> {
    return this.socket().then((ws) => {
      const id = ++this.id;
      const body = typeof params === 'string' ? params : JSON.stringify(params);
      ws.send(`{"id":${id},"method":"${method}","params":${body}}`);
      return new Promise((ok, fail) => {
        const timer = setTimeout(() => { this.pending.delete(id); this.timedOut(ws); fail(new RpcError(method, 'timed out')); }, this.timeoutMs);
        this.pending.set(id, { ok: ok as (v: unknown) => void, fail, timer, raw, ws, method, unparsedUpTo });
      });
    });
  }

  private receive(text: string) {
    this.heardAt = Date.now();
    const limit = this.options.maxMessageChars ?? MAX_MESSAGE_CHARS;
    if (text.length > limit || text.length > UNPARSED_FROM) {
      // A long message is not parsed before it is known whose it is: parsing is the cost. It opens with its id, so
      // the call it answers can be found, and told why if it is refused. The connection is kept: the node did nothing
      // wrong, and the other calls' answers are still coming on it.
      // (A node that wrote the id last is read there too; with no id found, a refused call ends at its timeout.)
      const id = /^\s*\{\s*"id"\s*:\s*(\d{1,15})\s*[,}]/.exec(text.slice(0, 64)) ?? /,\s*"id"\s*:\s*(\d{1,15})\s*\}\s*$/.exec(text.slice(-64));
      const p = id ? this.pending.get(Number(id[1])) : undefined;
      // A raw read that said how much it takes unparsed gets the text as it is, and reads it in parts itself.
      const unparsed = p?.raw && p.unparsedUpTo !== undefined ? p.unparsedUpTo : undefined;
      // An answer nobody waits for any more (its call timed out): not parsed, whatever its length within the limit.
      // Parsed, it held the thread and several times its length in memory for nobody, and was then handed to the
      // listeners of its method's name as a notification (run 20, D2-2: 0.4 s and 228 MB for a 56 MB getBlocks
      // answer). A notification names no id: one within the limit is read below, as ever.
      if (id && !p) { this.lateDropped++; return; }
      if (text.length > limit && !p) return; // a notification past the limit, or an answer with no id found
      if (id && p && (unparsed !== undefined || text.length > limit)) {
        this.pending.delete(Number(id[1]));
        clearTimeout(p.timer);
        this.timeouts = 0;
        if (unparsed !== undefined && text.length <= unparsed) p.ok(text);
        else p.fail(new RpcTooLargeError(p.method, text.length, unparsed ?? limit));
        return;
      }
    }
    let msg: any;
    // An answer that isn't JSON is a broken connection: its calls fail and the next one reconnects. Thrown here it would end the process.
    try { msg = parseExactJson(text); } catch { this.ws?.close(); return; }
    if (!msg || typeof msg !== 'object') { this.ws?.close(); return; }
    if (msg.id != null && this.pending.has(msg.id)) {
      const p = this.pending.get(msg.id)!;
      this.pending.delete(msg.id);
      clearTimeout(p.timer);
      this.timeouts = 0;
      if (p.raw && !msg.error) { p.ok(text); return; }
      if (msg.error) p.fail(new RpcError(String(msg.method ?? 'call'), typeof msg.error === 'string' ? msg.error : (msg.error.message ?? JSON.stringify(msg.error))));
      else p.ok(msg.params);
      return;
    }
    // An answer whose call is gone (a short one: a long one never got this far) is no notification either.
    if (msg.id != null) return;
    if (msg.method) for (const l of this.listeners.get(msg.method) ?? []) l(msg.params);
  }

  /** `params` is either an object or a raw JSON string (for exact big integers). */
  call<T = any>(method: string, params: object | string = {}): Promise<T> {
    return this.send(false, method, params);
  }

  /**
   * Like `call`, but answers the whole raw message text (to pass node data back untouched). With `unparsedUpTo`, a
   * long answer (over UNPARSED_FROM, or over the message limit) of up to that length is handed back unparsed and
   * unchecked, and a longer one is refused: for a caller that reads it in parts (jsonArrayItems) and so never holds
   * it parsed. The message limit does not apply to such a read; `unparsedUpTo` is its limit.
   */
  callRaw(method: string, params: object | string = {}, opts: { unparsedUpTo?: number } = {}): Promise<string> {
    return this.send(true, method, params, opts.unparsedUpTo);
  }

  /** Listen for a notification method (e.g. "blockAddedNotification"). */
  on(method: string, listener: (params: any) => void): () => void {
    const set = this.listeners.get(method) ?? new Set();
    set.add(listener);
    this.listeners.set(method, set);
    return () => set.delete(listener);
  }

  /** Closes the socket for good: no call reconnects it (connect() again does). */
  close() { this.closed = true; this.ws?.close(); this.ws = null; }
}

/**
 * The raw JSON text of each item of the array under `key` (first occurrence), one at a time: a long list can be read
 * item by item without ever being held parsed. Throws when the text has no such array, or the array doesn't end.
 */
export function* jsonArrayItems(text: string, key: string): Generator<string> {
  const at = text.indexOf(`"${key}":[`);
  if (at < 0) throw new Error(`no "${key}" array in the message`);
  let depth = 0, inString = false, start = -1;
  for (let i = at + key.length + 4; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (inString) { if (c === 92) i++; else if (c === 34) inString = false; continue; }
    if (c === 34) { inString = true; if (depth === 0 && start < 0) start = i; continue; }
    if (c === 123 || c === 91) { if (depth === 0 && start < 0) start = i; depth++; continue; }
    if (c === 125 || c === 93) {
      // At depth 0 this is the array's own bracket.
      if (depth === 0) { if (start >= 0) yield text.slice(start, i).trim(); return; }
      depth--;
      continue;
    }
    if (depth > 0) continue;
    if (c === 44) { if (start >= 0) yield text.slice(start, i).trim(); start = -1; continue; }
    // A bare value (a number, true, null) starts at its first character.
    if (start < 0 && c !== 32 && c !== 10 && c !== 13 && c !== 9) start = i;
  }
  throw new Error(`unterminated "${key}" array`);
}

/** The raw JSON text of the object value under `key` (first occurrence). */
export function rawJsonObject(text: string, key: string): string {
  const at = text.indexOf(`"${key}":{`);
  if (at < 0) throw new Error(`no "${key}" object in the message`);
  let depth = 0, inString = false;
  for (let i = at + key.length + 3; i < text.length; i++) {
    const c = text[i];
    if (inString) { if (c === '\\') i++; else if (c === '"') inString = false; continue; }
    if (c === '"') inString = true;
    else if (c === '{') depth++;
    else if (c === '}' && --depth === 0) return text.slice(at + key.length + 3, i + 1);
  }
  throw new Error(`unterminated "${key}" object`);
}
