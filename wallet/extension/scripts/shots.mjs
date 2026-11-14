// Screenshots of every popup screen at the popup's real size (400 × 600), for
// design reviews. Loads the built extension (dist/) in Chromium with a throwaway
// profile and the public test phrase; nothing here touches real funds.
//
//   npm run build && node scripts/shots.mjs <out dir> [network] [light|dark] [--with-activity] [--states]
//
// network: as stored in the settings (testnet-10, simnet, mainnet). For simnet
// (Local) the deployment comes from the local stack's faucet
// (http://127.0.0.1:9099/stack): the wallet first pins a stale one, so the
// "the local stack restarted" banner shows, then takes the stack's in one tap.
// The faucet funds the test phrase's addresses there (KAS, mock USDT, gas).
// With --with-activity the wallet also makes one swap and one deposit through
// its own screens on Local (local development coins only), so Activity has rows.
// With --states (Local only) the pool is also shown paused and never opened, through
// the screenshot-only proxies of scripts/shots-fixture.mjs; nothing is sent there.
// Approval windows are photographed at their real size, 400 × 640.

import { chromium } from 'playwright-core';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startFixture } from './shots-fixture.mjs';

const dist = path.resolve(import.meta.dirname, '../dist');
const exe = process.env.CHROMIUM ?? path.join(os.homedir(), 'AppData/Local/ms-playwright/chromium-1194/chrome-win/chrome.exe');
const args = process.argv.slice(2).filter(a => !a.startsWith('--'));
const flags = new Set(process.argv.slice(2).filter(a => a.startsWith('--')));
const out = path.resolve(args[0] ?? 'shots');
const network = args[1] ?? 'testnet-10';
const theme = args[2] === 'dark' ? 'dark' : 'light';
const withActivity = flags.has('--with-activity') && network === 'simnet';
const withStates = flags.has('--states') && network === 'simnet';
const FAUCET = process.env.KUSDT_FAUCET ?? 'http://127.0.0.1:9099';
const PHRASE = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
/** The test phrase's EVM account (m/44'/60'/0'/0/0). */
const EVM = '0x9858EfFD232B4033E47d90003D41EC34EcaEda94';
fs.mkdirSync(out, { recursive: true });
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'kusdt-shots-'));

// A page for the approval windows (window.kusdt is offered to http://127.0.0.1).
const server = http.createServer((q, r) => { r.setHeader('content-type', 'text/html'); r.end('<!doctype html><title>Example dapp</title><p>dapp</p>'); });
await new Promise(r => server.listen(0, '127.0.0.1', r));
const pageUrl = `http://127.0.0.1:${server.address().port}/`;

const ctx = await chromium.launchPersistentContext(profile, {
  executablePath: exe, headless: false, viewport: { width: 400, height: 600 }, colorScheme: theme,
  args: ['--headless=new', `--disable-extensions-except=${dist}`, `--load-extension=${dist}`],
});
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const shot = async (page, name, { full = false, wait = 700 } = {}) => {
  await page.waitForTimeout(wait);
  if (full) {
    // The whole scrolling body, as if the popup were tall enough.
    const style = await page.addStyleTag({ content: '.popup-shell { height: auto !important; min-height: 600px; overflow: visible !important; } .popup-shell * { overflow: visible !important; }' });
    await page.waitForTimeout(250);
    await page.screenshot({ path: path.join(out, `${name}.png`), fullPage: true });
    await style.evaluate(el => el.remove());
    await page.waitForTimeout(150);
  } else {
    await page.screenshot({ path: path.join(out, `${name}.png`) });
  }
  console.log('shot', name);
};
const attempt = async (name, fn) => { try { await fn(); } catch (e) { console.log(`skip ${name}: ${e.message.split('\n')[0]}`); } };
const until = async (what, fn, ms = 60_000, every = 500) => {
  const end = Date.now() + ms;
  for (;;) { try { const v = await fn(); if (v) return v; } catch { /* again */ } if (Date.now() > end) throw new Error(`timed out waiting for ${what}`); await sleep(every); }
};
const post = (url, body) => fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).then(r => r.json());

