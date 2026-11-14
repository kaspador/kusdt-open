// What the wallet calls its networks, and the Local-only "use the local
// stack's new deployment" (config/networks.ts, config/local.ts).

import { describe, expect, it, vi } from 'vitest';
import { NETWORKS, NETWORK_ORDER, chainsLine, networkName, timeToExpect } from '@/config/networks';
import { LOCAL_FAUCET, deploymentDiffers, parseLocalDeployment, readLocalDeployment, withLocalDeployment } from '@/config/local';
import { DEFAULTS, KASPA_NETWORK_NAMES } from '@/config/defaults';
import { mergeConfig } from '@/config/settings';

describe('network names people see', () => {
  it('names each network and the three chains it joins', () => {
    expect(networkName('testnet-10')).toBe('Testnet');
    expect(networkName('simnet')).toBe('Local');
    expect(networkName('mainnet')).toBe('Mainnet');
    expect(chainsLine('testnet-10')).toBe('Kaspa TN10 · Sepolia · BSC testnet');
    expect(chainsLine('simnet')).toBe('Kaspa simnet · Ethereum (local) · BNB Chain (local)');
    expect(chainsLine('mainnet')).toBe('Kaspa · Ethereum · BNB Chain');
    expect([...NETWORK_ORDER].sort()).toEqual([...KASPA_NETWORK_NAMES].sort());
  });

  it('never shows a stored key or a development name', () => {
    for (const n of KASPA_NETWORK_NAMES) {
      const i = NETWORKS[n];
      for (const text of [i.name, i.note, i.banner ?? '', DEFAULTS[n].chains.ethereum.name, DEFAULTS[n].chains.bsc.name]) {
        expect(text).not.toMatch(/testnet-10|simnet|ethereum-local|bsc-local|sepolia$|bsc-testnet/);
      }
    }
  });

  it('puts a banner on Testnet and Local only; testnet is the warning tone', () => {
    expect(NETWORKS['testnet-10']).toMatchObject({ tone: 'test', banner: 'Testnet: test coins only, no real value' });
    expect(NETWORKS.simnet.tone).toBe('local');
    expect(NETWORKS.simnet.banner).toMatch(/on this computer/);
    expect(NETWORKS.mainnet.banner).toBeNull();
  });

  it('says how long a bridge transfer takes: Sepolia deposits wait for finality', () => {
    expect(timeToExpect('testnet-10', 'in', 'ethereum', 'Sepolia')).toEqual({ time: 'About 15 min', why: 'Sepolia deposits wait for finality' });
    expect(timeToExpect('testnet-10', 'in', 'bsc', 'BSC testnet').time).toBe('A few minutes');
    expect(timeToExpect('testnet-10', 'out', 'ethereum', 'Sepolia').why).toMatch(/3 of 5 signers/);
    expect(timeToExpect('simnet', 'in', 'ethereum', 'Ethereum (local)').time).toBe('Under a minute');
  });
});

