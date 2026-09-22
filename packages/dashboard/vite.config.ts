import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

// During `pnpm dev` the dashboard runs on Vite's dev server and proxies API calls
// to the gateway. In production the gateway serves the built `dist/` directly.
const gatewayUrl = process.env.OPENPULSE_URL ?? 'http://127.0.0.1:18789';

export default defineConfig({
  plugins: [react()],
  // An inline PostCSS config stops Vite from searching parent directories for one,
  // so a stray postcss/tailwind config higher up the filesystem can't leak into the build.
  css: { postcss: {} },
  server: {
    host: '127.0.0.1',
    port: 5173,
    proxy: {
      '/api': { target: gatewayUrl, changeOrigin: true },
    },
  },
  test: {
    include: ['src/**/*.test.{ts,tsx}'],
    environment: 'node',
  },
});
