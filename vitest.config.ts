import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    setupFiles: ['tests/setup.ts'],
    // tests/setup.ts sets HOME per file; threads would share the real env.
    pool: 'forks',
    // Git-spawning tests take 2-4s on Windows runners and up to 8.5s on Node 24.
    testTimeout: 20_000,
  },
});
