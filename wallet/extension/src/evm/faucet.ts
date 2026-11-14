// Test USDT on Testnet and Local only. Their deployments' token is MockUSDT,
// whose mint is open to anyone (bridge/evm/contracts/test/MockUSDT.sol), so
// the wallet's own EVM account mints itself some to bridge. Never on Mainnet,
// whatever its config says: there the token is real USDT.

import type { KaspaNetworkName } from '@/config/defaults';
import { encodeCall } from './abi';
import { prepareTx, signAndSend } from './vault';
import type { EthRpc } from './rpc';

/** Whole USDT one tap mints. */
export const TEST_USDT_WHOLE = 1_000n;
export const MINT_SIGNATURE = 'mint(address,uint256)';

/** Only the test networks offer it. */
export const testUsdtOffered = (network: KaspaNetworkName): boolean => network === 'testnet-10' || network === 'simnet';

/** 1,000 USDT in the token's smallest unit. */
export const testUsdtAmount = (decimals: number): bigint => {
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 36) throw new Error('Unexpected USDT decimals.');
  return TEST_USDT_WHOLE * 10n ** BigInt(decimals);
};

/** MockUSDT.mint(to, amount). */
export const testMintData = (to: string, amount: bigint): string => encodeCall(MINT_SIGNATURE, ['address', 'uint'], [to, amount]);

/** The account has nothing to pay the network fee with. */
export class NoGas extends Error {
  constructor(readonly address: string, readonly gasSymbol: string, readonly chainName: string) {
    super(`Your EVM account has no ${gasSymbol} on ${chainName} to pay the network fee. Send a little ${gasSymbol} to ${address}, then try again.`);
  }
}

/**
 * Mints 1,000 test USDT from the wallet's EVM account to itself; answers the
 * transaction hash once sent. Refused off the test networks, and with NoGas
 * when the account can't pay the fee.
 */
export async function mintTestUsdt(a: { network: KaspaNetworkName; rpc: EthRpc; token: string; decimals: number; from: string; key: Uint8Array }): Promise<string> {
  if (!testUsdtOffered(a.network)) throw new Error('Test USDT is only for Testnet and Local.');
  if (!/^0x[0-9a-fA-F]{40}$/.test(a.token)) throw new Error('No USDT token is set for this chain.');
  const noGas = () => new NoGas(a.from, a.rpc.gasSymbol, a.rpc.name);
  if ((await a.rpc.balance(a.from)) === 0n) throw noGas();
  const call = { to: a.token, data: testMintData(a.from, testUsdtAmount(a.decimals)) };
  let p;
  try { p = await prepareTx(a.rpc, a.from, call); }
  catch (e) {
    if (/for the network fee|insufficient funds/i.test((e as Error)?.message ?? '')) throw noGas();
    throw e;
  }
  return signAndSend(a.rpc, p, a.key);
}
