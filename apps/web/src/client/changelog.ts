import { formatDate, selectDownloads, type GitHubRelease } from '../release.js';

/** Lists published GitHub releases under the unreleased entry. Release notes are shown as text. */

const root = document.getElementById('releases-root');

function text(tag: string, className: string, value: string): HTMLElement {
  const node = document.createElement(tag);
  if (className) node.className = className;
  node.textContent = value;
  return node;
}

function link(url: string, label: string): HTMLAnchorElement {
  const a = document.createElement('a');
  a.href = url;
  a.rel = 'noopener';
  a.textContent = label;
  return a;
}

function render(releases: GitHubRelease[], releasesUrl: string): void {
  if (!root) return;
  const published = releases.filter((r) => !r.draft && r.published_at);
  if (published.length === 0) {
    root.replaceChildren(text('p', 'muted', 'No releases have been published on GitHub yet.'));
    return;
  }
  root.replaceChildren(
    ...published.map((release) => {
      const article = document.createElement('article');
      article.className = 'release';
      const header = document.createElement('header');
      const title = text('h2', '', release.name || release.tag_name);
      if (release.prerelease) title.append(' ', text('span', 'tag', 'pre-release'));
      header.append(title);
      const downloads = selectDownloads(release);
      const meta = document.createElement('p');
      meta.className = 'muted';
      meta.append(
        `${formatDate(release.published_at ?? undefined)} · `,
        link(release.html_url, 'Release on GitHub'),
      );
      if (downloads.installer) meta.append(' · ', link(downloads.installer.url, 'Installer'));
      header.append(meta);
      article.append(
        header,
        text('div', 'release-body', release.body?.trim() || 'No release notes.'),
      );
      return article;
    }),
    (() => {
      const more = document.createElement('p');
      more.append(link(releasesUrl, 'All releases on GitHub →'));
      return more;
    })(),
  );
}

async function main(): Promise<void> {
  if (!root) return;
  const releasesUrl = root.dataset.releases ?? '';
  try {
    const response = await fetch(`${root.dataset.api ?? ''}?per_page=30`, {
      headers: { Accept: 'application/vnd.github+json' },
    });
    if (response.status === 404) return render([], releasesUrl);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const releases = (await response.json()) as GitHubRelease[];
    render(Array.isArray(releases) ? releases : [], releasesUrl);
  } catch (error) {
    root.replaceChildren(
      text(
        'p',
        'muted',
        `Could not load releases from GitHub (${error instanceof Error ? error.message : 'network error'}). `,
      ),
    );
    root.firstElementChild?.append(link(releasesUrl, 'See them on GitHub.'));
  }
}

void main();
