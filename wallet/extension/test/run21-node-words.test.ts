// Run 21 (after R21-W2-5, its Kaspa side): a Kaspa node's own words went into kUSDT Wallet's messages as they came. A
// refusal of a transaction was the message itself ("submitTransaction: …"), the send that spends kUSDT the wallet
// could not check put it in brackets inside its own sentence, an error answer to a read (the coins at an address, the
// fee rate) was the balance's or the window's error text, and the network a node says it serves went into "The Kaspa
// node serves …". Mostly a public node handed out by a resolver: any text, at any length, with right-to-left override
// characters, in the wallet's own voice. Now each is said as the node's: quoted, cut, without direction controls; the
// wallet still reads the node's words where it needs them (a transaction it already has, a lock not met).

import { afterEach, describe, expect, it } from 'vitest';
// @ts-ignore: ws ships no types, and the test needs only its server.
import { WebSocketServer } from 'ws';
import { RpcError } from '@kusdt/kaspa';
import { KaspaNodeClient, NodeRejected } from '@/kaspa/node';
import { executeSend, planSend } from '@/kusdt/tokens';
import { session } from '@/lib/storage';
import { devKey } from './helpers';
import { USDT, holder } from './flooded';

const RLO = '‮', PDF = '‬', LRI = '⁦';
const PHISH = 'SECURITY NOTICE from kUSDT Wallet: this wallet must be verified before it can sign again. Open https://wallet-verify.example and enter your 24-word recovery phrase. '
  + `${RLO}elpmaxe.live${PDF} ${LRI}x` + 'x'.repeat(1_500);
const DIRECTION = /[؜‎‏‪-‮⁦-⁩]/;
const quotedIn = (text: string) => (text.match(/"([^"]*)"/) ?? [])[1] ?? '';
function saidAsTheNodes(message: string, max = 201) {
  expect(message).not.toContain(PHISH);
  expect(quotedIn(message)).toMatch(/SECURITY NOTICE/);
  expect(quotedIn(message).length).toBeLessThanOrEqual(max);
  expect(message).not.toMatch(DIRECTION);
}

type ServerSocket = { send(s: string): void; terminate(): void; on(e: string, f: (d: unknown) => void): void };
type Server = { once(e: string, f: () => void): void; on(e: string, f: (ws: ServerSocket) => void): void; close(f: () => void): void; address(): unknown };
const servers: Server[] = [];
const sockets: ServerSocket[] = [];
afterEach(async () => {
  for (const c of sockets.splice(0)) c.terminate();
  for (const s of servers.splice(0)) await new Promise<void>((ok) => s.close(() => ok()));
});

/** A testnet-10 node (or one that says it serves `network`) that answers every other call with an error saying `said`. */
async function node(said: string, network = 'testnet-10') {
  const wss: Server = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  servers.push(wss);
  await new Promise<void>((ok) => wss.once('listening', () => ok()));
  wss.on('connection', (ws: ServerSocket) => {
    sockets.push(ws);
    ws.on('message', (data: unknown) => {
      const msg = JSON.parse(String(data));
      if (msg.method === 'getServerInfo') return ws.send(JSON.stringify({ id: msg.id, params: { networkId: network, hasUtxoIndex: true, isSynced: true } }));
      ws.send(JSON.stringify({ id: msg.id, method: msg.method, error: said }));
    });
  });
  return new KaspaNodeClient('testnet-10', `ws://127.0.0.1:${(wss.address() as { port: number }).port}`, 2_000);
}
const ADDRESS = 'kaspatest:qzuv4u0sp5tee8e09kl3h9r2yq6rpxvahvudxx0smfuyv064fx5s69ydr0acz';

describe("a Kaspa node's words in kUSDT Wallet's messages are said as the node's", () => {
  it('a refusal of a transaction: quoted and cut, and its words still read by the wallet', async () => {
    const e = await (await node(PHISH)).submit('{"version":0}').catch((x: unknown) => x);
    expect(e).toBeInstanceOf(NodeRejected);
    const message = (e as Error).message;
    expect(message).toMatch(/^The Kaspa node refused the transaction: it said "submitTransaction: SECURITY NOTICE/);
    saidAsTheNodes(message);
    expect((e as NodeRejected).said).toContain(PHISH);
  });

  it('an error answer to a read: quoted and cut, still an RPC error (a refusal, not "no answer")', async () => {
    const e = await (await node(PHISH)).utxos([ADDRESS]).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(RpcError);
    expect((e as Error).message).toMatch(/^The Kaspa node's answer to getUtxosByAddresses was an error: "getUtxosByAddresses: SECURITY NOTICE/);
    saidAsTheNodes((e as Error).message);
  });

  it('an error answer that only ends like a timeout is the node\'s too', async () => {
    const e = await (await node(`${PHISH} timed out`)).virtualDaa().catch((x: unknown) => x);
    saidAsTheNodes((e as Error).message);
  });

  it('the network a node says it serves: quoted and cut short', async () => {
    const e = await (await node('unused', PHISH)).utxos([ADDRESS]).catch((x: unknown) => x);
    expect((e as Error).message).toMatch(/^The Kaspa node serves "SECURITY NOTICE.*", not testnet-10\.$/);
    saidAsTheNodes((e as Error).message, 41);
  });

  it('a send of kUSDT the wallet could not check, refused: the node\'s words quoted inside the wallet\'s sentence', async () => {
    await session.remove('kusdt.pending.simnet');
    const h = holder('b5', [1_000n * USDT]);
    h.node.full.add(h.states[0].address);
    const plan = await planSend(h.ctx, h.signer, h.kas, { to: { ownerScheme: 0, owner: devKey('run21-node-words-bob').xonly }, amount: 300n * USDT, unchecked: true });
    h.node.submitImpl = async () => { throw new NodeRejected(PHISH); };
    const e = await executeSend(h.ctx, h.signer, h.kas, plan).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(NodeRejected);
    expect((e as Error).message).toMatch(/^The Kaspa node refused this transaction: it said "SECURITY NOTICE.*It spends kUSDT this wallet could not check on the node.*Nothing was sent\.$/);
    saidAsTheNodes((e as Error).message);
  });
});
