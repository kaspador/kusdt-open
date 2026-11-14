// The Terms of Service in the wallet: the box to tick, linked to the terms page of
// the network's web app (config/terms.ts), on the welcome screen before a wallet is
// created or imported, and as a screen of its own when a wallet made before the
// terms (or before their current version) is unlocked. The text itself is not
// repeated here: the link shows the one approved text.

import { useEffect, useState } from 'react';
import { BRAND } from '@/brand';
import { loadSettings } from '@/config/settings';
import { DEFAULT_NETWORK, type KaspaNetworkName } from '@/config/defaults';
import { acceptTerms, termsUrl } from '@/config/terms';
import { Body, Button, Checkbox, Footer, Header, Notice, errText } from '@/ui/kit';
import { ExternalIcon } from '@/ui/icons';

/** The wallet's network, for the link: the default one until the settings are read. */
function useNetwork(): KaspaNetworkName {
  const [net, setNet] = useState<KaspaNetworkName>(DEFAULT_NETWORK);
  useEffect(() => { loadSettings().then(s => setNet(s.network)).catch(() => {}); }, []);
  return net;
}

/** "I have read and accept the Terms of Service", the last words a link to them (a new tab). */
export function TermsCheck({ checked, onChange }: { checked: boolean; onChange: (v: boolean) => void }) {
  const url = termsUrl(useNetwork());
  return (
    <Checkbox checked={checked} onChange={onChange}>
      I have read and accept the <a href={url} target="_blank" rel="noreferrer" className="underline text-pearl-200 inline-flex items-center gap-0.5" data-testid="terms-link">Terms of Service<ExternalIcon size={11} /></a>
    </Checkbox>
  );
}

/**
 * Before anything else, once unlocked: a wallet that has not accepted this version of the terms. Nothing of the
 * wallet opens behind it, a site's request included (`request`: this window was opened for one).
 */
export function TermsGate({ request, onAccepted }: { request: boolean; onAccepted: () => void }) {
  const [ticked, setTicked] = useState(false);
  const [busy, setBusy] = useState(false), [err, setErr] = useState<string | null>(null);
  async function go() {
    if (!ticked || busy) return;
    setBusy(true); setErr(null);
    try { await acceptTerms(); onAccepted(); } catch (e) { setErr(errText(e)); } finally { setBusy(false); }
  }
  return (
    <>
      <Header title="Terms of Service" />
      <Body>
        <p className="text-[13.5px] text-pearl-300 leading-relaxed px-0.5">{BRAND} and the Trestly web app have Terms of Service. Read them, then accept them to go on using the wallet.</p>
        {request && <Notice tone="warn">A site is waiting for an answer from {BRAND}. Its request is shown once you have accepted the terms; until then nothing is approved.</Notice>}
        <TermsCheck checked={ticked} onChange={setTicked} />
        {err && <Notice tone="error">{err}</Notice>}
      </Body>
      <Footer>
        <Button size="lg" disabled={!ticked || busy} onClick={go}>Continue</Button>
      </Footer>
    </>
  );
}

