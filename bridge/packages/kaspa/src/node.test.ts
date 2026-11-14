// The public-node client, against a scripted fake node and resolver.
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { parseExact, resolveNode, nodeUtxos, nodeSubmit, nodeFeerate, closeNode, RpcError } from './node';
import { toRpcTransactionJson, p2pkScript, type KaspaTx } from './tx';
import { KASPA_NETWORKS } from './network';
import { scriptForAddress } from './address';
import { bytesToHex, hexToBytes } from './bytes';

const MAIN = KASPA_NETWORKS.mainnet;
const ADDR = 'kaspa:qqd6e65yefepe9wk0m9vuxdufxd80sphy67gwwd0vdaumzdt4tc9s3qt0lqeh';
const SPK = '0000' + bytesToHex(scriptForAddress(ADDR, 'kaspa').script);

// ── Fake node ───────────────────────────────────────────────────────────────
type Handler = (method: string, params: unknown) => { params?: unknown; error?: { message: string } } | 'silence';
let handler: Handler;
let opened: string[] = [];

class FakeWebSocket {
  static OPEN = 1;
  readyState = 0;
  onopen: (() => void) | null = null;
  onmessage: ((m: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(readonly url: string) {
    opened.push(url);
    setTimeout(() => { this.readyState = 1; this.onopen?.(); }, 0);
  }
  send(text: string) {
    const msg = JSON.parse(text);
    const out = handler(msg.method, msg.params);
    if (out === 'silence') return;
    // Answer with raw JSON so large integers arrive the way a real node sends them.
    const body = out.error ? `"error":${JSON.stringify(out.error)}` : `"params":${typeof out.params === 'string' ? out.params : JSON.stringify(out.params)}`;
    setTimeout(() => this.onmessage?.({ data: `{"id":${msg.id},"method":"${msg.method}",${body}}` }), 0);
  }
  close() { this.readyState = 3; this.onclose?.(); }
}

const synced = { isSynced: true, hasUtxoIndex: true, networkId: 'mainnet', virtualDaaScore: 558854638 };

beforeEach(() => {
  opened = [];
  closeNode();
  vi.stubGlobal('WebSocket', FakeWebSocket);
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ uid: 'x', url: 'wss://emma.kaspa.stream/kaspa/mainnet/wrpc/borsh' }))));
});
afterEach(() => { closeNode(); vi.unstubAllGlobals(); });

