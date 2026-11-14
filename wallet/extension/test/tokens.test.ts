import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { chooseStates, mergesFor } from '@/kusdt/tokens';
import { configProblem, kusdtReady, mergeConfig, networkLive, overrideOf, poolReady } from '@/config/settings';
import { DEFAULTS } from '@/config/defaults';

const s = (...amounts: number[]) => amounts.map((a, i) => ({ id: i, state: { amount: BigInt(a) } }));

describe('choosing token states for a send', () => {
  it('takes the fewest, largest first', () => {
    expect(chooseStates(s(5, 50, 20), 30n).picked.map(x => x.id)).toEqual([1]);
    expect(chooseStates(s(5, 50, 20), 60n).picked.map(x => x.id)).toEqual([1, 2]);
    expect(chooseStates(s(5, 50, 20), 75n)).toMatchObject({ merges: 0 });
  });

  it('needs merges (3 → 1 each) beyond 3 inputs', () => {
    expect(mergesFor(3)).toBe(0);
    expect(mergesFor(4)).toBe(1);
    expect(mergesFor(5)).toBe(1);
    expect(mergesFor(6)).toBe(2);
    expect(mergesFor(9)).toBe(3);
    expect(chooseStates(s(1, 1, 1, 1, 1), 5n).merges).toBe(1);
  });

  it('refuses more than the balance and nothing', () => {
    expect(() => chooseStates(s(1, 2), 4n)).toThrow(/Not enough/);
    expect(() => chooseStates(s(1, 2), 0n)).toThrow();
  });
});

describe('settings', () => {
  it('every default is valid; the testnet preset is the live deployment, mainnet has none yet', () => {
    for (const net of ['mainnet', 'testnet-10', 'simnet'] as const) expect(configProblem(DEFAULTS[net])).toBeNull();
    expect(DEFAULTS['testnet-10'].covenantId).toMatch(/^[0-9a-f]{64}$/); // which one: the next test
    expect(DEFAULTS['testnet-10'].chains.ethereum.chainId).toBe(11155111);
    expect(DEFAULTS['testnet-10'].nodeUrl).toBe('');
    expect(kusdtReady(DEFAULTS['testnet-10'])).toBe(true);
    expect(poolReady(DEFAULTS['testnet-10'])).toBe(true);
    expect(DEFAULTS.mainnet.covenantId).toBe('');
    expect(networkLive('mainnet')).toBe(false);
    expect(networkLive('testnet-10')).toBe(true);
    expect(DEFAULTS.mainnet.chains.bsc.token).toBe('0x55d398326f99059fF775485246999027B3197955');
  });

  it('the testnet preset matches deployments/testnet.json', () => {
    const dep = JSON.parse(readFileSync(path.resolve(__dirname, '../../../deployments/testnet.json'), 'utf8'));
    const t = DEFAULTS['testnet-10'];
    expect(dep.kaspa.network).toBe('testnet-10');
    expect(t.covenantId).toBe(dep.kaspa.covenantId);
    expect(t.poolId).toBe(dep.kaspa.poolId);
    expect(t.tokenValue).toBe(String(dep.kaspa.tokenValue));
    for (const c of dep.chains) {
      const ch = t.chains[c.chain === 1 ? 'ethereum' : 'bsc'];
      expect({ chainId: ch.chainId, vault: ch.vault, token: ch.token, decimals: ch.decimals }).toEqual({ chainId: c.chainId, vault: c.vault, token: c.token, decimals: c.decimals });
    }
  });

  it('chain names are the preset\'s, whatever an old stored edit says', () => {
    const c = mergeConfig('simnet', { chains: { ethereum: { name: 'ethereum-local', vault: '0x' + '34'.repeat(20) }, bsc: { name: 'bsc-local' } } });
    expect(c.chains.ethereum.name).toBe('Ethereum (local)');
    expect(c.chains.bsc.name).toBe('BNB Chain (local)');
    expect(c.chains.ethereum.vault).toBe('0x' + '34'.repeat(20));
    expect(DEFAULTS['testnet-10'].chains.ethereum.name).toBe('Sepolia');
    expect(DEFAULTS['testnet-10'].chains.bsc.name).toBe('BSC testnet');
    expect(DEFAULTS.mainnet.chains.ethereum.name).toBe('Ethereum');
    expect(DEFAULTS.mainnet.chains.bsc.name).toBe('BNB Chain');
  });

  it('an empty edit keeps the preset (a form saved while testnet was empty gets the deployment)', () => {
    const c = mergeConfig('testnet-10', { apiUrl: '', covenantId: '', poolId: '', chains: { ethereum: { vault: '', token: '', rpcUrls: [] } } });
    expect(c.covenantId).toBe(DEFAULTS['testnet-10'].covenantId);
    expect(c.apiUrl).toBe(DEFAULTS['testnet-10'].apiUrl);
    expect(c.chains.ethereum.vault).toBe(DEFAULTS['testnet-10'].chains.ethereum.vault);
    expect(c.chains.ethereum.rpcUrls).toEqual(DEFAULTS['testnet-10'].chains.ethereum.rpcUrls);
  });

  it('a saved edit stores only what differs from the preset, never a name', () => {
    expect(overrideOf('testnet-10', mergeConfig('testnet-10', undefined))).toBeNull();
    const edited = mergeConfig('simnet', undefined);
    const o = overrideOf('simnet', { ...edited, covenantId: 'ab'.repeat(32), chains: { ...edited.chains, bsc: { ...edited.chains.bsc, name: 'x', vault: '0x' + '56'.repeat(20) } } });
    expect(o).toEqual({ covenantId: 'ab'.repeat(32), chains: { bsc: { vault: '0x' + '56'.repeat(20) } } });
    expect(mergeConfig('simnet', o!).chains.bsc).toMatchObject({ name: 'BNB Chain (local)', vault: '0x' + '56'.repeat(20) });
  });

  it("the user's edits win, per chain field, and bad ones are refused", () => {
    const c = mergeConfig('testnet-10', { apiUrl: 'https://api.example/api/v1', chains: { bsc: { vault: '0x' + '12'.repeat(20) } } });
    expect(c.apiUrl).toBe('https://api.example/api/v1');
    expect(c.chains.bsc.vault).toBe('0x' + '12'.repeat(20));
    expect(c.chains.bsc.chainId).toBe(97);
    expect(configProblem({ ...c, nodeUrl: 'http://x' })).toMatch(/ws/);
    expect(configProblem({ ...c, covenantId: 'xyz' })).toMatch(/covenant/);
    expect(configProblem({ ...c, tokenValue: '100' })).toMatch(/token value/);
  });
});

import { formatUnits, parseUnits } from '@/lib/format';
describe('amount text', () => {
  it('is exact both ways', () => {
    expect(parseUnits('1.5', 8)).toBe(150_000_000n);
    expect(parseUnits('0,000001', 6)).toBe(1n);
    expect(parseUnits('1.0000001', 6)).toBeNull();
    expect(parseUnits('-1', 6)).toBeNull();
    expect(formatUnits(123_456_789_012_345_678n, 6)).toBe('123,456,789,012.345678');
    expect(formatUnits(150_000_000n, 8)).toBe('1.5');
  });
});
