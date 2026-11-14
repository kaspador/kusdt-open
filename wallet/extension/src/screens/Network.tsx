// The Network screen: Testnet, Local and Mainnet as cards, one tap to switch.
// Mainnet can't be picked while nothing is deployed there. The active network
// has "Advanced: endpoints and deployment", the form for every value of its
// config (stored per network; the chain names are the preset's).

import { useEffect, useState, type ReactNode } from 'react';
import { CHAIN_KEYS, type ChainKey, type KaspaNetworkName, type NetworkConfig } from '@/config/defaults';
import { configProblem, deploymentLocked, loadSettings, mergeConfig, networkLive, resetNetworkConfig, saveNetworkConfig, saveSettings, type StoredSettings } from '@/config/settings';
import { NETWORKS, NETWORK_ORDER, chainsLine } from '@/config/networks';
import { readLocalDeployment, withLocalDeployment } from '@/config/local';
import { useWallet } from '@/popup/state';
import { NetDot } from '@/popup/nav';
import { LocalStackNotice } from './Home';
import { Body, Button, Card, Field, Header, Input, ListRow, Notice, Pill, TextArea, toast, errText } from '@/ui/kit';
import { CheckIcon, ServerIcon } from '@/ui/icons';

const STATUS: Record<KaspaNetworkName, string> = {
  'testnet-10': 'Live · test coins, no real value',
  simnet: 'On this computer · test coins only',
  mainnet: 'Real funds',
};

export function NetworkScreen({ onBack, onAdvanced }: { onBack: () => void; onAdvanced: () => void }) {
  const w = useWallet();
  const [s, setS] = useState<StoredSettings | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => { loadSettings().then(setS); }, []);
  const current = w.active.network;

  async function pick(n: KaspaNetworkName) {
    if (busy) return;
    if (n === current) { onBack(); return; }
    setBusy(true);
    try { await saveSettings({ network: n }); await w.reloadConfig(); onBack(); }
    finally { setBusy(false); }
  }

  return (
    <>
      <Header title="Network" onBack={onBack} />
      <Body>
        <p className="text-[13px] text-pearl-500 leading-relaxed px-0.5 -mt-0.5">Each network has its own coins, addresses and deployment. Your recovery phrase works on all of them.</p>
        <div className="flex flex-col gap-2" role="radiogroup" aria-label="Network">
          {NETWORK_ORDER.map(n => {
            const info = NETWORKS[n];
            const live = s ? networkLive(n, s.overrides) : n !== 'mainnet';
            const on = n === current;
            const disabled = !live && !on;
            return (
              <button key={n} type="button" role="radio" aria-checked={on} disabled={disabled || busy} onClick={() => pick(n)}
                className={`choice items-start py-3 ${on ? 'on' : ''}`}>
                <span className="mt-[5px]"><NetDot network={n} /></span>
                <span className="flex-1 min-w-0">
                  <span className="flex items-center gap-2">
                    <span className={`text-[14px] font-semibold ${disabled ? 'text-pearl-500' : 'text-pearl-200'}`}>{info.name}</span>
                    {!live && <Pill tone="outline">Not live yet</Pill>}
                  </span>
                  <span className={`block text-xs mt-0.5 ${disabled ? 'text-pearl-600' : 'text-pearl-400'}`}>{chainsLine(n)}</span>
                  <span className={`block text-xs mt-1 ${disabled ? 'text-pearl-600' : 'text-pearl-500'}`}>{live ? STATUS[n] : 'Nothing is deployed on mainnet yet'}</span>
                </span>
                {on && <span className="check-badge mt-0.5"><CheckIcon size={12} strokeWidth={3} /></span>}
              </button>
            );
          })}
        </div>
        <LocalStackNotice />
        <div className="list mt-1">
          <ListRow icon={<ServerIcon size={17} />} label="Advanced: endpoints and deployment" sub={`For ${NETWORKS[current].name}: node, coordinator, covenant and vaults`} onClick={onAdvanced} />
        </div>
      </Body>
    </>
  );
}

function Section({ title, sub, children }: { title: string; sub?: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-3">
      <h2 className="text-[13px] font-semibold text-pearl-300 px-0.5 mt-1">{title}{sub && <span className="font-normal text-pearl-500"> · {sub}</span>}</h2>
      {children}
    </section>
  );
}

