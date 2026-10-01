/**
 * Turning a GitHub release into download links. The download page runs this in the visitor's
 * browser against the live GitHub API; it only ever links files that the release actually has.
 */

export interface GitHubAsset {
  name: string;
  size: number;
  browser_download_url: string;
  content_type?: string;
  download_count?: number;
  /** "sha256:<hex>", reported by GitHub for assets uploaded since mid-2025. */
  digest?: string | null;
}

export interface GitHubRelease {
  tag_name: string;
  name: string | null;
  html_url: string;
  body: string | null;
  draft: boolean;
  prerelease: boolean;
  published_at: string | null;
  assets: GitHubAsset[];
}

export interface DownloadFile {
  name: string;
  url: string;
  size: number;
  sha256?: string;
}

export type SigningStatus = 'signed' | 'unsigned' | 'unknown';

export interface Downloads {
  version: string;
  tag: string;
  pageUrl: string;
  publishedAt?: string;
  prerelease: boolean;
  installer?: DownloadFile;
  portable?: DownloadFile;
  checksums?: DownloadFile;
  signing: SigningStatus;
}

const INSTALLER = /^OpenPulse-Setup-(\d+\.\d+\.\d+(?:[-+][\w.-]+)?)-x64\.exe$/;
const PORTABLE = /^OpenPulse-Portable-(\d+\.\d+\.\d+(?:[-+][\w.-]+)?)-x64\.exe$/;
const CHECKSUMS = /^(SHA256SUMS(\.txt)?|checksums\.txt)$/i;

function file(asset: GitHubAsset): DownloadFile {
  const sha = asset.digest?.startsWith('sha256:')
    ? asset.digest.slice('sha256:'.length)
    : undefined;
  return {
    name: asset.name,
    url: asset.browser_download_url,
    size: asset.size,
    ...(sha && /^[0-9a-f]{64}$/i.test(sha) && { sha256: sha.toLowerCase() }),
  };
}

/**
 * The release workflow writes "Code signing: signed" or "Code signing: unsigned" into the release
 * notes. Anything else is reported as unknown rather than guessed.
 */
export function signingStatus(body: string | null | undefined): SigningStatus {
  // Tolerates Markdown around the label, e.g. "**Code signing:** unsigned".
  const match = /^\W*code signing\W*:\W*(signed|unsigned|not signed)\b/im.exec(body ?? '');
  if (!match?.[1]) return 'unknown';
  return match[1].toLowerCase() === 'signed' ? 'signed' : 'unsigned';
}

/** Pick the Windows installer, portable build and checksum file out of one release. */
export function selectDownloads(release: GitHubRelease): Downloads {
  const installer = release.assets.find((a) => INSTALLER.test(a.name) && a.size > 0);
  const portable = release.assets.find((a) => PORTABLE.test(a.name) && a.size > 0);
  const checksums = release.assets.find((a) => CHECKSUMS.test(a.name) && a.size > 0);
  const fromName = installer ? INSTALLER.exec(installer.name)?.[1] : undefined;
  return {
    version: fromName ?? release.tag_name.replace(/^v/, ''),
    tag: release.tag_name,
    pageUrl: release.html_url,
    ...(release.published_at && { publishedAt: release.published_at }),
    prerelease: release.prerelease,
    ...(installer && { installer: file(installer) }),
    ...(portable && { portable: file(portable) }),
    ...(checksums && { checksums: file(checksums) }),
    signing: signingStatus(release.body),
  };
}

/**
 * The newest published release that has a Windows build. Drafts are never offered; a pre-release
 * is offered only when there is no stable release with a build.
 */
export function latestWindowsRelease(releases: GitHubRelease[]): Downloads | undefined {
  const published = releases
    .filter((r) => !r.draft && r.published_at)
    .sort((a, b) => Date.parse(b.published_at ?? '') - Date.parse(a.published_at ?? ''))
    .map(selectDownloads)
    .filter((d) => d.installer || d.portable);
  return published.find((d) => !d.prerelease) ?? published[0];
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '—';
  const units = ['B', 'KB', 'MB', 'GB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value >= 100 || unit === 0 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
}

export function formatDate(iso: string | undefined): string {
  if (!iso) return '';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleDateString('en', { year: 'numeric', month: 'long', day: 'numeric' });
}
