import {
  formatBytes,
  formatDate,
  latestWindowsRelease,
  type DownloadFile,
  type Downloads,
  type GitHubRelease,
} from '../release.js';

/**
 * Fills the download panel from the live GitHub releases API. It links only files the release
 * really has; when there is no release, or GitHub cannot be reached, it says so.
 */

const root = document.getElementById('download-root');

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Partial<Record<string, string>> = {},
  ...children: (Node | string | null | undefined | false)[]
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value === undefined) continue;
    if (key === 'class') node.className = value;
    else node.setAttribute(key, value);
  }
  for (const child of children) {
    if (child) node.append(child);
  }
  return node;
}

function fileRow(label: string, hint: string, file: DownloadFile, primary: boolean): HTMLElement {
  return el(
    'div',
    { class: 'dl-file' },
    el(
      'div',
      { class: 'dl-file-main' },
      el(
        'a',
        { class: primary ? 'btn btn-primary' : 'btn btn-ghost', href: file.url, rel: 'noopener' },
        label,
      ),
      el(
        'div',
        { class: 'dl-file-meta' },
        el('code', {}, file.name),
        el('span', { class: 'muted' }, ` · ${formatBytes(file.size)} · ${hint}`),
      ),
    ),
    file.sha256
      ? el(
          'div',
          { class: 'dl-sha' },
          el('span', { class: 'muted' }, 'SHA-256 '),
          el('code', {}, file.sha256),
        )
      : el('div', { class: 'dl-sha muted' }, 'SHA-256: see the checksum file on the release.'),
  );
}

function signingNote(signing: Downloads['signing']): HTMLElement {
  if (signing === 'signed') {
    return el(
      'p',
      { class: 'note note-ok' },
      'The release notes state these builds are code-signed.',
    );
  }
  if (signing === 'unsigned') {
    return el(
      'p',
      { class: 'note note-warn' },
      'These builds are not code-signed. Windows SmartScreen will warn the first time you run one — verify the checksum, then choose More info → Run anyway.',
    );
  }
  return el(
    'p',
    { class: 'note note-warn' },
    'The release notes do not say whether these builds are code-signed, so treat them as unsigned: verify the checksum before running.',
  );
}

function renderRelease(d: Downloads, releasesUrl: string): void {
  if (!root) return;
  const published = formatDate(d.publishedAt);
  const parts: (HTMLElement | null)[] = [
    el(
      'div',
      { class: 'dl-head' },
      el('h2', {}, `OpenPulse ${d.version}`),
      el(
        'p',
        { class: 'muted' },
        [published && `Released ${published}`, d.prerelease && 'pre-release']
          .filter(Boolean)
          .join(' · ') || ' ',
      ),
    ),
    d.installer ? fileRow('Download the installer', 'recommended', d.installer, true) : null,
    d.portable
      ? fileRow('Download the portable build', 'no install', d.portable, !d.installer)
      : null,
    signingNote(d.signing),
    el(
      'p',
      { class: 'dl-links' },
      el('a', { href: d.pageUrl, rel: 'noopener' }, 'Release notes'),
      d.checksums ? ' · ' : null,
      d.checksums ? el('a', { href: d.checksums.url, rel: 'noopener' }, d.checksums.name) : null,
      ' · ',
      el('a', { href: releasesUrl, rel: 'noopener' }, 'All releases'),
    ),
  ];
  root.replaceChildren(...parts.filter((part): part is HTMLElement => part !== null));
}

function renderUnavailable(releasesUrl: string, reason: 'none' | 'error', detail?: string): void {
  if (!root) return;
  root.replaceChildren(
    el('h2', {}, reason === 'none' ? 'No download is available yet' : 'Could not reach GitHub'),
    el(
      'p',
      {},
      reason === 'none'
        ? 'There is no published OpenPulse release with a Windows build yet. When one is published it will appear here automatically.'
        : `GitHub did not answer (${detail ?? 'network error'}). It may be rate-limiting this network; try again in a few minutes.`,
    ),
    el(
      'p',
      {},
      'Meanwhile you can ',
      el('a', { href: releasesUrl, rel: 'noopener' }, 'check the releases page on GitHub'),
      ' or build the installer from source (below).',
    ),
  );
}

async function main(): Promise<void> {
  if (!root) return;
  const api = root.dataset.api ?? '';
  const releasesUrl = root.dataset.releases ?? '';
  try {
    const response = await fetch(`${api}?per_page=20`, {
      headers: { Accept: 'application/vnd.github+json' },
    });
    if (response.status === 404) return renderUnavailable(releasesUrl, 'none');
    if (!response.ok) return renderUnavailable(releasesUrl, 'error', `HTTP ${response.status}`);
    const releases = (await response.json()) as GitHubRelease[];
    const latest = Array.isArray(releases) ? latestWindowsRelease(releases) : undefined;
    if (latest) renderRelease(latest, releasesUrl);
    else renderUnavailable(releasesUrl, 'none');
  } catch (error) {
    renderUnavailable(releasesUrl, 'error', error instanceof Error ? error.message : undefined);
  }
}

void main();
