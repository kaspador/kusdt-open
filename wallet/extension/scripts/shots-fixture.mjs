// Screenshots only (scripts/shots.mjs --states): pool states the live local
// stack can't show on demand. Two proxies stand in front of the stack's
// coordinator and Kaspa node, and pass everything through, except that in
// 'paused' mode /pool names a paused copy of the pool and in 'empty' mode a
// pool never opened (no reserve); the node proxy then also reports that state's
// UTXO at its script's address, so the wallet's own verification passes. The
// scripts are the core's own (its Node build). Nothing is ever submitted
// through them: every form is only filled in and photographed.

import http from 'node:http';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { WebSocketServer, WebSocket } = require('ws'); // the repo root's copy
const core = require('../../../bridge/packages/core/pkg-node/kusdt_wasm.js');

// ── Kaspa addresses (cashaddr-style bech32, as rusty-kaspa encodes them) ──────
const CHARSET = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';
function polymod(values) {
  let c = 1n;
  for (const d of values) {
    const c0 = c >> 35n;
    c = ((c & 0x07ffffffffn) << 5n) ^ BigInt(d);
    if (c0 & 0x01n) c ^= 0x98f2bc8e61n;
    if (c0 & 0x02n) c ^= 0x79b76d99e2n;
    if (c0 & 0x04n) c ^= 0xf33e5fb3c4n;
    if (c0 & 0x08n) c ^= 0xae2eabe2a8n;
    if (c0 & 0x10n) c ^= 0x1e4f43e470n;
  }
  return c ^ 1n;
}
function to5(bytes) {
  const out = []; let acc = 0, bits = 0;
  for (const b of bytes) { acc = (acc << 8) | b; bits += 8; while (bits >= 5) { bits -= 5; out.push((acc >> bits) & 31); } }
  if (bits > 0) out.push((acc << (5 - bits)) & 31);
  return out;
}
export function p2shAddress(prefix, spkHex) {
  const m = /^0000aa20([0-9a-f]{64})87$/.exec(spkHex);
  if (!m) throw new Error('not a P2SH script');
  const data = to5([8, ...Buffer.from(m[1], 'hex')]);
  const pm = polymod([...[...prefix].map(c => c.charCodeAt(0) & 31), 0, ...data, 0, 0, 0, 0, 0, 0, 0, 0]);
  const sum = []; for (let i = 0; i < 8; i++) sum.push(Number((pm >> BigInt(5 * (7 - i))) & 31n));
  return `${prefix}:${[...data, ...sum].map(d => CHARSET[d]).join('')}`;
}

const scriptOf = (actor, state) => {
  const a = JSON.parse(core.run('script', JSON.stringify({ actor, state })));
  if (!a.scriptPublicKey) throw new Error(`core script: ${JSON.stringify(a)}`);
  return a.scriptPublicKey;
};
const num = (v) => BigInt(String(v));

/** One request on the real node, for the self-check. */
function nodeCall(url, method, params) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const t = setTimeout(() => { ws.terminate(); reject(new Error('node timeout')); }, 8_000);
    ws.on('open', () => ws.send(JSON.stringify({ id: 1, method, params })));
    ws.on('message', (m) => { const d = JSON.parse(String(m)); if (d.id === 1) { clearTimeout(t); ws.close(); resolve(d.params); } });
    ws.on('error', (e) => { clearTimeout(t); reject(e); });
  });
}

/**
 * Starts both proxies. `fx.mode` ('real' | 'paused' | 'empty') picks what /pool shows.
 * Answers null when the self-check fails (the address encoding, against the real pool on the node).
 */
