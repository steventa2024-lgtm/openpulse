import { html, raw } from '../html.js';
import type { Page } from '../layout.js';
import { REPO_URL, SITE, href } from '../site.js';

/** The four promises beside the hero, as in the product concept. */
const HERO_CARDS = [
  {
    title: 'Runs on your machine',
    body: 'Full control. No cloud required. Works with your models.',
    icon: 'laptop',
  },
  {
    title: 'Works with your models',
    body: 'Ollama, LM Studio and more. Use the models you trust.',
    icon: 'cube',
  },
  {
    title: 'You approve what changes',
    body: 'Agents propose edits as diffs. You review and apply.',
    icon: 'shield',
  },
  {
    title: 'A complete developer platform',
    body: 'Chat, tools, workflows, monitoring and more — in one place.',
    icon: 'grid',
  },
] as const;

/** Line icons (24px grid, 1.8 stroke) drawn for the site; no icon font or third-party script. */
const ICONS: Record<(typeof HERO_CARDS)[number]['icon'], string> = {
  laptop: '<rect x="4" y="5" width="16" height="11" rx="1.5"/><path d="M2 19h20"/>',
  cube: '<path d="M12 2.8 20 7.2v9.6L12 21.2 4 16.8V7.2z"/><path d="M4 7.2 12 11.6l8-4.4M12 11.6v9.6"/>',
  shield:
    '<path d="M12 3 19 6v5.5c0 4.4-3 8-7 9.5-4-1.5-7-5.1-7-9.5V6z"/><path d="m8.8 12 2.2 2.2 4.2-4.4"/>',
  grid: '<rect x="4" y="4" width="6.5" height="6.5" rx="1.2"/><rect x="13.5" y="4" width="6.5" height="6.5" rx="1.2"/><rect x="4" y="13.5" width="6.5" height="6.5" rx="1.2"/><rect x="13.5" y="13.5" width="6.5" height="6.5" rx="1.2"/>',
};

function icon(name: keyof typeof ICONS) {
  return raw(
    `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name]}</svg>`,
  );
}

const windowsLogo = raw(
  '<svg viewBox="0 0 24 24" aria-hidden="true" class="icon"><path fill="currentColor" d="M3 5.2 10.2 4.2v7.1H3zM11.1 4.1 21 2.7v8.6h-9.9zM3 12.2h7.2v7.1L3 18.3zM11.1 12.2H21v8.6l-9.9-1.4z"/></svg>',
);

const githubMark = raw(
  '<svg viewBox="0 0 24 24" aria-hidden="true" class="icon"><path fill="currentColor" d="M12 2a10 10 0 0 0-3.16 19.49c.5.09.68-.22.68-.48v-1.7c-2.78.6-3.37-1.34-3.37-1.34-.45-1.16-1.11-1.47-1.11-1.47-.9-.62.07-.6.07-.6 1 .07 1.53 1.03 1.53 1.03.9 1.52 2.34 1.08 2.91.83.09-.65.35-1.08.63-1.33-2.22-.25-4.55-1.11-4.55-4.94 0-1.09.39-1.98 1.03-2.68-.1-.25-.45-1.27.1-2.64 0 0 .84-.27 2.75 1.02a9.5 9.5 0 0 1 5 0c1.91-1.29 2.75-1.02 2.75-1.02.55 1.37.2 2.39.1 2.64.64.7 1.03 1.59 1.03 2.68 0 3.84-2.34 4.68-4.57 4.93.36.31.68.92.68 1.85v2.74c0 .27.18.58.69.48A10 10 0 0 0 12 2z"/></svg>',
);

const FEATURES = [
  {
    id: 'models',
    title: 'Local model setup',
    body: 'Finds Ollama and LM Studio, lists installed models, runs a real test prompt and sets your default and fallbacks.',
  },
  {
    id: 'security',
    title: 'Enforced permissions',
    body: 'Read-only, balanced or custom modes, folder boundaries and a deny list for secrets — checked by the tools themselves, not just asked of the model.',
  },
  {
    id: 'workspace',
    title: 'Projects and Git',
    body: 'Open or clone repositories, browse branches and history, and see status without leaving the app.',
  },
  {
    id: 'editor',
    title: 'Code editor',
    body: 'A Monaco editor with conflict detection when a file changes on disk under you.',
  },
  {
    id: 'changes',
    title: 'Diff review',
    body: 'Side-by-side or inline diffs, per-file approve and reject, and protection against applying a stale patch.',
  },
  {
    id: 'checkpoints',
    title: 'Checkpoints',
    body: 'Snapshots that keep your uncommitted work, with a preview of exactly what a restore will change.',
  },
  {
    id: 'workflows',
    title: 'Multi-agent workflows',
    body: 'Planner, coder, tester and reviewer roles working one request, each in its own session with its own tools.',
  },
  {
    id: 'mcp',
    title: 'MCP servers',
    body: 'Connect local or remote Model Context Protocol servers; their tools follow the same approval rules as shell commands.',
  },
  {
    id: 'tests',
    title: 'Test runner',
    body: 'Detects your test setup, streams the run, and can hand a failure to an agent whose fix comes back as a diff for you to approve.',
  },
  {
    id: 'debugger',
    title: 'Agent debugger',
    body: 'Every run as a timeline of reasoning, tool calls, outputs and timing, with secrets redacted from exports.',
  },
  {
    id: 'monitoring',
    title: 'Monitoring',
    body: 'Runs, errors, latency and token counts per model — only what was actually measured.',
  },
  {
    id: 'skills',
    title: 'Skills registry',
    body: 'Install skills from Git or a folder. Bundled scripts are listed for you to read; nothing runs on install.',
  },
];

