import { html } from '../html.js';
import type { Page } from '../layout.js';
import { RELEASES_API, RELEASES_URL, REPO_URL, SITE, href } from '../site.js';

/** What is in the current, unreleased version — written from what the repository actually contains. */
const UNRELEASED = [
  'Windows desktop app that attaches to or starts and supervises the gateway, with port fallback and crash recovery.',
  'NSIS installer and portable build; ~/.openpulse is kept on install, upgrade and uninstall.',
  'Local model setup: Ollama and LM Studio detection, live test prompts, default and ordered fallback models.',
  'Enforced permissions: read-only, balanced and custom modes, folder boundaries and a secret deny list.',
  'Projects and Git, a Monaco code editor, diff review with per-file approval, and checkpoints with preview.',
  'Multi-agent workflows with planner, coder, tester and reviewer roles.',
  'MCP client for stdio and HTTP servers, with per-tool switches and approval.',
  'Skills registry: install from Git or a folder, validate, update and remove, without running bundled scripts.',
  'Integrated test runner with agent-proposed fixes, an agent debugger and model monitoring.',
  'TypeScript SDK (prepared for npm, not yet published).',
];

export function changelogPage(): Page {
  return {
    path: '/changelog/',
    title: 'Changelog',
    section: 'changelog',
    description: 'What changed in each OpenPulse release.',
    scripts: ['changelog'],
    body: html`
      <section class="page-head">
        <div class="wrap">
          <p class="eyebrow">Changelog</p>
          <h1>What’s new</h1>
          <p class="lead">
            Published releases come straight from GitHub. Work that is not released yet is listed
            first.
          </p>
        </div>
      </section>
      <section class="section">
        <div class="wrap narrow">
          <article class="release">
            <header>
              <h2>${SITE.version} <span class="tag">not released yet</span></h2>
              <p class="muted">In the repository, not yet published as a release.</p>
            </header>
            <ul class="checks">
              ${UNRELEASED.map((item) => html`<li>${item}</li>`)}
            </ul>
          </article>
          <div
            id="releases-root"
            data-api="${RELEASES_API}"
            data-releases="${RELEASES_URL}"
            aria-live="polite"
          >
            <p class="muted">Loading published releases from GitHub…</p>
            <noscript
              ><p>
                See <a href="${RELEASES_URL}" rel="noopener">the releases on GitHub</a>.
              </p></noscript
            >
          </div>
        </div>
      </section>
    `,
  };
}

const ROADMAP: { stage: string; note: string; items: string[] }[] = [
  {
    stage: 'Now',
    note: 'Being finished for the first release.',
    items: [
      'First public Windows release with published checksums.',
      'Release automation: build, checksum and upload from a tagged commit.',
      'First-run onboarding in the desktop app.',
    ],
  },
  {
    stage: 'Next',
    note: 'Planned after the first release.',
    items: [
      'Code-signed Windows builds, once the project has a signing certificate.',
      'Update notifications in the desktop app.',
      'Publishing the SDK to npm.',
      'More chat channels beyond Telegram.',
    ],
  },
  {
    stage: 'Later',
    note: 'Wanted, not scheduled.',
    items: [
      'macOS and Linux desktop builds.',
      'Sandboxed command execution (containers or OS sandboxes) as a stricter mode.',
      'Shared team workspaces on a self-hosted gateway.',
    ],
  },
];

export function roadmapPage(): Page {
  return {
    path: '/roadmap/',
    title: 'Roadmap',
    section: 'roadmap',
    description:
      'Where OpenPulse is going: what is being finished now, what comes next and what is wanted later.',
    body: html`
      <section class="page-head">
        <div class="wrap">
          <p class="eyebrow">Roadmap</p>
          <h1>Where it’s going</h1>
          <p class="lead">
            Plans, not promises. Discuss or propose changes on
            <a href="${REPO_URL}/issues" rel="noopener">GitHub</a>.
          </p>
        </div>
      </section>
      <section class="section">
        <div class="wrap roadmap">
          ${ROADMAP.map(
            (col) =>
              html`<div class="roadmap-col">
                <h2>${col.stage}</h2>
                <p class="muted">${col.note}</p>
                <ul>
                  ${col.items.map((item) => html`<li>${item}</li>`)}
                </ul>
              </div>`,
          )}
        </div>
      </section>
    `,
  };
}

export function privacyPage(): Page {
  return {
    path: '/privacy/',
    title: 'Privacy',
    description: 'How the OpenPulse app and this website handle your data.',
    body: html`
      <section class="page-head">
        <div class="wrap">
          <p class="eyebrow">Privacy</p>
          <h1>Privacy</h1>
          <p class="lead">
            Short version: your data stays on your machine, and this website does not track you.
          </p>
        </div>
      </section>
      <section class="section">
        <div class="wrap narrow prose">
          <h2>The OpenPulse app</h2>
          <ul>
            <li>
              There is no OpenPulse account and no OpenPulse server. The app sends no telemetry or
              usage statistics.
            </li>
            <li>
              Your configuration, conversations, agent workspace, traces and credentials are files
              in
              <code>~/.openpulse</code> on your computer.
            </li>
            <li>
              The app connects only to what you configure: the model providers you choose (local
              ones such as Ollama stay on your machine), MCP servers you add, Git remotes you clone
              from, chat channels you enable, and websites the agent fetches when its tools allow
              it.
            </li>
            <li>
              When you use a hosted model provider, the prompts and files the agent sends it are
              governed by that provider’s privacy policy.
            </li>
          </ul>

          <h2>This website</h2>
          <ul>
            <li>
              No cookies, no analytics, no tracking pixels, and no third-party fonts or scripts.
            </li>
            <li>
              The download and changelog pages ask the public GitHub API for the list of releases,
              directly from your browser. GitHub sees that request as it would any visit to GitHub;
              see
              <a
                href="https://docs.github.com/site-policy/privacy-policies/github-general-privacy-statement"
                rel="noopener"
                >GitHub’s privacy statement</a
              >.
            </li>
            <li>Downloads are served by GitHub.</li>
            <li>
              Whoever hosts this site may keep standard server logs (such as IP address and pages
              requested).
            </li>
          </ul>

          <h2>Questions</h2>
          <p>Open an issue on <a href="${REPO_URL}/issues" rel="noopener">GitHub</a>.</p>
        </div>
      </section>
    `,
  };
}

export function notFoundPage(): Page {
  return {
    path: '/404/',
    title: 'Page not found',
    description: 'This page does not exist.',
    body: html`
      <section class="page-head">
        <div class="wrap">
          <p class="eyebrow">404</p>
          <h1>That page doesn’t exist</h1>
          <p class="lead">
            It may have moved. Try the <a href="${href('/docs/')}">docs</a> or go back to the
            <a href="${href('/')}">home page</a>.
          </p>
        </div>
      </section>
    `,
  };
}
