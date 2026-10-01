import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** A small static server for previewing dist/ locally, honouring WEB_BASE like the build does. */

const appDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const root = path.join(appDir, 'dist');
const port = Number(process.env.PORT ?? 4321);
const base = `/${(process.env.WEB_BASE ?? '/').replace(/^\/+|\/+$/g, '')}/`.replace('//', '/');

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.txt': 'text/plain; charset=utf-8',
  '.xml': 'application/xml',
};

async function resolve(urlPath: string): Promise<string | undefined> {
  if (!urlPath.startsWith(base)) return undefined;
  const relative = decodeURIComponent(urlPath.slice(base.length));
  const file = path.resolve(root, relative);
  if (file !== root && !file.startsWith(root + path.sep)) return undefined;
  for (const candidate of [file, path.join(file, 'index.html')]) {
    const stat = await fs.stat(candidate).catch(() => undefined);
    if (stat?.isFile()) return candidate;
  }
  return undefined;
}

http
  .createServer((req, res) => {
    void (async () => {
      const urlPath = new URL(req.url ?? '/', 'http://localhost').pathname;
      const file = await resolve(urlPath);
      if (!file) {
        const notFound = await fs
          .readFile(path.join(root, '404.html'))
          .catch(() => Buffer.from('Not found'));
        res.writeHead(404, { 'Content-Type': TYPES['.html']! }).end(notFound);
        return;
      }
      res.writeHead(200, {
        'Content-Type': TYPES[path.extname(file)] ?? 'application/octet-stream',
      });
      res.end(await fs.readFile(file));
    })();
  })
  .listen(port, '127.0.0.1', () =>
    console.log(`OpenPulse website preview: http://127.0.0.1:${port}${base}`),
  );
