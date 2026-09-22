import { defineConfig } from 'vitest/config';

export default defineConfig({
  ssr: {
    resolve: {
      // Resolve workspace packages to their TypeScript sources so tests don't need a prior build.
      // Setting conditions replaces Vite's defaults, so the server defaults are restated here.
      conditions: ['@openpulse/source', 'module', 'node', 'development|production'],
    },
  },
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
  },
});