describe('the local stack (Local only)', () => {
  const chains = [
    { chain: 1, name: 'ethereum-local', chainId: 31337, vault: '0x' + '11'.repeat(20), token: '0x' + '22'.repeat(20), decimals: 6 },
    { chain: 2, name: 'bsc-local', chainId: 31338, vault: '0x' + '33'.repeat(20), token: '0x' + '44'.repeat(20), decimals: 18 },
  ];
  const stack = (covenantId = 'cd'.repeat(32)) => ({ deployment: { kaspa: { covenantId, poolId: 'ef'.repeat(32), tokenValue: 150000000, burnValue: 30000000 }, chains } });
  const fetcher = (answers: Record<string, unknown>) => vi.fn(async (url: string) =>
    url in answers ? new Response(JSON.stringify(answers[url]), { status: 200 }) : new Response('not found', { status: 404 })) as unknown as typeof fetch & ReturnType<typeof vi.fn>;
  const API = 'http://127.0.0.1:9100/api/v1';

  it("reads the faucet's /stack, else the coordinator's /status", async () => {
    const fromStack = await readLocalDeployment('simnet', API, fetcher({ [`${LOCAL_FAUCET}/stack`]: stack() }));
    expect(fromStack).toEqual({ covenantId: 'cd'.repeat(32), poolId: 'ef'.repeat(32), tokenValue: '150000000', burnValue: '30000000', chains: {
      ethereum: { chainId: 31337, vault: chains[0].vault, token: chains[0].token, decimals: 6 },
      bsc: { chainId: 31338, vault: chains[1].vault, token: chains[1].token, decimals: 18 },
    } });
    const fromStatus = await readLocalDeployment('simnet', API, fetcher({ [`${API}/status`]: { kaspa: { covenantId: 'ab'.repeat(32), poolId: 'ba'.repeat(32) }, chains } }));
    expect(fromStatus?.covenantId).toBe('ab'.repeat(32));
    expect(fromStatus?.burnValue).toBeNull(); // an older stack: the preset's burn value stays
    expect(await readLocalDeployment('simnet', API, fetcher({}))).toBeNull();
  });

  it('answers nothing on Testnet or Mainnet, and asks no server there', async () => {
    const f = fetcher({ [`${LOCAL_FAUCET}/stack`]: stack(), 'http://127.0.0.1:9300/api/v1/status': { kaspa: stack().deployment.kaspa, chains } });
    expect(await readLocalDeployment('testnet-10', 'http://127.0.0.1:9300/api/v1', f)).toBeNull();
    expect(await readLocalDeployment('mainnet', '', f)).toBeNull();
    expect(f).not.toHaveBeenCalled();
  });

  it('refuses a malformed deployment', () => {
    expect(parseLocalDeployment({ covenantId: 'xyz', poolId: 'ef'.repeat(32) }, chains)).toBeNull();
    expect(parseLocalDeployment({ covenantId: 'CD'.repeat(32), poolId: 'ef'.repeat(32) }, chains)).toBeNull();
    expect(parseLocalDeployment({ covenantId: 'cd'.repeat(32), poolId: 'ef'.repeat(32) }, [{ ...chains[0], vault: 'nope' }])).toBeNull();
    expect(parseLocalDeployment({ covenantId: 'cd'.repeat(32), poolId: 'ef'.repeat(32) }, [{ ...chains[0], decimals: 99 }])).toBeNull();
  });

  it('says when the pinned deployment is not the stack\'s, and takes it without touching endpoints or names', () => {
    const d = parseLocalDeployment(stack().deployment.kaspa, chains)!;
    const pinned = mergeConfig('simnet', undefined);
    expect(deploymentDiffers(pinned, d)).toBe(true); // empty
    const next = withLocalDeployment(pinned, d);
    expect(deploymentDiffers(next, d)).toBe(false);
    expect(next.covenantId).toBe('cd'.repeat(32));
    expect(next.chains.bsc).toMatchObject({ name: 'BNB Chain (local)', vault: chains[1].vault, rpcUrls: pinned.chains.bsc.rpcUrls });
    expect(next.apiUrl).toBe(pinned.apiUrl);
    expect(next.nodeUrl).toBe(pinned.nodeUrl);
    expect(deploymentDiffers(next, parseLocalDeployment(stack('99'.repeat(32)).deployment.kaspa, chains)!)).toBe(true);
  });
});

