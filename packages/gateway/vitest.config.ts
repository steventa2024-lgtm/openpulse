import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
    // Several suites drive real processes, a real browser and polling loops.
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
