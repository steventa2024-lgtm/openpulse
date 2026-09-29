#!/usr/bin/env node
/**
 * Builds the Electron main process and preload as CommonJS (Electron's main process loads CJS
 * reliably across versions), and copies the static shell pages next to them.
 */
import { cp, mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outDir = path.join(root, 'dist');

await rm(path.join(outDir, 'main'), { recursive: true, force: true });
await rm(path.join(outDir, 'shell'), { recursive: true, force: true });
await mkdir(path.join(outDir, 'main'), { recursive: true });

await build({
  entryPoints: [path.join(root, 'src', 'main', 'index.ts')],
  outfile: path.join(outDir, 'main', 'index.cjs'),
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'cjs',
  external: ['electron'],
  sourcemap: true,
  logLevel: 'info',
});

await build({
  entryPoints: [path.join(root, 'src', 'main', 'preload.ts')],
  outfile: path.join(outDir, 'main', 'preload.cjs'),
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'cjs',
  external: ['electron'],
  sourcemap: true,
  logLevel: 'info',
});

await cp(path.join(root, 'src', 'shell'), path.join(outDir, 'shell'), { recursive: true });

process.stdout.write('desktop: main, preload and shell built\n');
