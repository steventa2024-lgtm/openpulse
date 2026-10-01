import { describe, expect, it } from 'vitest';
import {
  formatBytes,
  latestWindowsRelease,
  selectDownloads,
  signingStatus,
  type GitHubAsset,
  type GitHubRelease,
} from '../src/release.js';

const sha = 'a'.repeat(64);

function asset(name: string, extra: Partial<GitHubAsset> = {}): GitHubAsset {
  return {
    name,
    size: 95_000_000,
    browser_download_url: `https://github.com/steventa2024-lgtm/openpulse/releases/download/v0.1.0/${name}`,
    ...extra,
  };
}

function release(overrides: Partial<GitHubRelease> = {}): GitHubRelease {
  return {
    tag_name: 'v0.1.0',
    name: 'OpenPulse 0.1.0',
    html_url: 'https://github.com/steventa2024-lgtm/openpulse/releases/tag/v0.1.0',
    body: 'Code signing: unsigned\n\nFirst release.',
    draft: false,
    prerelease: false,
    published_at: '2026-10-01T12:00:00Z',
    assets: [
      asset('OpenPulse-Setup-0.1.0-x64.exe', { digest: `sha256:${sha}` }),
      asset('OpenPulse-Portable-0.1.0-x64.exe'),
      asset('SHA256SUMS.txt', { size: 200 }),
      asset('latest.yml', { size: 300 }),
      asset('OpenPulse-Setup-0.1.0-x64.exe.blockmap', { size: 1000 }),
    ],
    ...overrides,
  };
}

describe('selectDownloads', () => {
  it('picks the installer, portable build and checksum file', () => {
    const d = selectDownloads(release());
    expect(d.version).toBe('0.1.0');
    expect(d.installer?.name).toBe('OpenPulse-Setup-0.1.0-x64.exe');
    expect(d.installer?.sha256).toBe(sha);
    expect(d.portable?.name).toBe('OpenPulse-Portable-0.1.0-x64.exe');
    expect(d.portable?.sha256).toBeUndefined();
    expect(d.checksums?.name).toBe('SHA256SUMS.txt');
    expect(d.signing).toBe('unsigned');
  });

  it('never offers a file the release does not have', () => {
    const d = selectDownloads(release({ assets: [asset('OpenPulse-Portable-0.1.0-x64.exe')] }));
    expect(d.installer).toBeUndefined();
    expect(d.portable).toBeDefined();
    const none = selectDownloads(release({ assets: [] }));
    expect(none.installer).toBeUndefined();
    expect(none.portable).toBeUndefined();
  });

  it('ignores blockmaps, empty uploads and look-alike names', () => {
    const d = selectDownloads(
      release({
        assets: [
          asset('OpenPulse-Setup-0.1.0-x64.exe', { size: 0 }),
          asset('OpenPulse-Setup-0.1.0-x64.exe.blockmap'),
          asset('NotOpenPulse-Setup-0.1.0-x64.exe'),
          asset('OpenPulse-Setup-0.1.0-arm64.exe'),
        ],
      }),
    );
    expect(d.installer).toBeUndefined();
  });

  it('rejects a malformed digest instead of showing it', () => {
    const d = selectDownloads(
      release({
        assets: [asset('OpenPulse-Setup-0.1.0-x64.exe', { digest: 'sha256:not-a-hash' })],
      }),
    );
    expect(d.installer?.sha256).toBeUndefined();
  });
});

describe('signingStatus', () => {
  it('reads what the release notes state', () => {
    expect(signingStatus('Code signing: signed')).toBe('signed');
    expect(signingStatus('**Code signing:** unsigned')).toBe('unsigned');
    expect(signingStatus('- Code signing: not signed (no certificate configured)')).toBe(
      'unsigned',
    );
  });

  it('says unknown rather than guessing', () => {
    expect(signingStatus(null)).toBe('unknown');
    expect(signingStatus('Signed, sealed, delivered')).toBe('unknown');
    expect(signingStatus('Code signing is planned')).toBe('unknown');
  });
});

describe('latestWindowsRelease', () => {
  it('prefers the newest stable release with a Windows build', () => {
    const latest = latestWindowsRelease([
      release({
        tag_name: 'v0.2.0-beta.1',
        prerelease: true,
        published_at: '2026-11-01T00:00:00Z',
      }),
      release({ tag_name: 'v0.1.1', published_at: '2026-10-15T00:00:00Z', assets: [] }),
      release(),
    ]);
    expect(latest?.tag).toBe('v0.1.0');
  });

  it('skips drafts and falls back to a pre-release only when nothing stable exists', () => {
    expect(latestWindowsRelease([release({ draft: true })])).toBeUndefined();
    expect(latestWindowsRelease([release({ prerelease: true })])?.prerelease).toBe(true);
    expect(latestWindowsRelease([])).toBeUndefined();
  });
});

describe('formatBytes', () => {
  it('formats sizes for people', () => {
    expect(formatBytes(95_000_000)).toBe('90.6 MB');
    expect(formatBytes(200)).toBe('200 B');
    expect(formatBytes(0)).toBe('—');
  });
});
