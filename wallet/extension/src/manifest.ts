// Chrome Manifest V3. Permissions, and why:
//   storage     the sealed vault, settings and activity (chrome.storage.local),
//               the unlocked phrase (chrome.storage.session, memory only)
//   alarms      auto-lock
//   scripting   registers window.kusdt (inpage.js) in each page's own world
//   host access every endpoint is configurable (node, coordinator, EVM RPCs),
//               and window.kusdt is offered to any HTTPS page, as SPEC §14 asks
// No remote code, no analytics. 'wasm-unsafe-eval' lets the extension's own
// pages and worker compile the kUSDT core (WebAssembly); nothing else is evaluated.

import { defineManifest } from '@crxjs/vite-plugin';
import pkg from '../package.json';
import { BRAND, BRAND_SHORT } from './brand';
import { PAGE_MATCHES } from './provider/matches';

export default defineManifest({
  manifest_version: 3,
  name: BRAND,
  short_name: BRAND_SHORT,
  version: pkg.version,
  description: pkg.description,
  minimum_chrome_version: '111',
  action: {
    default_title: BRAND,
    default_popup: 'src/popup/index.html',
    default_icon: { '16': 'src/assets/icon-16.png', '32': 'src/assets/icon-32.png', '48': 'src/assets/icon-48.png', '128': 'src/assets/icon-128.png' },
  },
  icons: { '16': 'src/assets/icon-16.png', '32': 'src/assets/icon-32.png', '48': 'src/assets/icon-48.png', '128': 'src/assets/icon-128.png' },
  background: { service_worker: 'src/background/index.ts', type: 'module' },
  permissions: ['storage', 'alarms', 'scripting'],
  host_permissions: ['https://*/*', 'http://*/*'],
  content_scripts: [{ matches: [...PAGE_MATCHES], js: ['src/provider/content.ts'], run_at: 'document_start', all_frames: false }],
  content_security_policy: {
    extension_pages: "script-src 'self' 'wasm-unsafe-eval'; object-src 'self'; style-src 'self' 'unsafe-inline';",
  },
});
