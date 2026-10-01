import { html, type Html } from './html.js';
import { REPO_URL, SITE, href } from './site.js';

export interface Page {
  /** Route, e.g. "/" or "/docs/sdk/". Every route is written out as <route>/index.html. */
  path: string;
  title: string;
  description: string;
  body: Html;
  /** Client scripts (from src/client) this page needs, by basename. */
  scripts?: string[];
  /** Nav item to highlight. */
  section?: 'features' | 'download' | 'developers' | 'docs' | 'changelog' | 'roadmap';
}

const NAV: { id: NonNullable<Page['section']>; label: string; path: string }[] = [
  { id: 'features', label: 'Features', path: '/features/' },
  { id: 'developers', label: 'Developers', path: '/developers/' },
  { id: 'docs', label: 'Docs', path: '/docs/' },
  { id: 'changelog', label: 'Changelog', path: '/changelog/' },
];

/** The halo mark beside the wordmark, as in the app. */
export function brand(extraClass = ''): Html {
  return html`<a class="brand ${extraClass}" href="${href('/')}">
    <img class="logo-mark" src="${href('/logo-mark.svg')}" alt="" width="32" height="32" />
    <span>Open<span class="pulse">Pulse</span></span>
  </a>`;
}

const downloadIcon = html`<svg viewBox="0 0 24 24" aria-hidden="true" class="icon">
  <path
    d="M12 4v11m0 0-4.5-4.5M12 15l4.5-4.5M5 19h14"
    fill="none"
    stroke="currentColor"
    stroke-width="2.2"
    stroke-linecap="round"
    stroke-linejoin="round"
  />
</svg>`;

export function layout(page: Page): string {
  const title =
    page.path === '/' ? `${SITE.name} — ${SITE.tagline}` : `${page.title} — ${SITE.name}`;
  const doc = html`<!doctype html>
    <html lang="en">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>${title}</title>
        <meta name="description" content="${page.description}" />
        <meta property="og:title" content="${title}" />
        <meta property="og:description" content="${page.description}" />
        <meta property="og:type" content="website" />
        <meta name="theme-color" content="#070b1d" />
        <link rel="icon" href="${href('/favicon.svg')}" type="image/svg+xml" />
        <link rel="stylesheet" href="${href('/styles.css')}" />
      </head>
      <body>
        <a class="skip" href="#main">Skip to content</a>
        <header class="site-header">
          <div class="wrap header-row">
            ${brand()}
            <input type="checkbox" id="nav-toggle" class="nav-toggle" aria-label="Menu" />
            <label for="nav-toggle" class="nav-burger" aria-hidden="true"><span></span></label>
            <nav class="site-nav" aria-label="Main">
              ${NAV.map(
                (item) =>
                  html`<a
                    href="${href(item.path)}"
                    ${page.section === item.id ? html`aria-current="page"` : ''}
                    >${item.label}</a
                  >`,
              )}
              <a href="${REPO_URL}" rel="noopener">GitHub</a>
              <a
                class="btn btn-small"
                href="${href('/download/')}"
                ${page.section === 'download' ? html`aria-current="page"` : ''}
                >Download ${downloadIcon}</a
              >
            </nav>
          </div>
        </header>
        <main id="main">${page.body}</main>
        <footer class="site-footer">
          <div class="wrap footer-row">
            <div>
              ${brand('brand-small')}
              <p class="muted">
                Your machine. Your models. Your AI workforce. · Version ${SITE.version}
              </p>
            </div>
            <nav aria-label="Footer">
              <a href="${href('/download/')}">Download</a>
              <a href="${href('/docs/')}">Docs</a>
              <a href="${href('/roadmap/')}">Roadmap</a>
              <a href="${href('/privacy/')}">Privacy</a>
              <a href="${REPO_URL}" rel="noopener">Source</a>
              <a href="${REPO_URL}/blob/main/LICENSE" rel="noopener">License</a>
            </nav>
          </div>
        </footer>
        ${(page.scripts ?? []).map(
          (name) => html`<script src="${href(`/assets/${name}.js`)}" defer></script>`,
        )}
      </body>
    </html> `;
  return doc.value;
}
