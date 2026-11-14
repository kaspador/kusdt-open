// A wallet for the screens' tests: a real HD key, real token states and the
// real core, on a fake Kaspa node and a fake coordinator. The screens get it
// from a mocked useWallet (@/popup/state), in each test file.

import './fake-dom';
import { bytesToHex, encodeKaspaAddress } from '@kusdt/kaspa';
import { evmPrivateKey, hdFromMnemonic } from '@/keys/derive';
import { keysFor, signerOf } from '@/wallet/context';
import { plainState } from '@/kusdt/owner';
import { p2shAddressOf, scriptOf } from '@/kusdt/verify';
import { local, session } from '@/lib/storage';
import { acceptTerms } from '@/config/terms';
import type { CoordinatorApi } from '@/kusdt/api';
import type { Wallet } from '@/popup/state';
import { COVENANT, FakeNode, NET, devKey, fakeApi, recipientAnswer, testCtx } from './helpers';

export const A = '0x90F79bf6EB2c4f870365E785982E1f101E93b906';
export const B = '0x15d34AAf54267DB7D7c367839AAf71A00a2C6A65';
export const BOB = devKey('screens-bob').address;
export const CAROL = devKey('screens-carol').address;
export const SCRIPT_ADDRESS = encodeKaspaAddress(NET.prefix, 8, new Uint8Array(32).fill(7));

const HD = hdFromMnemonic('abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about');
const KEYS = keysFor(HD, 'simnet');

/** One chain's entry in /status, as the coordinator answers it. */
export const chainEntry = (chain: 1 | 2, over: Record<string, unknown> = {}) => ({
  chain, name: chain === 1 ? 'ethereum-local' : 'bsc-local', chainId: 31336 + chain, paused: false, backing: 1_000_000_000, releaseAvailable: 300_000_000,
  fees: { feeBps: 20, minDepositFee: 500000, minReleaseFee: 500000, minDeposit: 10000000, maxDeposit: 100000000000, releaseCapacity: 400_000_000, releaseRefillPerSecond: 2893518 },
  ...over,
});

export interface Fixture {
  node: FakeNode;
  ctx: ReturnType<typeof testCtx>;
  wallet: Wallet;
  /** Holds GET /tokens (so planning a burn or a kUSDT send) until the returned function is called. */
  holdPlanning: () => () => void;
  /** Holds the fee rate read (so planning a KAS send) until the returned function is called. */
  holdKasPlanning: () => () => void;
  /** The outpoints of the wallet's kUSDT states and of its KAS coin. */
  tokenOutpoints: string[];
  kasOutpoint: string;
}

/** A wallet holding a kUSDT state per amount in `tokens` and 10 KAS. */
export function fixture(tag: string, opts: { tokens?: bigint[]; status?: unknown; api?: Partial<CoordinatorApi> } = {}): Fixture {
  const node = new FakeNode();
  const tx = (n: number) => `${tag}${n}`.padEnd(64, '0');
  const amounts = opts.tokens ?? [20_000_000n];
  const states = amounts.map((a, i) => ({ txid: tx(i + 1), state: plainState({ ownerScheme: 0, owner: KEYS.ownerHex }, a) }));
  let gate: Promise<void> = Promise.resolve();
  let feeGate: Promise<void> = Promise.resolve();
  const status = opts.status ?? { chains: [chainEntry(1), chainEntry(2)] };
  const api = fakeApi({
    status: async () => status,
    tokens: async () => { await gate; return { states: states.map(s => ({ utxo: { transactionId: s.txid, index: 0 }, state: { ...s.state, amount: Number(s.state.amount) } })) }; },
    recipient: async (chain, address) => recipientAnswer(chain, address),
    ...opts.api,
  });
  const ctx = testCtx(node, api);
  for (const s of states) {
    const spk = scriptOf(ctx, 'KCC20', s.state);
    node.utxoSet.push({ address: p2shAddressOf(spk, NET.prefix), transactionId: s.txid, index: 0, amount: 150_000_000n, scriptPublicKey: spk, blockDaaScore: 5n, isCoinbase: false, covenantId: COVENANT });
  }
  const kasTx = tx(9);
  node.utxoSet.push({ address: KEYS.main.address, transactionId: kasTx, index: 0, amount: 1_000_000_000n, scriptPublicKey: `000020${bytesToHex(KEYS.main.xonly)}ac`, blockDaaScore: 10n, isCoinbase: false, covenantId: null });
  const feerate = node.feerate.bind(node);
  node.feerate = async () => { await feeGate; return feerate(); };
  const wallet: Wallet = {
    hd: HD, active: { network: 'simnet', config: ctx.config } as Wallet['active'], keys: KEYS, signer: signerOf(HD, KEYS), kasAddresses: KEYS.scan.map(k => k.address),
    balances: { kas: 1_000_000_000n, kasSpendable: 1_000_000_000n, kusdt: amounts.reduce((s, a) => s + a, 0n), rejected: 0, emptyStates: 0, emptyKas: 0n }, balanceError: null,
    refreshing: false, refreshedAt: 0, refresh: async () => {}, reloadConfig: async () => {}, ctx: async () => ctx, evmKey: () => evmPrivateKey(HD), localUpdate: null, takeLocalUpdate: async () => {},
  };
  const holder = (set: (p: Promise<void>) => void) => () => { let open = () => {}; set(new Promise<void>(r => { open = r; })); return () => open(); };
  return {
    node, ctx, wallet, tokenOutpoints: states.map(s => `${s.txid}:0`), kasOutpoint: `${kasTx}:0`,
    holdPlanning: holder(p => { gate = p; }), holdKasPlanning: holder(p => { feeGate = p; }),
  };
}

/** What each test starts from: no Activity, nothing marked as spent, no EVM RPC reachable. */
export async function resetStores(): Promise<void> {
  await local.remove('kusdt.activity.simnet');
  await session.remove('kusdt.pending.simnet');
  // And nothing the wallet remembers of its states or of unlistable addresses from the test before (round 12, R12-WW-1).
  await local.remove(`kusdt.known.simnet.${KEYS.ownerHex}`);
  await session.remove('kusdt.unreadable.simnet');
  // A wallet in use, which has accepted the Terms of Service (test/terms.test.ts is about the wallet before that).
  await acceptTerms();
}

export const noNetwork = async (): Promise<never> => { throw new Error('no network in the tests'); };