export function homePage(): Page {
  return {
    path: '/',
    title: SITE.name,
    description: SITE.description,
    body: html`
      <section class="hero">
        <div class="hero-glow" aria-hidden="true"></div>
        <div class="wrap hero-grid">
          <div class="hero-copy">
            <p class="eyebrow">Local-first AI developer platform</p>
            <h1>
              <span class="line">Build with AI</span><br />
              <span class="line">on <span class="glow">your machine.</span></span>
            </h1>
            <p class="lead">
              OpenPulse runs coding agents on your own PC, with local models through Ollama or LM
              Studio. They read your projects, run your tests, propose changes — and nothing lands
              until you approve it.
            </p>
            <div class="cta-row">
              <a class="btn btn-primary" href="${href('/download/')}"
                >${windowsLogo} Download for Windows</a
              >
              <a class="btn btn-ghost" href="${REPO_URL}" rel="noopener"
                >${githubMark} View the source</a
              >
            </div>
            <p class="fine">Free and open source · Windows 10 and 11, 64-bit · No account needed</p>
          </div>

          <div class="hero-device" aria-hidden="false">
            <div class="halo-arcs" aria-hidden="true"><span></span><span></span><span></span></div>
            <div class="laptop">
              <div class="laptop-screen">
                <img
                  src="${href('/img/chat.png')}"
                  alt="The OpenPulse dashboard: conversations, the chat with starter tasks, and the project, approvals and system panels"
                  width="1440"
                  height="900"
                />
              </div>
              <div class="laptop-base"></div>
            </div>
          </div>

          <ul class="hero-cards">
            ${HERO_CARDS.map(
              (card) =>
                html`<li class="hero-card">
                  <span class="hero-card-icon">${icon(card.icon)}</span>
                  <span>
                    <strong>${card.title}</strong>
                    <span>${card.body}</span>
                  </span>
                </li>`,
            )}
          </ul>
        </div>
      </section>

      <section class="section">
        <div class="wrap">
          <h2 class="section-title">How it fits together</h2>
          <p class="section-lead">
            The desktop app starts and supervises a gateway on your machine. Every client — the app,
            the CLI, the SDK — speaks the same WebSocket protocol to it, and the gateway is the only
            thing that touches your files or calls a model.
          </p>
          <div
            class="arch"
            role="img"
            aria-label="Clients connect to the gateway, which connects to models, your projects and MCP servers"
          >
            <div class="arch-col">
              <div class="arch-node">Desktop app</div>
              <div class="arch-node">CLI</div>
              <div class="arch-node">SDK &amp; scripts</div>
            </div>
            <div class="arch-link" aria-hidden="true"><span>WebSocket</span></div>
            <div class="arch-core">
              <strong>Gateway</strong>
              <ul>
                <li>Agent loop &amp; workflows</li>
                <li>Tools under your permissions</li>
                <li>Approvals, checkpoints, audit</li>
              </ul>
              <span class="arch-port">127.0.0.1:${SITE.defaultPort}</span>
            </div>
            <div class="arch-link" aria-hidden="true"><span>local</span></div>
            <div class="arch-col">
              <div class="arch-node">Ollama · LM Studio</div>
              <div class="arch-node">Your projects</div>
              <div class="arch-node">MCP servers</div>
            </div>
          </div>
        </div>
      </section>

      <section class="section section-alt">
        <div class="wrap">
          <h2 class="section-title">Everything in one app</h2>
          <div class="card-grid">
            ${FEATURES.map(
              (f) =>
                html`<a class="card card-link" href="${href(`/features/#${f.id}`)}">
                  <h3>${f.title}</h3>
                  <p>${f.body}</p>
                </a>`,
            )}
          </div>
        </div>
      </section>

      <section class="section">
        <div class="wrap split-2">
          <figure class="shot">
            <img
              src="${href('/img/debugger.png')}"
              alt="The OpenPulse debugger timeline of that run: the agent reads src/auth.js, calls propose_change, and finishes in 25 seconds"
              width="1280"
              height="800"
              loading="lazy"
            />
          </figure>
          <div>
            <h2 class="section-title">See exactly what the agent did</h2>
            <p>
              Each run is recorded from the agent's real events: which model answered, what it
              reasoned, every tool it called with inputs and outputs, and how long each step took.
              Export a run for a bug report and keys, tokens and private keys are redacted on the
              way out.
            </p>
            <p>
              <a class="text-link" href="${href('/features/#debugger')}"
                >More about the debugger →</a
              >
            </p>
          </div>
        </div>
      </section>

      <section class="section section-alt">
        <div class="wrap honest">
          <h2 class="section-title">Where things stand</h2>
          <ul class="checks">
            <li>
              Early software, version ${SITE.version}. Windows comes first; macOS and Linux builds
              are on the <a href="${href('/roadmap/')}">roadmap</a>.
            </li>
            <li>
              Windows builds are not code-signed unless a release says so, so SmartScreen may warn
              the first time you run one.
            </li>
            <li>Each release publishes SHA-256 checksums so you can verify what you downloaded.</li>
            <li>
              OpenPulse sends no telemetry. It talks to the model providers and services you
              configure, and nothing else.
            </li>
          </ul>
          <div class="cta-row">
            <a class="btn btn-primary" href="${href('/download/')}">Get OpenPulse</a>
            <a class="btn btn-ghost" href="${href('/docs/getting-started/')}"
              >Read the quick start</a
            >
          </div>
        </div>
      </section>
    `,
  };
}