describe('kaspa public node client', () => {
  it('keeps amounts above 2^53 exact', () => {
    const d = parseExact('{"entries":[{"utxoEntry":{"amount":59233354240377323,"blockDaaScore":106797089}}],"virtualDaaScore":558854638}') as {
      entries: { utxoEntry: { amount: string; blockDaaScore: number } }[]; virtualDaaScore: number };
    expect(d.entries[0].utxoEntry.amount).toBe('59233354240377323');
    expect(d.entries[0].utxoEntry.blockDaaScore).toBe(106797089);
  });

  it('asks a resolver for a node and uses its JSON endpoint; refuses hosts outside the node network', async () => {
    expect(await resolveNode(MAIN)).toBe('wss://emma.kaspa.stream/kaspa/mainnet/wrpc/json');
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ url: 'wss://evil.example.com/kaspa/mainnet/wrpc/borsh' }))));
    await expect(resolveNode(MAIN)).rejects.toThrow(/No public Kaspa node/);
  });

  it('reads coins exactly and checks each script against its address', async () => {
    handler = (m) => m === 'getServerInfo' ? { params: synced } : {
      params: `{"entries":[{"address":"${ADDR}","outpoint":{"index":1,"transactionId":"${'ab'.repeat(32)}"},"utxoEntry":{"amount":59233354240377323,"blockDaaScore":558844801,"covenantId":null,"isCoinbase":false,"scriptPublicKey":"${SPK}"}}]}`,
    };
    const [u] = await nodeUtxos(MAIN, [ADDR]);
    expect(u.amount).toBe(59233354240377323n);
    expect(u.index).toBe(1);
    expect(bytesToHex(u.script.script)).toBe(SPK.slice(4));
    expect(opened).toEqual(['wss://emma.kaspa.stream/kaspa/mainnet/wrpc/json']);

    closeNode();
    const other = '0000' + bytesToHex(p2pkScript(new Uint8Array(32).fill(5)).script);
    handler = (m) => m === 'getServerInfo' ? { params: synced } : {
      params: { entries: [{ address: ADDR, outpoint: { index: 0, transactionId: 'cd'.repeat(32) }, utxoEntry: { amount: 5, blockDaaScore: 1, isCoinbase: false, scriptPublicKey: other } }] },
    };
    await expect(nodeUtxos(MAIN, [ADDR])).rejects.toThrow(/does not match its address/);
  });

  it('will not use a node that is unsynced, without a UTXO index, or on another network', async () => {
    for (const bad of [{ ...synced, isSynced: false }, { ...synced, hasUtxoIndex: false }, { ...synced, networkId: 'testnet-10' }]) {
      closeNode();
      handler = (m) => m === 'getServerInfo' ? { params: bad } : { params: { estimate: { normalBuckets: [{ feerate: 100 }] } } };
      await expect(nodeFeerate(MAIN)).rejects.toThrow();
    }
  });

  it('replaces a node that stops answering', async () => {
    let silent = true;
    handler = (m) => {
      if (m === 'getServerInfo') return { params: synced };
      if (silent) { silent = false; return 'silence'; }
      return { params: { estimate: { normalBuckets: [{ feerate: 150 }] } } };
    };
    // Resolvers hand out different nodes; the stuck one is skipped.
    let n = 0;
    const hosts = ['emma.kaspa.stream', 'luna.kaspa.blue'];
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ url: `wss://${hosts[n++ % 2]}/kaspa/mainnet/wrpc/borsh` }))));
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const p = nodeFeerate(MAIN);
    p.catch(() => {});
    await vi.advanceTimersByTimeAsync(7_000);
    expect(await p).toBe(150);
    vi.useRealTimers();
    expect(opened).toEqual(['wss://emma.kaspa.stream/kaspa/mainnet/wrpc/json', 'wss://luna.kaspa.blue/kaspa/mainnet/wrpc/json']);
  }, 20_000);

  it('submits; a rejection is an RpcError; "already in the mempool" for our id counts as sent', async () => {
    const id = 'ab'.repeat(32);
    handler = (m) => m === 'getServerInfo' ? { params: synced } : { params: { transactionId: id } };
    expect(await nodeSubmit(MAIN, '{}', id)).toBe(id);
    closeNode();
    handler = (m) => m === 'getServerInfo' ? { params: synced } : { error: { message: `Rejected transaction ${id}: transaction ${id} is already in the mempool` } };
    expect(await nodeSubmit(MAIN, '{}', id)).toBe(id);
    closeNode();
    handler = (m) => m === 'getServerInfo' ? { params: synced } : { error: { message: `Rejected transaction ${id}: transaction ${id} was already accepted by the consensus` } };
    expect(await nodeSubmit(MAIN, '{}', id)).toBe(id);
    closeNode();
    handler = (m) => m === 'getServerInfo' ? { params: synced } : { error: { message: `Rejected transaction ${id}: output ${'cd'.repeat(32)}:0 already spent by transaction ${'ef'.repeat(32)} in the mempool` } };
    await expect(nodeSubmit(MAIN, '{}', id)).rejects.toBeInstanceOf(RpcError);
    closeNode();
    handler = (m) => m === 'getServerInfo' ? { params: synced } : { error: { message: 'transaction is an orphan where orphan is disallowed' } };
    await expect(nodeSubmit(MAIN, '{}', id)).rejects.toBeInstanceOf(RpcError);
  });
});