// Round 9: settings are saved without the password, and an edited vault address took the next deposit.
describe('the contracts the money goes to', () => {
  it('on mainnet a stored edit never replaces a built-in contract', async () => {
    const { DEFAULTS } = await import('../src/config/defaults');
    const { mergeConfig, deploymentEdits, deploymentLocked } = await import('../src/config/settings');
    const evil = '0x' + 'a7'.repeat(20);
    const d = DEFAULTS.mainnet;
    const kept = { vault: d.chains.ethereum.vault, covenantId: d.covenantId };
    try {
      // As after launch: the preset names the deployment.
      d.chains.ethereum.vault = '0x' + '11'.repeat(20);
      d.covenantId = '22'.repeat(32);
      const c = mergeConfig('mainnet', { covenantId: '33'.repeat(32), apiUrl: 'https://other.example/api/v1', chains: { ethereum: { vault: evil, token: evil, chainId: 5, decimals: 18, rpcUrls: ['https://rpc.example'] } } });
      expect(c.chains.ethereum.vault).toBe(d.chains.ethereum.vault);
      expect(c.chains.ethereum.token).toBe(d.chains.ethereum.token);
      expect(c.chains.ethereum.chainId).toBe(d.chains.ethereum.chainId);
      expect(c.chains.ethereum.decimals).toBe(d.chains.ethereum.decimals);
      expect(c.covenantId).toBe(d.covenantId);
      // What is the user's to choose still is.
      expect(c.apiUrl).toBe('https://other.example/api/v1');
      expect(c.chains.ethereum.rpcUrls).toEqual(['https://rpc.example']);
      expect(deploymentLocked('mainnet', 'ethereum', 'vault')).toBe(true);
      expect(deploymentLocked('mainnet', 'ethereum', 'rpcUrls')).toBe(false);
      expect(deploymentLocked('testnet-10', 'ethereum', 'vault')).toBe(false);
      // The servers are the user's to choose, and the wallet says that they are not the built-in ones.
      expect(deploymentEdits('mainnet', c)).toEqual(['the bridge server', 'the Ethereum RPC']);
    } finally { d.chains.ethereum.vault = kept.vault; d.covenantId = kept.covenantId; }
  });

  it('a wallet on other contracts than the built-in ones says which', async () => {
    const { mergeConfig, deploymentEdits } = await import('../src/config/settings');
    const evil = '0x' + 'a7'.repeat(20);
    expect(deploymentEdits('testnet-10', mergeConfig('testnet-10', undefined))).toEqual([]);
    expect(deploymentEdits('testnet-10', mergeConfig('testnet-10', { chains: { ethereum: { vault: evil } } }))).toEqual(['the Sepolia vault']);
    expect(deploymentEdits('testnet-10', mergeConfig('testnet-10', { covenantId: '33'.repeat(32), chains: { bsc: { token: evil } } })).length).toBe(2);
    // Only the letters' case differs: the same address.
    const same = mergeConfig('testnet-10', undefined);
    same.chains.ethereum.vault = same.chains.ethereum.vault.toLowerCase();
    expect(deploymentEdits('testnet-10', same)).toEqual([]);
  });
});