/** Every value of the active network's config. Saved per network; only what differs from the preset is stored. */
export function NetworkEditor({ onBack }: { onBack: () => void }) {
  const w = useWallet();
  const net = w.active.network;
  const [c, setC] = useState<NetworkConfig | null>(null);
  /** The RPC lists as typed (a new line stays while it is still empty). */
  const [rpcText, setRpcText] = useState<Record<ChainKey, string>>({ ethereum: '', bsc: '' });
  const [err, setErr] = useState<string | null>(null);
  const take = (next: NetworkConfig) => { setC(next); setRpcText({ ethereum: next.chains.ethereum.rpcUrls.join('\n'), bsc: next.chains.bsc.rpcUrls.join('\n') }); };
  useEffect(() => { loadSettings().then(s => take(mergeConfig(net, s.overrides[net]))); }, [net]);
  if (!c) return null;
  const set = (k: keyof NetworkConfig, v: string) => setC({ ...c, [k]: v.trim() });
  const setChain = (k: ChainKey, f: string, v: string | number | string[]) => setC({ ...c, chains: { ...c.chains, [k]: { ...c.chains[k], [f]: v } } });

  async function save() {
    const problem = configProblem(c!);
    if (problem) { setErr(problem); return; }
    await saveNetworkConfig(net, c!);
    await w.reloadConfig();
    toast('Saved');
    onBack();
  }
  async function reset() {
    await resetNetworkConfig(net);
    take(mergeConfig(net, undefined));
    setErr(null);
    await w.reloadConfig();
    toast('Defaults restored');
  }
  // Local only: the local stack's deployment changes with every run. On Testnet and Mainnet the deployment
  // is pinned here by the user, never taken from a server (config/local.ts answers nothing for them).
  async function fillFromStack() {
    setErr(null);
    try {
      const d = await readLocalDeployment(net, c!.apiUrl);
      if (!d) throw new Error('The local stack is not answering (the faucet on 127.0.0.1:9099, or the coordinator).');
      setC(withLocalDeployment(c!, d));
      toast('Filled in: check, then Save');
    } catch (e) { setErr(errText(e)); }
  }
  const text = (label: string, k: keyof NetworkConfig, hint?: string) => (
    <Field label={label} hint={hint}><Input value={String(c[k])} onChange={e => set(k, e.target.value)} className="mono text-[12px]" /></Field>
  );
  /** A 64-hex ID, on two lines so all of it shows. */
  const id = (label: string, k: 'covenantId' | 'poolId', hint?: string) => (
    <Field label={label} hint={hint}><TextArea rows={2} value={c[k]} disabled={deploymentLocked(net, null, k)} onChange={e => set(k, e.target.value.replace(/\s+/g, ''))} className="mono text-[12px] break-all" /></Field>
  );
  return (
    <>
      <Header title="Advanced" onBack={onBack} right={<span className="text-xs text-pearl-500 mono pr-1.5">{net}</span>} />
      <Body>
        <Notice>Endpoints and the pinned deployment for {NETWORKS[net].name}: {chainsLine(net)}. An empty field means the preset's value. Change these only if you know why.</Notice>
        <Section title="Kaspa">
          {text('Kaspa node (wRPC JSON)', 'nodeUrl', net === 'simnet' ? undefined : 'Empty: a node of the public Kaspa node network.')}
          {text('Coordinator API', 'apiUrl', 'Ends in /api/v1. Read-only; everything it says is checked against the node.')}
        </Section>
        <Section title="Deployment">
          {id('kUSDT covenant ID', 'covenantId', 'The token this wallet trusts.')}
          {id('Pool covenant ID', 'poolId')}
          {text('KAS per token state (sompi)', 'tokenValue', '150000000 = 1.5 KAS, kept in each new token for its storage mass.')}
          {text('KAS per liquidity position (sompi)', 'positionValue')}
          {text('KAS per burn (sompi)', 'burnValue', '30000000 = 0.3 KAS, locked for good with each redemption.')}
          {net === 'simnet' && <Button kind="secondary" onClick={fillFromStack}>Fill from the local stack</Button>}
        </Section>
        {CHAIN_KEYS.map(k => {
          const ch = c.chains[k];
          return (
            <Section key={k} title={ch.name} sub={k === 'ethereum' ? 'chain 1, the Ethereum side' : 'chain 2, the BNB Chain side'}>
              <Card pad="p-3.5" className="flex flex-col gap-3">
                <Field label="Chain ID"><Input value={String(ch.chainId)} disabled={deploymentLocked(net, k, 'chainId')} onChange={e => setChain(k, 'chainId', Number(e.target.value))} className="mono text-[12px]" /></Field>
                <Field label="KusdtVault"><Input value={ch.vault} disabled={deploymentLocked(net, k, 'vault')} onChange={e => setChain(k, 'vault', e.target.value.trim())} className="mono text-[12px]" /></Field>
                <Field label="USDT token"><Input value={ch.token} disabled={deploymentLocked(net, k, 'token')} onChange={e => setChain(k, 'token', e.target.value.trim())} className="mono text-[12px]" /></Field>
                <Field label="USDT decimals"><Input value={String(ch.decimals)} disabled={deploymentLocked(net, k, 'decimals')} onChange={e => setChain(k, 'decimals', Number(e.target.value))} className="mono text-[12px]" /></Field>
                <Field label="RPC URLs (one per line)">
                  <TextArea rows={2} className="mono text-[12px]" value={rpcText[k]}
                    onChange={e => { setRpcText({ ...rpcText, [k]: e.target.value }); setChain(k, 'rpcUrls', e.target.value.split('\n').map(x => x.trim()).filter(Boolean)); }} />
                </Field>
              </Card>
            </Section>
          );
        })}
        {err && <Notice tone="error">{err}</Notice>}
        <div className="flex flex-col gap-2 mt-1">
          <Button size="lg" onClick={save}>Save</Button>
          <Button kind="secondary" onClick={reset}>Restore defaults</Button>
        </div>
      </Body>
    </>
  );
}
