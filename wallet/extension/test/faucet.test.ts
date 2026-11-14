import { describe, expect, it } from 'vitest';
import { MINT_SIGNATURE, NoGas, TEST_USDT_WHOLE, mintTestUsdt, testMintData, testUsdtAmount, testUsdtOffered } from '@/evm/faucet';
import { selector } from '@/evm/abi';
import type { EthRpc } from '@/evm/rpc';

const ME = '0x9858EfFD232B4033E47d90003D41EC34EcaEda94';
const TOKEN = '0x5bF185d9ce3A194b7090f069398580A66fb1F8a1';

describe('test USDT (MockUSDT.mint, Testnet and Local only)', () => {
  it('is offered on Testnet and Local, never on Mainnet', () => {
    expect(testUsdtOffered('testnet-10')).toBe(true);
    expect(testUsdtOffered('simnet')).toBe(true);
    expect(testUsdtOffered('mainnet')).toBe(false);
  });

  it("mints 1,000 USDT in the token's own decimals", () => {
    expect(TEST_USDT_WHOLE).toBe(1_000n);
    expect(testUsdtAmount(6)).toBe(1_000_000_000n);
    expect(testUsdtAmount(18)).toBe(1_000n * 10n ** 18n);
    expect(() => testUsdtAmount(-1)).toThrow();
  });

  it('calls mint(address,uint256) with the account itself and the amount', () => {
    expect(MINT_SIGNATURE).toBe('mint(address,uint256)');
    expect(selector(MINT_SIGNATURE)).toBe('0x40c10f19');
    const data = testMintData(ME, testUsdtAmount(6));
    expect(data).toBe('0x40c10f19'
      + '0000000000000000000000009858effd232b4033e47d90003d41ec34ecaeda94'
      + (1_000_000_000n).toString(16).padStart(64, '0'));
    expect(testMintData(ME, testUsdtAmount(18)).slice(-64)).toBe((10n ** 21n).toString(16).padStart(64, '0'));
  });

  it('refuses on Mainnet before asking the chain anything, and says plainly when there is no gas', async () => {
    let asked = 0;
    const rpc = { name: 'Sepolia', gasSymbol: 'ETH', chainId: 11155111, balance: async () => { asked++; return 0n; } } as unknown as EthRpc;
    await expect(mintTestUsdt({ network: 'mainnet', rpc, token: TOKEN, decimals: 6, from: ME, key: new Uint8Array(32) })).rejects.toThrow(/only for Testnet and Local/);
    expect(asked).toBe(0);
    const e = await mintTestUsdt({ network: 'testnet-10', rpc, token: TOKEN, decimals: 6, from: ME, key: new Uint8Array(32) }).catch(x => x);
    expect(e).toBeInstanceOf(NoGas);
    expect(e.message).toBe(`Your EVM account has no ETH on Sepolia to pay the network fee. Send a little ETH to ${ME}, then try again.`);
  });
});