// The review of that fix: what a stored edit could still do.
describe('what stored settings cannot decide', () => {
  it('the chain a network signs for is the built-in one, on every network (a "Local" told chain ID 1 signed a real approval)', async () => {
    const { DEFAULTS } = await import('../src/config/defaults');
    const { mergeConfig, deploymentLocked } = await import('../src/config/settings');
    for (const net of ['simnet', 'testnet-10', 'mainnet'] as const) {
      const c = mergeConfig(net, { chains: { ethereum: { chainId: 1 }, bsc: { chainId: 56 } } });
      expect(c.chains.ethereum.chainId).toBe(DEFAULTS[net].chains.ethereum.chainId);
      expect(c.chains.bsc.chainId).toBe(DEFAULTS[net].chains.bsc.chainId);
      expect(deploymentLocked(net, 'ethereum', 'chainId')).toBe(true);
    }
    expect(mergeConfig('simnet', undefined).chains.ethereum.chainId).not.toBe(1);
  });

  it('the local network only talks to this machine', async () => {
    const { DEFAULTS } = await import('../src/config/defaults');
    const { mergeConfig } = await import('../src/config/settings');
    const c = mergeConfig('simnet', { nodeUrl: 'wss://node.example', apiUrl: 'https://api.example/api/v1', chains: { ethereum: { rpcUrls: ['http://127.0.0.1:8545', 'https://rpc.example'] } } });
    expect(c.nodeUrl).toBe(DEFAULTS.simnet.nodeUrl);
    expect(c.apiUrl).toBe(DEFAULTS.simnet.apiUrl);
    expect(c.chains.ethereum.rpcUrls).toEqual(DEFAULTS.simnet.chains.ethereum.rpcUrls);
    const local = mergeConfig('simnet', { nodeUrl: 'ws://127.0.0.1:19999', chains: { ethereum: { rpcUrls: ['http://localhost:9999'] } } });
    expect(local.nodeUrl).toBe('ws://127.0.0.1:19999');
    expect(local.chains.ethereum.rpcUrls).toEqual(['http://localhost:9999']);
  });

  it('mainnet has no deployment until the build names one, whatever is stored', async () => {
    const { mergeConfig, networkLive, kusdtReady } = await import('../src/config/settings');
    const typed = { covenantId: '33'.repeat(32), poolId: '44'.repeat(32), apiUrl: 'https://api.example/api/v1', chains: { ethereum: { vault: '0x' + 'a7'.repeat(20), rpcUrls: ['https://rpc.example'] } } };
    const c = mergeConfig('mainnet', typed);
    expect(c.covenantId).toBe('');
    expect(c.chains.ethereum.vault).toBe('');
    expect(kusdtReady(c)).toBe(false);
    expect(networkLive('mainnet', { mainnet: typed })).toBe(false);
  });

  it('on mainnet the KAS sent with kUSDT and burned with a bridge back is the built-in amount', async () => {
    const { DEFAULTS } = await import('../src/config/defaults');
    const { mergeConfig, deploymentEdits } = await import('../src/config/settings');
    const c = mergeConfig('mainnet', { burnValue: '999999999999', tokenValue: '5000000000000', positionValue: 'x' } as any);
    expect(c.burnValue).toBe(DEFAULTS.mainnet.burnValue);
    expect(c.tokenValue).toBe(DEFAULTS.mainnet.tokenValue);
    expect(c.positionValue).toBe(DEFAULTS.mainnet.positionValue);
    // On the testnet they can be set, and the wallet says so.
    expect(deploymentEdits('testnet-10', mergeConfig('testnet-10', { burnValue: '999999999999' } as any))).toEqual(['the KAS sent with kUSDT']);
  });

  it('a site is told the own address of the wallet, never the one a stored connection names', async () => {
    const { ownConnection } = await import('../src/background/provider');
    const own = { address: 'kaspatest:qmine', ownerHex: 'aa'.repeat(32), kasAddresses: ['kaspatest:qmine', 'kaspatest:qchange'] };
    const stored = { origin: 'https://site.example', address: 'kaspatest:qmine', ownerHex: 'bb'.repeat(32), kasAddresses: ['kaspatest:qother'], at: 1 };
    expect(ownConnection(stored, own)).toEqual({ ...stored, ...own });
    // The address swapped in storage: not this wallet's connection.
    expect(ownConnection({ ...stored, address: 'kaspatest:qattacker' }, own)).toBe(null);
    // Not unlocked since the browser started: nothing to answer with.
    expect(ownConnection(stored, undefined)).toBe(null);
    expect(ownConnection(null, own)).toBe(null);
  });
});