describe('node transaction format', () => {
  it('matches what the Kaspa SDK sends to submitTransaction, field for field', () => {
    // Captured from kaspa-wasm32-sdk v2.1.0 RpcClient (SerdeJson) submitting this exact transaction.
    const sdk = {
      gas: 0, lockTime: 0, mass: 0, payload: '', storageMass: 0, subnetworkId: '00'.repeat(20), verboseData: null, version: 0,
      inputs: [{ computeBudget: 0, previousOutpoint: { index: 0, transactionId: 'ab'.repeat(32) }, sequence: 0, sigOpCount: 1,
        signatureScript: '412645ff647d1e8a2a7b2af2b85d1eeed8636f6d6003ac7c9f4e646933ee900fe626cda33b0880b2741a9924f72d542303ea074d25daece355589f43b36fd3f0b501',
        verboseData: null }],
      outputs: [{ covenant: null, scriptPublicKey: '0000203c72addb4fdf09af94f0c94d7fe92a386a7e70cf8a1d85916386bb2535c7b1b1ac', value: 100000000, verboseData: null }],
    };
    const tx: KaspaTx = {
      version: 0, lockTime: 0n, subnetworkId: new Uint8Array(20), gas: 0n, payload: new Uint8Array(0),
      inputs: [{ txid: 'ab'.repeat(32), index: 0, sequence: 0n, sigOpCount: 1, signatureScript: hexToBytes(sdk.inputs[0].signatureScript),
        utxo: { amount: 500000000n, script: p2pkScript(hexToBytes('3c72addb4fdf09af94f0c94d7fe92a386a7e70cf8a1d85916386bb2535c7b1b1')) } }],
      outputs: [{ amount: 100000000n, script: p2pkScript(hexToBytes('3c72addb4fdf09af94f0c94d7fe92a386a7e70cf8a1d85916386bb2535c7b1b1')) }],
    };
    expect(JSON.parse(toRpcTransactionJson(tx))).toEqual(sdk);
  });

  it('writes amounts above 2^53 exactly', () => {
    const k = p2pkScript(new Uint8Array(32).fill(1));
    const tx: KaspaTx = {
      version: 0, lockTime: 0n, subnetworkId: new Uint8Array(20), gas: 0n, payload: new Uint8Array(0),
      inputs: [{ txid: 'ab'.repeat(32), index: 0, sequence: 0n, sigOpCount: 1, signatureScript: new Uint8Array(66), utxo: { amount: 1n, script: k } }],
      outputs: [{ amount: 2_900_000_000_000_000_001n, script: k }],
    };
    expect(toRpcTransactionJson(tx)).toContain('"value":2900000000000000001');
  });
});

describe('resolver back-off', () => {
  it('leaves out a resolver that failed, for a while, then asks it again', async () => {
    const { resolveNode, resetResolverBackoff, RESOLVER_BACKOFF_MS } = await import('./node');
    const { KASPA_NETWORKS } = await import('./network');
    resetResolverBackoff();
    const asked: string[] = [];
    const down = new Set(['jake.kaspa.green', 'adam.kaspa.green']);
    vi.stubGlobal('fetch', vi.fn(async (u: string) => {
      const host = new URL(u).hostname;
      asked.push(host);
      if (down.has(host)) return new Response('error code: 521', { status: 521 });
      return new Response(JSON.stringify({ url: 'wss://electron-10.kaspa.stream/kaspa/testnet-10/wrpc/borsh' }));
    }));
    const t0 = 1_000_000;
    // Ask until both dead resolvers have been tried once.
    for (let i = 0; i < 50 && !(asked.includes('jake.kaspa.green') && asked.includes('adam.kaspa.green')); i++) {
      expect(await resolveNode(KASPA_NETWORKS['testnet-10'], new Set(), t0)).toBe('wss://electron-10.kaspa.stream/kaspa/testnet-10/wrpc/json');
    }
    expect(asked).toContain('jake.kaspa.green');
    // Within the back-off, neither is asked again.
    asked.length = 0;
    for (let i = 0; i < 30; i++) await resolveNode(KASPA_NETWORKS['testnet-10'], new Set(), t0 + 60_000);
    expect(asked.filter((h) => down.has(h))).toEqual([]);
    // After it, they may be asked again.
    asked.length = 0;
    for (let i = 0; i < 50 && !asked.some((h) => down.has(h)); i++) await resolveNode(KASPA_NETWORKS['testnet-10'], new Set(), t0 + RESOLVER_BACKOFF_MS + 1);
    expect(asked.some((h) => down.has(h))).toBe(true);
    resetResolverBackoff();
    vi.unstubAllGlobals();
  });
});
