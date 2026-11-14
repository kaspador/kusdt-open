// Loads the built extension (dist/) in Chromium and checks it end to end in a
// real browser: the popup, the WebAssembly core under the extension's CSP
// (in the popup and in the service worker), window.kusdt on a page, a site
// connection approved in the wallet's window, and balances read for it.
//
//   npm run build && node scripts/smoke.mjs
//
// Needs a Chromium (CHROMIUM=path, else Playwright's under %LOCALAPPDATA%) and
// the local simnet node (ws://127.0.0.1:18610). Uses a throwaway profile and a
// test phrase; nothing here touches real funds.

import { chromium } from 'playwright-core';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { schnorr } from '@noble/curves/secp256k1.js';

const dist = path.resolve(import.meta.dirname, '../dist');
const exe = process.env.CHROMIUM ?? path.join(os.homedir(), 'AppData/Local/ms-playwright/chromium-1194/chrome-win/chrome.exe');
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'kusdt-smoke-'));
const PHRASE = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const ok = (m) => console.log('ok  ', m);
const fail = (m) => { console.error('FAIL', m); process.exitCode = 1; };

// The test phrase's first key (bridge/packages/kaspa fixtures), and a coordinator that lists one invented state for it.
const OWNER = Buffer.from(schnorr.getPublicKey(Buffer.from('24cd8d2875e8e17e4f88fbc554834a89b7b3e0c6f9d84fae36883604359ba440', 'hex'))).toString('hex');
const server = http.createServer((q, r) => {
  if (q.url.startsWith('/api/v1/tokens')) {
    r.setHeader('content-type', 'application/json'); r.setHeader('access-control-allow-origin', '*');
    r.end(JSON.stringify({ states: [{ utxo: { transactionId: 'ab'.repeat(32), index: 0 }, state: { amount: 5000000, owner: OWNER, ownerScheme: 0, borrowScheme: 0, borrowGuard: '00'.repeat(32), extensionCommitment: '00'.repeat(32) } }] }));
    return;
  }
  r.setHeader('content-type', 'text/html'); r.end('<!doctype html><title>dapp</title><p>test page</p>');
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const pageUrl = `http://127.0.0.1:${server.address().port}/`;

const ctx = await chromium.launchPersistentContext(profile, {
  executablePath: exe, headless: false,
  args: ['--headless=new', `--disable-extensions-except=${dist}`, `--load-extension=${dist}`],
});
try {
  const sw = ctx.serviceWorkers()[0] ?? await ctx.waitForEvent('serviceworker');
  const id = new URL(sw.url()).host;
  ok(`service worker up (${id})`);
  const errors = [];
  sw.on?.('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

  const popup = await ctx.newPage();
  popup.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  await popup.goto(`chrome-extension://${id}/src/popup/index.html`);
  await popup.getByText('Create a new wallet').waitFor();
  ok('popup shows onboarding');

  // The simnet network, so the local node is used.
  const apiUrl = pageUrl + 'api/v1';
  await popup.evaluate((apiUrl) => new Promise(r => chrome.storage.local.set({ 'kusdt.settings': { network: 'simnet', autoLockMins: 15, overrides: { simnet: { apiUrl, covenantId: '11'.repeat(32), poolId: '22'.repeat(32) } } } }, r)), apiUrl);
  await popup.reload();
  // The Terms of Service box comes first (screens/Terms.tsx): creating and importing stay off until it is ticked.
  await popup.getByRole('checkbox').check();
  await popup.getByText('I have a recovery phrase').click();
  await popup.locator('textarea').fill(PHRASE);
  const pw = popup.locator('input[type=password]');
  await pw.nth(0).fill('smoke-test-password');
  await pw.nth(1).fill('smoke-test-password');
  await popup.getByRole('button', { name: 'Import' }).click();
  await popup.getByText('kaspasim:qqd6e65y', { exact: false }).waitFor({ timeout: 60_000 });
  ok('imported; the main address is the vector address');
  // KAS balance from the node and the core loaded (kUSDT says why it can't show, never a WebAssembly error).
  await popup.waitForFunction(() => /KAS/.test(document.body.innerText) && !/Loading/.test(document.body.innerText), null, { timeout: 30_000 });
  const text = await popup.evaluate(() => document.body.innerText);
  if (/WebAssembly|CompileError|unsafe-eval|Content Security/i.test(text)) fail(`core did not load in the popup: ${text}`);
  else ok('popup: no WebAssembly or CSP error');
  await popup.getByText('failed verification', { exact: false }).waitFor({ timeout: 30_000 });
  ok('popup: the core recomputed an invented state script; the node did not have it: rejected, not counted');

  if (process.env.SHOT) { await popup.setViewportSize({ width: 400, height: 600 }); await popup.screenshot({ path: path.join(process.env.SHOT, 'home.png') }); }
  const page = await ctx.newPage();
  await page.goto(pageUrl);
  await page.waitForFunction(() => !!window.kusdt, null, { timeout: 10_000 });
  ok('window.kusdt is injected');
  const net = await page.evaluate(() => window.kusdt.request({ method: 'kaspa_getNetwork' }));
  net === 'simnet' ? ok('kaspa_getNetwork → simnet') : fail(`kaspa_getNetwork → ${net}`);
  const refused = await page.evaluate(() => window.kusdt.request({ method: 'kusdt_getBalances' }).then(() => 'answered', e => e.code));
  refused === 4100 ? ok('kusdt_getBalances refused before connecting (4100)') : fail(`getBalances before connect: ${refused}`);

  const winp = ctx.waitForEvent('page', { predicate: p => p.url().includes('#request=') });
  const asking = page.evaluate(() => window.kusdt.request({ method: 'kaspa_requestAccounts' }));
  const win = await winp;
  await win.getByRole('button', { name: 'Connect' }).click();
  const accounts = await asking;
  accounts?.[0]?.startsWith('kaspasim:qqd6e65y') ? ok('connect approved in the wallet window') : fail(`accounts: ${JSON.stringify(accounts)}`);
  const balances = await page.evaluate(() => window.kusdt.request({ method: 'kusdt_getBalances' }).catch(e => ({ error: e.message })));
  typeof balances?.kas === 'string' ? ok(`kusdt_getBalances (service worker, core loaded there too): ${JSON.stringify(balances)}`) : fail(`balances: ${JSON.stringify(balances)}`);

  const win2p = ctx.waitForEvent('page', { predicate: p => p.url().includes('#request=') });
  const send = page.evaluate((to) => window.kusdt.request({ method: 'kusdt_send', params: { to, amount: '1' } }).then(() => 'sent', e => ({ code: e.code, message: e.message })), accounts[0]);
  const early = await Promise.race([send, new Promise(r => setTimeout(() => r(null), 3_000))]);
  if (early) fail(`kusdt_send answered without a window: ${JSON.stringify(early)}`);
  const win2 = await win2p;
  await win2.getByText('Approve a transaction').waitFor();
  await win2.getByRole('button', { name: 'Reject' }).click();
  const code = (await send)?.code;
  code === 4001 ? ok('a signing request opens the window; Reject answers 4001') : fail(`send: ${code}`);

  const bad = errors.filter(e => /WebAssembly|CompileError|unsafe-eval|Content Security/i.test(e));
  bad.length ? fail(`console: ${bad.join(' | ')}`) : ok('no CSP or WebAssembly errors in the console');
} finally {
  await ctx.close();
  server.close();
  fs.rmSync(profile, { recursive: true, force: true });
}