// The second review: an edit to a network found in storage may be anyone's (it is written without the password). On
// "Testnet" a Kaspa node of somebody else's, serving mainnet under a testnet name, had the wallet spend real KAS.
describe('a network edit is used only when this wallet saved it', () => {
  const edit = { nodeUrl: 'wss://node.example', chains: { ethereum: { vault: '0x' + 'a7'.repeat(20) } } };

  it('an edit written into storage without the wallet’s key is not used; the wallet’s own is', async () => {
    const { trustedOverrides, settingsMac, settingsMacKeyOf } = await import('../src/config/settings');
    const key = settingsMacKeyOf('abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about');
    // Forged: no mark, a made-up mark, a mark made with another wallet's key, the mark of another network's edit.
    expect(trustedOverrides({ overrides: { 'testnet-10': edit } }, key)).toEqual({});
    expect(trustedOverrides({ overrides: { 'testnet-10': edit }, overrideMacs: { 'testnet-10': 'ab'.repeat(32) } }, key)).toEqual({});
    expect(trustedOverrides({ overrides: { 'testnet-10': edit }, overrideMacs: { 'testnet-10': settingsMac(settingsMacKeyOf('zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo wrong'), 'testnet-10', edit) } }, key)).toEqual({});
    expect(trustedOverrides({ overrides: { 'testnet-10': edit }, overrideMacs: { 'testnet-10': settingsMac(key, 'mainnet', edit) } }, key)).toEqual({});
    // The wallet's own, and the same edit changed afterwards.
    const mine = { overrides: { 'testnet-10': edit }, overrideMacs: { 'testnet-10': settingsMac(key, 'testnet-10', edit) } };
    expect(trustedOverrides(mine, key)).toEqual({ 'testnet-10': edit });
    expect(trustedOverrides({ ...mine, overrides: { 'testnet-10': { ...edit, nodeUrl: 'wss://other.example' } } }, key)).toEqual({});
    // Not unlocked since the browser started: no key, the built-in values.
    expect(trustedOverrides(mine, null)).toEqual({});
  });

  it('saving needs the unlocked wallet, and what it saves comes back', async () => {
    const { local, session } = await import('../src/lib/storage');
    const { saveNetworkConfig, loadSettings, mergeConfig, SETTINGS_KEY, SESSION_PHRASE_KEY: SETTINGS_MAC_KEY } = await import('../src/config/settings');
    await local.remove(SETTINGS_KEY); await session.remove(SETTINGS_MAC_KEY);
    try {
      const c = mergeConfig('testnet-10', undefined);
      c.nodeUrl = 'wss://node.example';
      await expect(saveNetworkConfig('testnet-10', c)).rejects.toThrow(/Unlock the wallet/);
      await session.set({ [SETTINGS_MAC_KEY]: 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about' });
      await saveNetworkConfig('testnet-10', c);
      expect((await loadSettings()).overrides['testnet-10']).toEqual({ nodeUrl: 'wss://node.example' });
      // Somebody edits the stored copy: it is no longer this wallet's.
      const stored: any = await local.get(SETTINGS_KEY);
      stored.overrides['testnet-10'].nodeUrl = 'wss://attacker.example';
      await local.set({ [SETTINGS_KEY]: stored });
      expect((await loadSettings()).overrides).toEqual({});
      // Locked since the browser started: nothing to check with, and a save of something else keeps what is stored.
      stored.overrides['testnet-10'].nodeUrl = 'wss://node.example';
      await local.set({ [SETTINGS_KEY]: stored });
      await session.remove(SETTINGS_MAC_KEY);
      expect((await loadSettings()).overrides).toEqual({});
      const { saveSettings } = await import('../src/config/settings');
      await saveSettings({ autoLockMins: 5 });
      await session.set({ [SETTINGS_MAC_KEY]: 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about' });
      expect((await loadSettings()).overrides['testnet-10']).toEqual({ nodeUrl: 'wss://node.example' });
      expect((await loadSettings()).autoLockMins).toBe(5);
    } finally { await local.remove(SETTINGS_KEY); await session.remove(SETTINGS_MAC_KEY); }
  });

  it('the local network needs no mark (it only reaches this machine), and junk in storage is dropped, not used', async () => {
    const { trustedOverrides, mergeConfig, deploymentEdits } = await import('../src/config/settings');
    const o = trustedOverrides({ overrides: { simnet: { nodeUrl: 'ws://127.0.0.1:18610', apiUrl: 5, covenantId: false, bogus: 'x', chains: { ethereum: { rpcUrls: 'http://x', decimals: '6', vault: '0x' + '11'.repeat(20) }, bsc: 7 } } as any } }, null);
    expect(o).toEqual({ simnet: { nodeUrl: 'ws://127.0.0.1:18610', chains: { ethereum: { vault: '0x' + '11'.repeat(20) } } } });
    for (const junk of [{ simnet: 5 }, { simnet: { chains: [] } }, { simnet: { nodeUrl: false, chains: { ethereum: { rpcUrls: [1, 2] } } } }, { 'testnet-10': 'x' }]) {
      const t = trustedOverrides({ overrides: junk as any }, null);
      expect(() => { mergeConfig('simnet', t.simnet); deploymentEdits('testnet-10', mergeConfig('testnet-10', t['testnet-10'])); }).not.toThrow();
    }
  });
});

// The third review: the key that marks an edit stayed in session storage after the wallet locked.
describe('a locked wallet holds nothing that marks a network edit', () => {
  it('after lock the stored edit is not used, and none can be saved', async () => {
    const { local, session } = await import('../src/lib/storage');
    const { unlockWith, lock } = await import('../src/keys/session');
    const { saveNetworkConfig, loadSettings, mergeConfig, SETTINGS_KEY } = await import('../src/config/settings');
    await local.remove(SETTINGS_KEY);
    try {
      await unlockWith('abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about');
      const c = mergeConfig('testnet-10', undefined);
      c.nodeUrl = 'wss://node.example';
      await saveNetworkConfig('testnet-10', c);
      expect((await loadSettings()).overrides['testnet-10']).toEqual({ nodeUrl: 'wss://node.example' });
      await lock();
      // Nothing in the session that a console in the wallet's own pages could mark an edit with.
      for (const k of ['kusdt.settings.mackey', 'kusdt.session.phrase']) expect(await session.get(k)).toBeFalsy();
      expect((await loadSettings()).overrides).toEqual({});
      await expect(saveNetworkConfig('testnet-10', c)).rejects.toThrow(/Unlock the wallet/);
      // Unlocked again: the wallet's own edit is back.
      await unlockWith('abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about');
      expect((await loadSettings()).overrides['testnet-10']).toEqual({ nodeUrl: 'wss://node.example' });
    } finally { await lock(); await local.remove(SETTINGS_KEY); }
  });

  it('an auto-lock time that the wallet does not offer is not used', async () => {
    const { local } = await import('../src/lib/storage');
    const { loadSettings, SETTINGS_KEY } = await import('../src/config/settings');
    try {
      for (const bad of [10_000_000, -1, 1.5, 7]) { await local.set({ [SETTINGS_KEY]: { autoLockMins: bad } }); expect((await loadSettings()).autoLockMins).toBe(15); }
      await local.set({ [SETTINGS_KEY]: { autoLockMins: 60 } });
      expect((await loadSettings()).autoLockMins).toBe(60);
    } finally { await local.remove(SETTINGS_KEY); }
  });
});

// The last review: a save for the local network while the wallet was locked rewrote all stored edits from the ones it
// could check at that moment, which were none of the others: the testnet edit and its mark were gone.
describe('a save for one network leaves the others as they are stored', () => {
  it('a local-network save or reset while locked keeps the testnet edit', async () => {
    const { local } = await import('../src/lib/storage');
    const { unlockWith, lock } = await import('../src/keys/session');
    const { saveNetworkConfig, resetNetworkConfig, loadSettings, mergeConfig, SETTINGS_KEY } = await import('../src/config/settings');
    const P = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
    await local.remove(SETTINGS_KEY);
    try {
      await unlockWith(P);
      const c = mergeConfig('testnet-10', undefined);
      c.nodeUrl = 'wss://node.example';
      await saveNetworkConfig('testnet-10', c);
      await lock();
      const l = mergeConfig('simnet', undefined);
      l.covenantId = '77'.repeat(32);
      await saveNetworkConfig('simnet', l);
      expect((await loadSettings()).overrides.simnet).toEqual({ covenantId: '77'.repeat(32) });
      await resetNetworkConfig('simnet');
      await unlockWith(P);
      const s = await loadSettings();
      expect(s.overrides['testnet-10']).toEqual({ nodeUrl: 'wss://node.example' });
      expect(s.overrides.simnet).toBeUndefined();
      // Unlocked, a reset of the testnet edit removes it and its mark.
      await resetNetworkConfig('testnet-10');
      expect((await loadSettings()).overrides).toEqual({});
      expect(((await local.get(SETTINGS_KEY)) as any).overrideMacs).toEqual({});
    } finally { await lock(); await local.remove(SETTINGS_KEY); }
  });
});
