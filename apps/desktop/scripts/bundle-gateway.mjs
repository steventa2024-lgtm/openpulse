#!/usr/bin/env node
/**
 * Bundles the gateway and its dependencies into one ESM file the installed app can run with the
 * Electron binary (ELECTRON_RUN_AS_NODE=1), so users never need Node or pnpm. Also stages the
 * built Control UI and the bundled skills into dist/ for electron-builder to pick up.
 */
import { cp, mkdir, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { build } from 'esbuild';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repo = path.resolve(root, '..', '..');
const outDir = path.join(root, 'dist');

const dashboardDist = path.join(repo, 'packages', 'dashboard', 'dist');
const skillsDir = path.join(repo, 'packages', 'gateway', 'skills');

await exists(
  path.join(dashboardDist, 'index.html'),
  'Build the dashboard first: pnpm --filter @openpulse/dashboard build',
);

await rm(path.join(outDir, 'gateway'), { recursive: true, force: true });
await mkdir(path.join(outDir, 'gateway'), { recursive: true });

await build({
  entryPoints: [path.join(root, 'src', 'gateway', 'entry.ts')],
  outfile: path.join(outDir, 'gateway', 'main.mjs'),
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'esm',
  // playwright-core loads its own driver assets and optional transports by path at runtime, so it
  // is shipped as a real package folder next to the bundle instead of being inlined.
  external: ['playwright-core'],
  banner: {
    js: [
      "import { createRequire as __openpulseCreateRequire } from 'node:module';",
      "import { fileURLToPath as __openpulseFileURLToPath } from 'node:url';",
      "import { dirname as __openpulseDirname } from 'node:path';",
      'const require = __openpulseCreateRequire(import.meta.url);',
      'const __filename = __openpulseFileURLToPath(import.meta.url);',
      'const __dirname = __openpulseDirname(__filename);',
    ].join('\n'),
  },
  sourcemap: false,
  minify: false,
  logLevel: 'info',
});

// Node resolves bare imports from node_modules next to the importing file, so the external
// packages live beside the bundle.
const vendorDir = path.join(outDir, 'gateway', 'node_modules');
await mkdir(vendorDir, { recursive: true });
const playwrightCore = resolvePackageDir('playwright-core', path.join(repo, 'packages', 'gateway'));
await cp(playwrightCore, path.join(vendorDir, 'playwright-core'), { recursive: true });

await rm(path.join(outDir, 'dashboard'), { recursive: true, force: true });
await cp(dashboardDist, path.join(outDir, 'dashboard'), { recursive: true });

await rm(path.join(outDir, 'skills'), { recursive: true, force: true });
await cp(skillsDir, path.join(outDir, 'skills'), { recursive: true });

const bundle = await stat(path.join(outDir, 'gateway', 'main.mjs'));
process.stdout.write(
  `desktop: gateway bundle ${(bundle.size / 1024 / 1024).toFixed(1)} MB, dashboard and skills staged\n`,
);

async function exists(file, message) {
  try {
    await stat(file);
  } catch {
    process.stderr.write(`${message}\n`);
    process.exit(1);
  }
}

/** Find an installed package's directory as the gateway would resolve it. */
function resolvePackageDir(name, fromDir) {
  const requireFrom = createRequire(path.join(fromDir, 'package.json'));
  const entry = requireFrom.resolve(name);
  let dir = path.dirname(entry);
  while (dir !== path.dirname(dir)) {
    if (path.basename(dir) === name || path.basename(path.dirname(dir)) === 'node_modules') break;
    dir = path.dirname(dir);
  }
  return dir;
}
