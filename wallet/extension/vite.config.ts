import { defineConfig, transformWithEsbuild, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { crx } from '@crxjs/vite-plugin';
import fs from 'node:fs';
import path from 'node:path';
import manifest from './src/manifest';
import { aliases, dedupe } from './aliases';

/** inpage.js: window.kusdt, built on its own (no imports) and registered by the background in the MAIN world. */
function inpage(): Plugin {
  const src = path.resolve(__dirname, 'src/provider/inpage.ts');
  return {
    name: 'kusdt-inpage',
    async generateBundle() {
      const out = await transformWithEsbuild(fs.readFileSync(src, 'utf8'), src, { loader: 'ts', format: 'iife', target: 'es2020', minify: true });
      this.emitFile({ type: 'asset', fileName: 'inpage.js', source: out.code });
    },
  };
}

export default defineConfig({
  plugins: [react(), tailwindcss(), crx({ manifest }), inpage()],
  resolve: { alias: aliases(false), dedupe },
  build: {
    target: 'esnext',
    sourcemap: false,
    chunkSizeWarningLimit: 10_000,
    rollupOptions: { output: { chunkFileNames: 'assets/chunk-[hash].js' } },
  },
  server: { port: 5174, strictPort: true, hmr: { port: 5174 }, fs: { allow: ['..', '../../bridge/packages'] } },
});
