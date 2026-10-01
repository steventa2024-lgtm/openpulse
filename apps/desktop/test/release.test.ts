import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  checksumFile,
  packageVersions,
  releaseFiles,
  releaseNotes,
  sha256,
  versionFromTag,
  versionMismatches,
} from '../scripts/release/lib.mjs';
import { selectDownloads, signingStatus } from '../../web/src/release.js';

const dirs: string[] = [];
async function tempDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'openpulse-release-'));
  dirs.push(dir);
  return dir;
}
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => fs.rm(d, { recursive: true, force: true })));
});

describe('release versions', () => {
  it('reads a version from a tag', () => {
    expect(versionFromTag('v0.2.0')).toBe('0.2.0');
    expect(versionFromTag('1.4.10')).toBe('1.4.10');
    expect(versionFromTag('v0.3.0-beta.1')).toBe('0.3.0-beta.1');
    expect(() => versionFromTag('latest')).toThrow(/not a version tag/);
    expect(() => versionFromTag('v1.2')).toThrow();
  });

  it('finds every workspace package and reports the ones that disagree', async () => {
    const root = await tempDir();
    const write = async (file: string, version: string) => {
      await fs.mkdir(path.dirname(path.join(root, file)), { recursive: true });
      await fs.writeFile(path.join(root, file), JSON.stringify({ name: file, version }));
    };
    await write('package.json', '0.2.0');
    await write('apps/desktop/package.json', '0.2.0');
    await write('packages/gateway/package.json', '0.1.9');
    const versions = await packageVersions(root);
    expect(versions.map((v) => v.file).sort()).toEqual([
      'apps/desktop/package.json',
      'package.json',
      'packages/gateway/package.json',
    ]);
    expect(versionMismatches(versions, '0.2.0').map((m) => m.file)).toEqual([
      'packages/gateway/package.json',
    ]);
  });

  it('agrees with this repository today', async () => {
    const root = path.resolve(__dirname, '..', '..', '..');
    const versions = await packageVersions(root);
    const rootVersion = versions.find((v) => v.file === 'package.json')!.version;
    expect(versionMismatches(versions, rootVersion)).toEqual([]);
  });
});

describe('release assets', () => {
  it('checksums the installer and portable build and refuses when one is missing', async () => {
    const dir = await tempDir();
    await fs.writeFile(path.join(dir, 'OpenPulse-Setup-0.2.0-x64.exe'), 'installer bytes');
    await expect(releaseFiles(dir, '0.2.0')).rejects.toThrow(/OpenPulse-Portable-0.2.0-x64.exe/);

    await fs.writeFile(path.join(dir, 'OpenPulse-Portable-0.2.0-x64.exe'), 'portable bytes');
    const files = await releaseFiles(dir, '0.2.0');
    expect(files.map((f) => f.name)).toEqual([
      'OpenPulse-Setup-0.2.0-x64.exe',
      'OpenPulse-Portable-0.2.0-x64.exe',
    ]);
    // Known SHA-256 of "installer bytes".
    expect(files[0]!.sha256).toBe(await sha256(path.join(dir, 'OpenPulse-Setup-0.2.0-x64.exe')));
    expect(files[0]!.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(checksumFile(files)).toBe(
      `${files[0]!.sha256}  OpenPulse-Setup-0.2.0-x64.exe\n${files[1]!.sha256}  OpenPulse-Portable-0.2.0-x64.exe\n`,
    );
  });
});

describe('release notes', () => {
  const files = [
    { name: 'OpenPulse-Setup-0.2.0-x64.exe', size: 89_004_359, sha256: 'a'.repeat(64) },
    { name: 'OpenPulse-Portable-0.2.0-x64.exe', size: 88_708_982, sha256: 'b'.repeat(64) },
  ];

  it('states the signing status the way the download page reads it', () => {
    const unsigned = releaseNotes({ version: '0.2.0', signing: 'unsigned', files });
    expect(signingStatus(unsigned)).toBe('unsigned');
    expect(unsigned).toContain('SmartScreen');
    const signed = releaseNotes({ version: '0.2.0', signing: 'signed', files });
    expect(signingStatus(signed)).toBe('signed');
    expect(signed).not.toContain('SmartScreen');
  });

  it('refuses to guess a signing status', () => {
    expect(() => releaseNotes({ version: '0.2.0', signing: 'maybe' as 'signed', files })).toThrow(
      /signing must be/,
    );
  });

  it('lists every file with its checksum and the changes since the last tag', () => {
    const notes = releaseNotes({
      version: '0.2.0',
      signing: 'unsigned',
      files,
      changes: ['Add the website', 'Fix the Ollama context window'],
      previousTag: 'v0.1.0',
    });
    expect(notes).toContain(
      `| \`OpenPulse-Setup-0.2.0-x64.exe\` | 84.9 MB | \`${'a'.repeat(64)}\` |`,
    );
    expect(notes).toContain('## Changes since v0.1.0');
    expect(notes).toContain('- Fix the Ollama context window');
  });

  it('produces a release the download page offers correctly', () => {
    const notes = releaseNotes({ version: '0.2.0', signing: 'unsigned', files });
    const downloads = selectDownloads({
      tag_name: 'v0.2.0',
      name: 'OpenPulse 0.2.0',
      html_url: 'https://github.com/steventa2024-lgtm/openpulse/releases/tag/v0.2.0',
      body: notes,
      draft: false,
      prerelease: false,
      published_at: '2026-10-01T00:00:00Z',
      assets: [...files.map((f) => f.name), 'SHA256SUMS.txt'].map((name) => ({
        name,
        size: 100,
        browser_download_url: `https://example.invalid/${name}`,
      })),
    });
    expect(downloads).toMatchObject({ version: '0.2.0', signing: 'unsigned' });
    expect(downloads.installer?.name).toBe('OpenPulse-Setup-0.2.0-x64.exe');
    expect(downloads.portable?.name).toBe('OpenPulse-Portable-0.2.0-x64.exe');
    expect(downloads.checksums?.name).toBe('SHA256SUMS.txt');
  });
});
