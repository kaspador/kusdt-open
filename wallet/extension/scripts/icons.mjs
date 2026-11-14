// Draws the toolbar icons (src/assets/icon-*.png) from the site's own icon, the
// ribbon T on its dark tile (bridge/web/public/favicon.svg). Needs a Chromium
// (CHROMIUM=…, else Playwright's under %LOCALAPPDATA%).
import { chromium } from 'playwright-core';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const here = import.meta.dirname;
const svg = fs.readFileSync(path.resolve(here, '../../../bridge/web/public/favicon.svg'), 'utf8');
const dir = path.join(os.homedir(), 'AppData/Local/ms-playwright');
const found = fs.existsSync(dir) ? fs.readdirSync(dir).filter(n => n.startsWith('chromium-')).sort().pop() : null;
const exe = process.env.CHROMIUM ?? (found ? path.join(dir, found, 'chrome-win/chrome.exe') : undefined);
const browser = await chromium.launch({ executablePath: exe });
fs.mkdirSync(path.resolve(here, '../src/assets'), { recursive: true });
for (const size of [16, 32, 48, 128]) {
  const page = await browser.newPage({ viewport: { width: size, height: size } });
  await page.setContent(`<!doctype html><html style="background:transparent"><body style="margin:0;background:transparent">${svg.replace('<svg ', `<svg width="${size}" height="${size}" style="display:block" `)}</body></html>`);
  await page.screenshot({ path: path.resolve(here, `../src/assets/icon-${size}.png`), omitBackground: true });
  await page.close();
}
await browser.close();
console.log('icons written');
