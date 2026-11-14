// The Terms of Service of Trestly, which cover this wallet too. They are published by
// the web app at /terms of each network's site (its text: bridge/web/src/terms/terms.md);
// the wallet links there and remembers which version was accepted. A new version of
// the text means a new TERMS_VERSION here: every wallet that accepted an older one asks
// again at its next unlock (test/terms.test.ts holds this to the text's version line).

import { local } from '@/lib/storage';
import type { KaspaNetworkName } from './defaults';
import { NETWORKS } from './networks';

export const TERMS_VERSION = 1;
export const TERMS_KEY = 'kusdt.terms.accepted';

export async function termsAccepted(): Promise<boolean> {
  const v = await local.get<unknown>(TERMS_KEY);
  return typeof v === 'number' && v >= TERMS_VERSION;
}

export const acceptTerms = (): Promise<void> => local.set({ [TERMS_KEY]: TERMS_VERSION });

/** The terms page of the network's web app. */
export const termsUrl = (network: KaspaNetworkName): string => `${NETWORKS[network].site}/terms`;

/**
 * The Privacy Policy page of the network's web app (its text: bridge/web/src/privacy/privacy.md), which covers this
 * wallet too. Linked from Settings; nothing is accepted or stored for it.
 */
export const privacyUrl = (network: KaspaNetworkName): string => `${NETWORKS[network].site}/privacy`;

/** What a site is told while the terms wait to be accepted: no request of its is approved or answered before. */
export const TERMS_REFUSAL = 'kUSDT Wallet\'s Terms of Service have not been accepted yet. Open kUSDT Wallet, read and accept them, then try again.';
