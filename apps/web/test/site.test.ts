import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildSite } from '../scripts/build.js';

const REQUIRED_ROUTES = [
  'index.html',
  'download/index.html',
  'features/index.html',
  'developers/index.html',
  'docs/index.html',
  'docs/getting-started/index.html',
  'changelog/index.html',
  'roadmap/index.html',
  'privacy/index.html',
  '404.html',
];

async function readAll(dir: string): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  for (const entry of await fs.readdir(dir, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const full = path.join(entry.parentPath, entry.name);
    const rel = path.relative(dir, full).split(path.sep).join('/');
    if (/\.(html|js|css|txt|svg)$/.test(rel)) out.set(rel, await fs.readFile(full, 'utf8'));
    else out.set(rel, '');
  }
  return out;
}

/** Every href/src that points into the site, resolved against the base path. */
function internalLinks(html: string, base: string): string[] {
  return [...html.matchAll(/\s(?:href|src)="([^"]+)"/g)]
    .map((m) => m[1]!)
    .filter((url) => url.startsWith(base))
    .map((url) => url.slice(base.length).split('#')[0]!);
}

function resolves(files: Map<string, string>, link: string): boolean {
  if (link === '' || link.endsWith('/')) return files.has(`${link}index.html`);
  return files.has(link);
}

describe.each([
  ['/', 'root'],
  ['/openpulse/', 'GitHub Pages project path'],
])('the built site under %s (%s)', (base) => {
  let dir: string;
  let files: Map<string, string>;

  beforeAll(async () => {
    process.env.WEB_BASE = base;
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'openpulse-web-'));
    await buildSite(dir);
    files = await readAll(dir);
  }, 60_000);

  afterAll(async () => {
    delete process.env.WEB_BASE;
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('has every page the site promises', () => {
    for (const route of REQUIRED_ROUTES) expect(files.has(route), route).toBe(true);
    expect(files.has('assets/download.js')).toBe(true);
    expect(files.has('assets/changelog.js')).toBe(true);
    expect(files.has('img/changes.png')).toBe(true);
  });

  it('gives every page a title, a description and the hero tagline on the home page', () => {
    for (const [file, html] of files) {
      if (!file.endsWith('.html')) continue;
      expect(html, file).toMatch(/<title>[^<]{3,}<\/title>/);
      expect(html, file).toMatch(/<meta name="description" content="[^"]{10,}"/);
    }
    expect(files.get('index.html')).toContain('Your AI workforce.');
  });

  it('has no broken internal links', () => {
    const broken: string[] = [];
    for (const [file, html] of files) {
      if (!file.endsWith('.html')) continue;
      for (const link of internalLinks(html, base))
        if (!resolves(files, link)) broken.push(`${file} → ${link}`);
    }
    expect(broken).toEqual([]);
  });

  it('never links an installer directly — downloads come from the live release', () => {
    for (const [file, html] of files) {
      if (!file.endsWith('.html')) continue;
      expect(html, file).not.toMatch(/href="[^"]*\.exe"/i);
      expect(html, file).not.toMatch(/releases\/download\//);
    }
  });

  it('contains no secrets or tokens', () => {
    const suspicious =
      /(sk-ant-[\w-]{10,}|sk-[A-Za-z0-9]{20,}|ghp_[A-Za-z0-9]{20,}|github_pat_[\w]{20,}|-----BEGIN [A-Z ]*PRIVATE KEY-----|xox[abp]-[\w-]{10,}|AKIA[0-9A-Z]{16})/;
    for (const [file, text] of files) expect(text, file).not.toMatch(suspicious);
  });

  it('loads nothing from third parties except the GitHub API in the page scripts', () => {
    for (const [file, html] of files) {
      if (!file.endsWith('.html')) continue;
      const external = [
        ...html.matchAll(/<(?:script|link)[^>]+(?:src|href)="(https?:[^"]+)"/g),
      ].map((m) => m[1]);
      expect(external, file).toEqual([]);
    }
  });

  it('never states that a build is signed', () => {
    // Only the download script may say so, and only when a release's notes state it.
    for (const [file, html] of files) {
      if (!file.endsWith('.html')) continue;
      expect(html, file).not.toMatch(/\b(is|are) (digitally |code[- ])?signed\b/i);
    }
  });
});
