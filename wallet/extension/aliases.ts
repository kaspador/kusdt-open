// Path aliases shared by Vite, Vitest and (as paths) tsconfig.json. The bridge
// packages are used from source, by relative path: npm never touches them.
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const pkgs = path.resolve(here, '../../bridge/packages');

export const aliases = (node: boolean) => [
  { find: /^@\//, replacement: path.resolve(here, 'src') + '/' },
  { find: /^@kusdt\/kaspa$/, replacement: path.join(pkgs, 'kaspa/src/index.ts') },
  { find: /^@kusdt\/kaspa\/(.*)$/, replacement: path.join(pkgs, 'kaspa/src') + '/$1.ts' },
  { find: /^@kusdt\/protocol$/, replacement: path.join(pkgs, 'protocol/src/index.ts') },
  { find: /^@kusdt\/core\/web$/, replacement: path.join(pkgs, 'core/src/web.ts') },
  { find: /^@kusdt\/core\/core$/, replacement: path.join(pkgs, 'core/src/core.ts') },
  { find: /^@kusdt\/core-wasm(\?url)?$/, replacement: path.join(pkgs, 'core/pkg-web/kusdt_wasm_bg.wasm') + '$1' },
  ...(node ? [{ find: /^@kusdt\/core$/, replacement: path.join(pkgs, 'core/src/index.ts') }] : []),
];

/** One copy of each crypto library, the extension's own (node_modules here). */
export const dedupe = ['@noble/curves', '@noble/hashes', '@noble/ciphers', '@scure/base', '@scure/bip32', '@scure/bip39'];
