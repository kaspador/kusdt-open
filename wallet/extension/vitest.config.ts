import { defineConfig } from 'vitest/config';
import { aliases, dedupe } from './aliases';

export default defineConfig({
  resolve: { alias: aliases(true), dedupe },
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
    testTimeout: 30_000,
  },
});