export async function startFixture({ api, node, prefix, poolId }) {
  const apiBase = new URL(api);
  const real = await (await fetch(`${api}/pool`)).json();
  const realSpk = real.pool.utxo.scriptPublicKey;
  const found = await nodeCall(node, 'getUtxosByAddresses', { addresses: [p2shAddress(prefix, realSpk)] }).catch(() => null);
  if (!found?.entries?.some((e) => e.outpoint?.transactionId === real.pool.utxo.transactionId)) return null;

  const fx = { mode: 'real', apiUrl: '', nodeUrl: '', close: () => {} };
  const fake = { paused: null, empty: null };
  const make = (state, txid) => {
    const spk = scriptOf('Pool', state);
    const amount = num(state.baseValue) + num(state.kasReserve) + num(state.protocolKas);
    return { state, txid, spk, address: p2shAddress(prefix, spk), amount };
  };
  const refresh = async () => {
    const p = (await (await fetch(`${api}/pool`)).json());
    fake.paused = { ...make({ ...p.pool.state, paused: true }, 'f1'.repeat(32)), reserve: p.reserve };
    fake.empty = make({ ...p.pool.state, kasReserve: 0, tokenReserve: 0, totalShares: 0, protocolKas: 0, protocolTokens: 0, windowStart: 0, windowRef: 0, windowOut: 0, paused: false }, 'f2'.repeat(32));
  };
  await refresh();
  const current = () => (fx.mode === 'paused' ? fake.paused : fx.mode === 'empty' ? fake.empty : null);

  const apiServer = http.createServer(async (q, r) => {
    try {
      const path = q.url.replace(/^\/api\/v1/, '');
      const f = current();
      if (q.method === 'GET' && /^\/pool(\?|$)/.test(path) && f) {
        const pool = { utxo: { transactionId: f.txid, index: 0, amount: Number(f.amount), scriptPublicKey: f.spk, covenantId: poolId }, state: f.state };
        const reserve = fx.mode === 'paused' ? f.reserve : null;
        r.setHeader('content-type', 'application/json');
        r.end(JSON.stringify({ pool, reserve, pending: [], confirmed: { pool, reserve }, paused: f.state.paused }));
        return;
      }
      const body = await new Promise((ok) => { const c = []; q.on('data', (d) => c.push(d)); q.on('end', () => ok(Buffer.concat(c))); });
      const up = await fetch(`${apiBase.origin}${apiBase.pathname.replace(/\/+$/, '')}${path}`, { method: q.method, headers: q.headers['content-type'] ? { 'content-type': q.headers['content-type'] } : {}, body: q.method === 'GET' ? undefined : body });
      r.statusCode = up.status;
      r.setHeader('content-type', up.headers.get('content-type') ?? 'application/json');
      r.end(Buffer.from(await up.arrayBuffer()));
    } catch (e) { r.statusCode = 502; r.end(JSON.stringify({ error: String(e) })); }
  });
  await new Promise((ok) => apiServer.listen(0, '127.0.0.1', ok));

  const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  wss.on('connection', (client) => {
    const upstream = new WebSocket(node);
    const queue = [];
    /** Request ids of getUtxosByAddresses that asked for the fake pool's address. */
    const inject = new Map();
    upstream.on('open', () => { for (const m of queue.splice(0)) upstream.send(m); });
    client.on('message', (m) => {
      const text = String(m);
      const f = current();
      if (f && text.includes('"getUtxosByAddresses"') && text.includes(f.address)) {
        const id = /"id":\s*(\d+)/.exec(text)?.[1];
        if (id) inject.set(id, f);
      }
      if (upstream.readyState === WebSocket.OPEN) upstream.send(text); else queue.push(text);
    });
    upstream.on('message', (m) => {
      let text = String(m);
      const id = /^\{"id":\s*(\d+)/.exec(text)?.[1] ?? /"id":\s*(\d+)/.exec(text)?.[1];
      const f = id ? inject.get(id) : null;
      if (f) {
        inject.delete(id);
        // Inserted as text, so the node's own big integers stay exact.
        const entry = JSON.stringify({ address: f.address, outpoint: { transactionId: f.txid, index: 0 }, utxoEntry: { amount: f.amount.toString(), scriptPublicKey: f.spk, blockDaaScore: '1', isCoinbase: false, covenantId: poolId } });
        text = text.replace(/"entries":\s*\[(\s*\])?/, (all, empty) => (empty ? `"entries":[${entry}]` : `"entries":[${entry},`));
      }
      client.send(text);
    });
    const end = () => { try { client.close(); } catch { /* gone */ } try { upstream.close(); } catch { /* gone */ } };
    client.on('close', end); upstream.on('close', end); upstream.on('error', end); client.on('error', end);
  });
  await new Promise((ok) => wss.on('listening', ok));

  fx.apiUrl = `http://127.0.0.1:${apiServer.address().port}/api/v1`;
  fx.nodeUrl = `ws://127.0.0.1:${wss.address().port}`;
  fx.refresh = refresh;
  fx.close = () => { apiServer.close(); wss.close(); };
  return fx;
}
