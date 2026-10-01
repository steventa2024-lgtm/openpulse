import { DOCS, type DocPage } from '../docs/content.js';
import { html } from '../html.js';
import type { Page } from '../layout.js';
import { REPO_URL, href } from '../site.js';

const GROUPS: DocPage['group'][] = ['Start', 'Use', 'Extend', 'Reference'];

function sidebar(current?: string) {
  return html`<nav class="docs-nav" aria-label="Documentation">
    ${GROUPS.map(
      (group) =>
        html`<div class="docs-nav-group">
          <p class="docs-nav-title">${group}</p>
          ${DOCS.filter((d) => d.group === group).map(
            (d) =>
              html`<a
                href="${href(`/docs/${d.slug}/`)}"
                ${d.slug === current ? html`aria-current="page"` : ''}
                >${d.title}</a
              >`,
          )}
        </div>`,
    )}
  </nav>`;
}

export function docsIndexPage(): Page {
  return {
    path: '/docs/',
    title: 'Documentation',
    section: 'docs',
    description:
      'OpenPulse documentation: installing, local models, workspaces, permissions, workflows, MCP, skills, the SDK and the CLI.',
    body: html`
      <section class="page-head">
        <div class="wrap">
          <p class="eyebrow">Documentation</p>
          <h1>OpenPulse docs</h1>
          <p class="lead">
            Start with the quick start, then dip into whichever part you are using.
          </p>
        </div>
      </section>
      <section class="section">
        <div class="wrap">
          ${GROUPS.map(
            (group) =>
              html`<h2 class="docs-group-title">${group}</h2>
                <div class="card-grid">
                  ${DOCS.filter((d) => d.group === group).map(
                    (d) =>
                      html`<a class="card card-link" href="${href(`/docs/${d.slug}/`)}">
                        <h3>${d.title}</h3>
                        <p>${d.summary}</p>
                      </a>`,
                  )}
                </div>`,
          )}
        </div>
      </section>
    `,
  };
}

export function docPages(): Page[] {
  return DOCS.map((doc, index) => {
    const prev = DOCS[index - 1];
    const next = DOCS[index + 1];
    return {
      path: `/docs/${doc.slug}/`,
      title: doc.title,
      section: 'docs',
      description: doc.summary,
      body: html`
        <div class="wrap docs-layout">
          ${sidebar(doc.slug)}
          <article class="prose">
            <p class="eyebrow">${doc.group}</p>
            <h1>${doc.title}</h1>
            <p class="lead">${doc.summary}</p>
            ${doc.body}
            <nav class="docs-pager" aria-label="Previous and next">
              ${prev ? html`<a href="${href(`/docs/${prev.slug}/`)}">← ${prev.title}</a>` : html`<span></span>`}
              ${next ? html`<a href="${href(`/docs/${next.slug}/`)}">${next.title} →</a>` : html`<span></span>`}
            </nav>
            <p class="muted docs-edit">
              Something wrong or missing?
              <a href="${REPO_URL}/issues" rel="noopener">Open an issue</a>.
            </p>
          </article>
        </div>
      `,
    };
  });
}
