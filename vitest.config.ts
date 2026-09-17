import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    pool: 'forks',
    include: ['test/**/*.test.ts'],
    testTimeout: 60000,
    hookTimeout: 30000,
  },
});
