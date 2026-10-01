import rootPackage from '../../../package.json' with { type: 'json' };

/** Facts about the project that the pages state. Nothing here is a secret, and nothing may be. */
export const SITE = {
  name: 'OpenPulse',
  tagline: 'Your machine. Your models. Your AI workforce.',
  description:
    'OpenPulse is a local-first AI developer platform: a desktop app and gateway that run agents on your own machine, with your own models, under rules you set.',
  version: rootPackage.version,
  repo: { owner: 'steventa2024-lgtm', name: 'openpulse' },
  defaultPort: 18789,
} as const;

export const REPO_URL = `https://github.com/${SITE.repo.owner}/${SITE.repo.name}`;
export const RELEASES_URL = `${REPO_URL}/releases`;
export const RELEASES_API = `https://api.github.com/repos/${SITE.repo.owner}/${SITE.repo.name}/releases`;

/**
 * Where the site is served from. GitHub Pages serves a project site under /<repo>/, so the build
 * takes WEB_BASE (for example "/openpulse/"); everything else defaults to the root.
 */
export function siteBase(): string {
  const base = process.env.WEB_BASE?.trim() || '/';
  return `/${base.replace(/^\/+|\/+$/g, '')}/`.replace('//', '/');
}

/** A link to a page of this site, e.g. href('/docs/sdk/'). */
export function href(pathname: string): string {
  return siteBase() + pathname.replace(/^\/+/, '');
}
