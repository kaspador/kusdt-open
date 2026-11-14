// The approval window a site's request opens, for a wallet that has not accepted the
// Terms of Service: it shows the terms first, says a site is waiting, and shows the
// request only once they are accepted. (A file of its own: the popup reads whether
// it is an approval window from its address when it loads.)

import { beforeAll, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { button, checkbox, click, fakeWindow, findButton, mount, toggle, until } from './fake-dom';

vi.hoisted(() => {
  (globalThis as { chrome?: unknown }).chrome = {
    storage: { onChanged: { addListener() {}, removeListener() {} } },
    runtime: { connect() {} },
    extension: { getViews: () => [] },
  };
});
vi.mock('@/popup/state', async () => {
  const { createElement: el, Fragment } = await import('react');
  return { WalletProvider: ({ children }: { children: unknown }) => el(Fragment, null, children as never), useWallet: () => null };
});
vi.mock('@/screens/Approve', async () => {
  const { createElement: el } = await import('react');
  return { Approve: () => el('p', null, 'THE SITE\'S REQUEST') };
});

import { TERMS_VERSION } from '@/config/terms';
import { local } from '@/lib/storage';
import { createVault } from '@/keys/vault';
import { unlockWith } from '@/keys/session';

const PHRASE = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';

beforeAll(async () => {
  await createVault(PHRASE, 'terms-test-password');
  await unlockWith(PHRASE);
});

describe('the approval window of a wallet that has not accepted the terms', () => {
  it('holds the request behind the terms, says so, and shows it once they are accepted', async () => {
    fakeWindow.location.hash = '#request=terms-request-1';
    const { App } = await import('@/popup/App');
    const { root } = await mount(createElement(App));
    await until('the terms', () => findButton(root, 'Continue'));
    expect(root.textContent).toContain('A site is waiting for an answer');
    expect(root.textContent).not.toContain('THE SITE\'S REQUEST');
    expect(button(root, 'Continue').disabled).toBe(true);
    await toggle(checkbox(root));
    await click(button(root, 'Continue'));
    await until('the request', () => root.textContent.includes('THE SITE\'S REQUEST'));
    expect(await local.get('kusdt.terms.accepted')).toBe(TERMS_VERSION);
  });
});
