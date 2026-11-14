// A fake EVM JSON-RPC endpoint for the wallet's tests: a USDT token, the vault
// and the fee methods, enough for a whole deposit (approve, deposit, receipt
// with its Deposit event). `over` answers a request itself (undefined: the
// default answer); `holdSends` keeps eth_sendRawTransaction waiting.

import { Transaction } from 'ethers';
import { selector } from '@/evm/abi';
import { DEPOSIT_SIGNATURE, DEPOSIT_TOPIC } from '@/evm/vault';

export const GWEI = 1_000_000_000n;
const hex = (n: bigint | number) => '0x' + BigInt(n).toString(16);
const word = (n: bigint) => n.toString(16).padStart(64, '0');

const SEL = {
  balanceOf: selector('balanceOf(address)'), allowance: selector('allowance(address,address)'), paused: selector('paused()'),
  minDeposit: selector('minDeposit()'), maxDeposit: selector('maxDeposit()'), depositFeeOf: selector('depositFeeOf(uint256)'), deposit: selector(DEPOSIT_SIGNATURE),
};

export interface FakeEvmOptions {
  /** The chain each URL answers for (default: 31337, and 31338 for a URL ending in 8546). */
  chainIdOf?: (url: string) => number;
  baseFee?: bigint; tip?: bigint; gas?: bigint; usdt?: bigint; allowance?: bigint;
  /** How long eth_call for depositFeeOf waits, by the units asked about (ms). */
  quoteDelay?: (units: bigint) => number;
  over?: (url: string, method: string, params: any[]) => unknown; // eslint-disable-line @typescript-eslint/no-explicit-any
}

export function fakeEvm(o: FakeEvmOptions = {}) {
  const sent: { url: string; raw: string; tx: Transaction }[] = [];
  const asked: { url: string; method: string }[] = [];
  let gate: Promise<void> = Promise.resolve();
  let allowance = o.allowance ?? 0n;
  const chainIdOf = o.chainIdOf ?? ((url: string) => (url.endsWith('8546') ? 31338 : 31337));

  async function answer(url: string, method: string, params: any[]): Promise<unknown> { // eslint-disable-line @typescript-eslint/no-explicit-any
    const own = o.over?.(url, method, params);
    if (own !== undefined) return own;
    switch (method) {
      case 'eth_chainId': return hex(chainIdOf(url));
      case 'eth_getBalance': return hex(10n ** 18n);
      case 'eth_getTransactionCount': return hex(sent.length);
      case 'eth_estimateGas': return hex(o.gas ?? 60_000n);
      case 'eth_maxPriorityFeePerGas': return hex(o.tip ?? GWEI);
      case 'eth_feeHistory': return { baseFeePerGas: [hex(o.baseFee ?? GWEI), hex(o.baseFee ?? GWEI)], reward: [[hex(o.tip ?? GWEI)]] };
      case 'eth_getBlockByNumber': return { baseFeePerGas: hex(o.baseFee ?? GWEI) };
      case 'eth_getTransactionByHash': return {};
      case 'eth_call': {
        const data: string = params[0].data;
        const sel = data.slice(0, 10);
        if (sel === SEL.balanceOf) return '0x' + word(o.usdt ?? 10n ** 30n);
        if (sel === SEL.allowance) return '0x' + word(allowance);
        if (sel === SEL.paused) return '0x' + word(0n);
        if (sel === SEL.minDeposit) return '0x' + word(10_000_000n);
        if (sel === SEL.maxDeposit) return '0x' + word(100_000_000_000n);
        if (sel === SEL.depositFeeOf) {
          const units = BigInt('0x' + data.slice(10));
          const wait = o.quoteDelay?.(units) ?? 0;
          if (wait) await new Promise(r => setTimeout(r, wait));
          const fee = (units * 20n) / 10_000n;
          return '0x' + word(fee > 500_000n ? fee : 500_000n);
        }
        throw new Error(`fake EVM: unknown call ${sel}`);
      }
      case 'eth_sendRawTransaction': {
        await gate;
        const tx = Transaction.from(params[0]);
        sent.push({ url, raw: params[0], tx });
        if (tx.data.startsWith(selector('approve(address,uint256)'))) allowance = BigInt('0x' + tx.data.slice(74));
        return tx.hash;
      }
      case 'eth_getTransactionReceipt': {
        const s = sent.find(x => x.tx.hash === params[0]);
        if (!s) return null;
        const logs = [];
        if (s.tx.data.startsWith(SEL.deposit)) {
          const d = s.tx.data.slice(10), units = BigInt('0x' + d.slice(0, 64)), fee = (units * 20n) / 10_000n > 500_000n ? (units * 20n) / 10_000n : 500_000n;
          logs.push({
            address: s.tx.to!, topics: [DEPOSIT_TOPIC, '0x' + word(7n), '0x' + s.tx.from!.slice(2).toLowerCase().padStart(64, '0')],
            data: '0x' + d.slice(64, 128) + d.slice(128, 192) + word(units) + word(fee) + word(units - fee),
          });
        }
        return { status: '0x1', blockNumber: '0x10', logs };
      }
      default: throw new Error(`fake EVM: unknown method ${method}`);
    }
  }

  const fetch = async (url: unknown, init?: { body?: unknown }) => {
    const { id, method, params } = JSON.parse(String(init?.body));
    asked.push({ url: String(url), method });
    let body: unknown;
    try { body = { jsonrpc: '2.0', id, result: await answer(String(url), method, params) }; }
    catch (e) { body = { jsonrpc: '2.0', id, error: { code: -32000, message: (e as Error).message } }; }
    // A real Response: the wallet reads its body as a stream, with a limit (round 14, R14-CL-2). Undefined goes as null, as on the wire.
    return new Response(JSON.stringify(body, (_k, v) => (v === undefined ? null : v)), { status: 200 });
  };

  return {
    fetch: fetch as unknown as typeof globalThis.fetch, sent, asked,
    /** Keeps every later eth_sendRawTransaction waiting until the returned function is called. */
    holdSends() { let open = () => {}; gate = new Promise<void>(r => { open = r; }); return () => open(); },
  };
}