try {
  const sw = ctx.serviceWorkers()[0] ?? await ctx.waitForEvent('serviceworker');
  const id = new URL(sw.url()).host;
  const popup = await ctx.newPage();
  await popup.goto(`chrome-extension://${id}/src/popup/index.html`);
  await popup.getByText('Create a new wallet').waitFor();
  // The theme for every wallet window (Settings → Theme), as the wallet itself stores it.
  await popup.evaluate((t) => localStorage.setItem('kusdt.theme', t), theme);
  await popup.reload();
  await popup.getByText('Create a new wallet').waitFor();
  await shot(popup, '00-welcome');

  let stack = null;
  let overrides = {};
  if (network === 'simnet') {
    stack = await (await fetch(`${FAUCET}/stack`)).json();
    // A stale deployment first, so the wallet offers the stack's new one.
    overrides = { simnet: { covenantId: '00'.repeat(32), poolId: '00'.repeat(32) } };
  }
  await popup.evaluate(([network, overrides]) => new Promise(r => chrome.storage.local.set({ 'kusdt.settings': { network, autoLockMins: 60, overrides } }, r)), [network, overrides]);
  await popup.reload();
  // The Terms of Service box comes first (screens/Terms.tsx): creating and importing stay off until it is ticked.
  await popup.getByRole('checkbox').check();
  await popup.getByText('I have a recovery phrase').click();
  await shot(popup, '01-import');
  await popup.locator('textarea').fill(PHRASE);
  const pw = popup.locator('input[type=password]');
  await pw.nth(0).fill('shots-test-password');
  await pw.nth(1).fill('shots-test-password');
  await popup.getByRole('button', { name: 'Import' }).click();
  await popup.waitForFunction(() => /KAS/.test(document.body.innerText), null, { timeout: 60_000 });
  const kaspaAddress = await popup.locator('.chip').first().getAttribute('title');

  const tab = async (label) => { await popup.locator('nav.bottom-nav button', { hasText: label }).first().click(); await popup.waitForTimeout(500); };
  const button = (name) => popup.getByRole('button', { name, exact: true });
  const back = async () => { await popup.getByLabel('Back').first().click(); await popup.waitForTimeout(350); };

  if (network === 'simnet') {
    await attempt('local-stack banner', async () => {
      await post(`${FAUCET}/faucet`, { kaspa: kaspaAddress, kas: 500, evm: EVM, usdt: 200 });
      await popup.getByText('The local stack restarted', { exact: false }).waitFor({ timeout: 15_000 });
      await shot(popup, '02a-home-local-stack-restarted');
      await button('Use its new deployment').click();
      await popup.getByText('The local stack restarted', { exact: false }).waitFor({ state: 'detached', timeout: 15_000 });
    });
  }
  if (withActivity) {
    await attempt('activity: a swap', async () => {
      await until('the faucet KAS', async () => {
        await popup.getByLabel('Refresh balances').click().catch(() => {});
        await sleep(1_500);
        return /[1-9]/.test(await popup.locator('[data-balance=kas]').innerText());
      }, 90_000, 1_000);
      await tab('Swap');
      await popup.getByLabel('You pay').fill('20');
      await until('a quote', async () => button('Swap KAS for kUSDT').isEnabled(), 30_000);
      await button('Swap KAS for kUSDT').click();
      await popup.getByText('Swapped', { exact: true }).waitFor({ timeout: 120_000 });
      await button('Done').click();
    });
    await attempt('activity: a deposit', async () => {
      await tab('Bridge');
      await popup.getByLabel('USDT to bridge').fill('20');
      await until('the vault quote', async () => button('Approve and deposit').isEnabled(), 30_000);
      await button('Approve and deposit').click();
      await popup.getByText('Deposit sent', { exact: true }).waitFor({ timeout: 120_000 });
      await shot(popup, '06e-bridge-deposit-sent');
      await button('Done').click();
    });
    await tab('Wallet');
  }
  await popup.waitForTimeout(2500);
  await popup.getByLabel('Refresh balances').click().catch(() => {});
  await popup.waitForTimeout(2500);
  await shot(popup, '02-home');

  await attempt('03-receive', async () => { await button('Receive').click(); await shot(popup, '03-receive'); await back(); });
  await attempt('04-send', async () => {
    await button('Send').click();
    await shot(popup, '04-send');
    await popup.locator('textarea').fill(kaspaAddress);
    await popup.getByLabel('Amount').fill('1');
    await shot(popup, '04b-send-filled');
    await back();
  });
  await attempt('05-swap', async () => {
    await tab('Swap');
    await shot(popup, '05-swap', { wait: 2500 });
    await popup.getByLabel('You pay').fill('10');
    await shot(popup, '05b-swap-quote', { wait: 1500 });
    await popup.getByLabel('Slippage settings').click();
    await shot(popup, '05c-swap-slippage');
    await popup.getByLabel('Slippage settings').click();
  });
  if (network === 'simnet') await attempt('05d-swap-sell-breaker', async () => {
    await popup.getByLabel(/^Switch to /).click();
    await popup.getByLabel('You pay').fill('1');
    await popup.getByTestId('breaker-notice').waitFor({ timeout: 20_000 });
    await shot(popup, '05d-swap-sell-breaker', { wait: 600 });
    await shot(popup, '05e-swap-sell-breaker-full', { full: true, wait: 100 });
    await popup.getByLabel('You pay').fill('0.1');
    await shot(popup, '05f-swap-sell-fits', { wait: 900 });
    await popup.getByLabel(/^Switch to /).click();
  });
  await attempt('06-bridge', async () => {
    await tab('Bridge');
    await shot(popup, '06-bridge', { wait: 2500 });
    await popup.getByLabel('USDT to bridge').fill('20');
    await shot(popup, '06b-bridge-deposit-quote', { wait: 2500 });
    await popup.getByRole('radio', { name: 'kUSDT → USDT' }).click();
    await shot(popup, '06c-bridge-redeem', { wait: 2000 });
    await popup.getByLabel('kUSDT to redeem').fill('5');
    await shot(popup, '06d-bridge-redeem-quote', { wait: 2500 });
    await shot(popup, '06f-bridge-redeem-full', { full: true, wait: 100 });
    await popup.getByRole('radio', { name: 'USDT → kUSDT' }).click();
  });
  if (network === 'simnet') await attempt('06g-bridge-test-usdt', async () => {
    await popup.getByRole('button', { name: 'Get 1,000 test USDT' }).click();
    await popup.getByText('test USDT minted', { exact: false }).waitFor({ timeout: 60_000 });
    await shot(popup, '06g-bridge-test-usdt', { wait: 1500 });
    await shot(popup, '06h-bridge-test-usdt-full', { full: true, wait: 100 });
  });
  await attempt('07-pool', async () => { await tab('Pool'); await shot(popup, '07-pool', { wait: 2500 }); });
  await attempt('07b-pool-add', async () => {
    await button('Add liquidity').click();
    await shot(popup, '07b-pool-add', { wait: 800 });
    await popup.getByLabel('KAS', { exact: true }).fill('5');
    await shot(popup, '07c-pool-add-filled', { wait: 900 });
    await shot(popup, '07d-pool-add-full', { full: true, wait: 100 });
    await back();
  });
  await attempt('08-activity', async () => { await tab('Activity'); await shot(popup, '08-activity', { wait: 1500 }); });
  await attempt('09-settings', async () => {
    await tab('Wallet');
    await button('Settings').click();
    await shot(popup, '09-settings');
    await popup.getByRole('button', { name: /^Theme/ }).click();
    await shot(popup, '09b-settings-theme');
    await back();
    await popup.getByRole('button', { name: /^Auto-lock/ }).click();
    await shot(popup, '09c-settings-autolock');
    await back();
    await back();
  });
  await attempt('10-network', async () => {
    await popup.getByRole('button', { name: /Change network/ }).click();
    await shot(popup, '10-network');
    await popup.getByRole('button', { name: /Advanced: endpoints and deployment/ }).click();
    await shot(popup, '11-advanced');
    await shot(popup, '11b-advanced-full', { full: true, wait: 100 });
    await back();
    await back();
  });

  // The approval window: a site connects, then asks for a kUSDT send.
  await attempt('12-approve', async () => {
    const page = await ctx.newPage();
    await page.goto(pageUrl);
    await page.waitForFunction(() => !!window.kusdt, null, { timeout: 10_000 });
    const w1p = ctx.waitForEvent('page', { predicate: p => p.url().includes('#request=') });
    const asking = page.evaluate(() => window.kusdt.request({ method: 'kaspa_requestAccounts' }));
    const w1 = await w1p;
    await w1.setViewportSize({ width: 400, height: 640 });
    await w1.getByRole('button', { name: 'Connect' }).waitFor();
    await shot(w1, '12-approve-connect', { wait: 1200 });
    await w1.getByRole('button', { name: 'Connect' }).click();
    const accounts = await asking;
    const w2p = ctx.waitForEvent('page', { predicate: p => p.url().includes('#request=') });
    const send = page.evaluate((to) => window.kusdt.request({ method: 'kusdt_send', params: { to, amount: '1000000' } }).catch(e => e.code), accounts[0]);
    const w2 = await w2p;
    await w2.setViewportSize({ width: 400, height: 640 });
    await w2.getByText('Approve a transaction').waitFor();
    await until('the request prepared', async () => (await w2.locator('.notice-error').count()) > 0 || (await w2.getByRole('button', { name: 'Approve' }).isEnabled()), 30_000);
    await shot(w2, '13-approve-send', { wait: 600 });
    await w2.getByRole('button', { name: 'Reject' }).click();
    await send;
    // The site asks to switch the network: the wallet's "Switch network" window.
    const target = network === 'testnet-10' ? 'simnet' : 'testnet-10';
    const w3p = ctx.waitForEvent('page', { predicate: p => p.url().includes('#request=') });
    const switching = page.evaluate((n) => window.kusdt.request({ method: 'kaspa_switchNetwork', params: { network: n } }).catch(e => e.code), target);
    const w3 = await w3p;
    await w3.setViewportSize({ width: 400, height: 640 });
    await w3.getByRole('button', { name: 'Switch', exact: true }).waitFor();
    await shot(w3, '13b-approve-switch-network', { wait: 900 });
    await w3.getByRole('button', { name: 'Reject' }).click();
    console.log('switch answer', await switching);
    // On Local: a sell above the breaker's room, as a site would ask it: refused, with Approve off.
    if (network === 'simnet') {
      const w4p = ctx.waitForEvent('page', { predicate: p => p.url().includes('#request=') });
      const selling = page.evaluate(() => window.kusdt.request({ method: 'kusdt_swap', params: { side: 'sell', amountIn: '1000000', minOut: '20000000' } }).catch(e => e.code));
      const w4 = await w4p;
      await w4.setViewportSize({ width: 400, height: 640 });
      await w4.getByText('circuit breaker', { exact: false }).waitFor({ timeout: 30_000 });
      await shot(w4, '13c-approve-sell-breaker', { wait: 600 });
      await w4.getByRole('button', { name: 'Reject' }).click();
      console.log('sell answer', await selling);
    }
    await page.close();
  });

  if (withStates) await attempt('15-states', async () => {
    const dep = stack.deployment;
    const fx = await startFixture({ api: stack.api, node: stack.kaspa.rpc, prefix: 'kaspasim', poolId: dep.kaspa.poolId });
    if (!fx) throw new Error('the fixture self-check failed (address encoding)');
    try {
      await popup.bringToFront();
      await popup.evaluate((o) => new Promise(r => chrome.storage.local.get('kusdt.settings', v => {
        const st = v['kusdt.settings']; st.overrides.simnet = { ...st.overrides.simnet, ...o };
        chrome.storage.local.set({ 'kusdt.settings': st }, r);
      })), { nodeUrl: fx.nodeUrl, apiUrl: fx.apiUrl });
      fx.mode = 'paused';
      await popup.reload();
      await popup.waitForFunction(() => /KAS/.test(document.body.innerText), null, { timeout: 60_000 });
      await tab('Pool');
      await popup.getByTestId('pool-paused').waitFor({ timeout: 30_000 });
      await shot(popup, '15-pool-paused', { wait: 1200 });
      await shot(popup, '15b-pool-paused-full', { full: true, wait: 100 });
      await tab('Swap');
      await popup.getByTestId('pool-paused').waitFor({ timeout: 30_000 });
      await shot(popup, '15c-swap-paused', { wait: 900 });
      fx.mode = 'empty';
      await tab('Wallet');
      await tab('Pool');
      await popup.getByTestId('pool-empty').waitFor({ timeout: 30_000 });
      await shot(popup, '16-pool-empty', { wait: 900 });
      await button('Open the pool').click();
      await shot(popup, '16b-pool-open', { wait: 900 });
      await popup.getByLabel('KAS', { exact: true }).fill('500');
      await popup.getByLabel('kUSDT', { exact: true }).fill('15.707');
      await shot(popup, '16c-pool-open-filled', { wait: 900 });
      await shot(popup, '16d-pool-open-full', { full: true, wait: 100 });
      await back();
      await tab('Swap');
      await popup.getByText('The pool has no liquidity yet').waitFor({ timeout: 30_000 });
      await shot(popup, '16e-swap-empty', { wait: 700 });
      await tab('Wallet');
    } finally { fx.close(); }
  });

  await attempt('14-unlock', async () => {
    await popup.bringToFront();
    await button('Lock').click();
    await popup.getByText('Welcome back').waitFor();
    await shot(popup, '14-unlock');
  });
} finally {
  await ctx.close();
  server.close();
  fs.rmSync(profile, { recursive: true, force: true });
}
