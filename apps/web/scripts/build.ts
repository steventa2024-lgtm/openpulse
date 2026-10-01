import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { layout } from '../src/layout.js';
import { allPages } from '../src/pages/index.js';

const appDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export interface BuildResult {
  outDir: string;
  files: string[];
}

/**
 * Render every page to <route>/index.html, bundle the browser scripts and copy public/.
 * WEB_BASE sets the path the site is served under (e.g. "/openpulse/" on GitHub Pages).
 */
export async function buildSite(outDir = path.join(appDir, 'dist')): Promise<BuildResult> {
  await fs.rm(outDir, { recursive: true, force: true });
  await fs.mkdir(outDir, { recursive: true });
  const files: string[] = [];

  for (const page of allPages()) {
    const route = page.path.replace(/^\/|\/$/g, '');
    const file = route ? path.join(outDir, route, 'index.html') : path.join(outDir, 'index.html');
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, layout(page), 'utf8');
    files.push(path.relative(outDir, file));
    // Static hosts (GitHub Pages included) serve /404.html for unknown paths.
    if (page.path === '/404/') {
      await fs.writeFile(path.join(outDir, '404.html'), layout(page), 'utf8');
      files.push('404.html');
    }
  }

  const clientDir = path.join(appDir, 'src', 'client');
  const entries = (await fs.readdir(clientDir))
    .filter((f) => f.endsWith('.ts'))
    .map((f) => path.join(clientDir, f));
  await build({
    entryPoints: entries,
    outdir: path.join(outDir, 'assets'),
    bundle: true,
    format: 'iife',
    target: 'es2022',
    minify: true,
    logLevel: 'warning',
  });
  for (const entry of entries) files.push(`assets/${path.basename(entry, '.ts')}.js`);

  await fs.cp(path.join(appDir, 'public'), outDir, { recursive: true });
  for (const f of await fs.readdir(path.join(appDir, 'public'), {
    recursive: true,
    withFileTypes: true,
  })) {
    if (f.isFile())
      files.push(path.relative(path.join(appDir, 'public'), path.join(f.parentPath, f.name)));
  }

  return { outDir, files: files.map((f) => f.split(path.sep).join('/')) };
}

const invokedDirectly =
  process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  const result = await buildSite(
    process.env.WEB_OUT ? path.resolve(process.env.WEB_OUT) : undefined,
  );
  console.log(
    `built ${result.files.length} files into ${path.relative(process.cwd(), result.outDir) || '.'}`,
  );
}
