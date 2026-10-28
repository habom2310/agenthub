import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    setupFiles: ['tests/setup.ts'],
    // tests/setup.ts sets HOME per file; threads would share the real env.
    pool: 'forks',
  },
});
