import { html } from '../html.js';
import type { Page } from '../layout.js';
import { href } from '../site.js';

interface Feature {
  id: string;
  group: string;
  title: string;
  lead: string;
  points: string[];
  doc?: string;
}

const FEATURES: Feature[] = [
  {
    id: 'desktop',
    group: 'Platform',
    title: 'A desktop app that looks after the gateway',
    lead: 'The Windows app bundles everything it needs — no Node.js install — and supervises the gateway for you.',
    points: [
      'Attaches to a gateway that is already running, so a developer’s own openpulse gateway keeps working.',
      'Starts its own when none is running, picks another port if something else holds the default, and restarts it if it crashes.',
      'Only ever stops a gateway it started itself.',
      'The gateway token stays in the main process; the window never receives it through desktop IPC.',
    ],
    doc: 'desktop',
  },
  {
    id: 'models',
    group: 'AI',
    title: 'Local model setup',
    lead: 'Point OpenPulse at a model you already run and it checks that it actually works.',
    points: [
      'Detects Ollama and LM Studio on their default ports and lists the models you have installed, with size and quantisation.',
      'Sends a real test prompt and reports whether the model answered, how long it took and whether it can call tools.',
      'Sets the primary model and an ordered list of fallbacks with one click.',
      'Hosted providers (Anthropic, OpenAI or any OpenAI-compatible endpoint) are optional; their keys live in your local config.',
    ],
    doc: 'local-models',
  },
  {
    id: 'security',
    group: 'Platform',
    title: 'Permissions that are enforced',
    lead: 'Limits are checked by the gateway’s file and shell tools on every call — the model cannot talk its way past them.',
    points: [
      'Read-only mode removes every write, edit, shell, process and browser tool; the agent can only propose changes.',
      'Balanced mode allows writes inside your projects and the agent workspace, and nowhere else.',
      'Custom mode lets you switch individual tools off.',
      'A deny list refuses secrets everywhere — SSH keys, cloud credentials, .pem and .pfx files, .npmrc, .git-credentials.',
      'Shell commands are risk-classified and follow your approval policy; secrets are redacted from logs and exports.',
    ],
    doc: 'security',
  },
  {
    id: 'workspace',
    group: 'Workspace',
    title: 'Projects and Git',
    lead: 'Register the folders and repositories you work on, and give agents access to exactly those.',
    points: [
      'Open a local folder or clone a repository; switch the active project from the top bar.',
      'Status, branches, history and diffs from your real Git install.',
      'Credentials stay with Git’s own credential manager — the dashboard never sees a token.',
    ],
    doc: 'workspace',
  },
  {
    id: 'editor',
    group: 'Workspace',
    title: 'Code editor',
    lead: 'The Monaco editor, bundled offline, for reading and editing project files.',
    points: [
      'File tree, tabs, syntax highlighting and Ctrl+S to save.',
      'Detects when a file changes on disk while you have it open, and asks before overwriting.',
      'Agent edits never go straight into the editor — they arrive as proposals under Changes.',
    ],
    doc: 'workspace',
  },
  {
    id: 'changes',
    group: 'Workspace',
    title: 'Diff review and approval',
    lead: 'Every agent edit is a change set you review before anything touches disk.',
    points: [
      'Side-by-side, inline or plain-text unified diffs.',
      'Approve or reject file by file, then apply only what you approved.',
      'Refuses to apply a change if the file has changed since the agent read it, instead of silently overwriting your work.',
      'Takes a checkpoint first, so applying is always reversible.',
    ],
    doc: 'workspace',
  },
  {
    id: 'checkpoints',
    group: 'Workspace',
    title: 'Checkpoints and rollback',
    lead: 'Snapshots of a project that include your uncommitted work.',
    points: [
      'Stored as Git objects under refs/openpulse — your branch, index and stash are left alone.',
      'Created automatically before changes are applied, or by hand.',
      'Restoring shows exactly which files will change first, and asks you to confirm.',
    ],
    doc: 'workspace',
  },
  {
    id: 'workflows',
    group: 'Automation',
    title: 'Multi-agent workflows',
    lead: 'Several agents on one request, each a real agent turn with its own role, model and tools.',
    points: [
      'Built-in roles: Planner, Research Agent, Coding Agent, Testing Agent and Review Agent; add your own.',
      'Steps run in order or in parallel, and each sees the output of the steps it depends on.',
      'Coding steps propose changes rather than writing files, so two agents never overwrite each other.',
      'Runs are saved, and you can cancel one mid-way.',
    ],
    doc: 'agents',
  },
  {
    id: 'mcp',
    group: 'Developer tools',
    title: 'MCP servers',
    lead: 'Connect Model Context Protocol servers and give their tools to your agents.',
    points: [
      'Local servers over stdio and remote servers over HTTP (JSON or server-sent events).',
      'Each server’s tools can be switched on or off individually, and tried directly from the dashboard.',
      'Tools ask for approval before each call unless you mark the server as trusted.',
    ],
    doc: 'mcp',
  },
  {
    id: 'skills',
    group: 'Developer tools',
    title: 'Skills registry',
    lead: 'Skills are folders with a SKILL.md that teach the agent a procedure.',
    points: [
      'Install from a Git repository or a local folder, validate first, update and remove.',
      'Scripts a skill ships are listed for you to read. Installing never runs them.',
      'Create a new skill from a template in your workspace or the shared skills folder.',
    ],
    doc: 'skills',
  },
  {
    id: 'tests',
    group: 'Developer tools',
    title: 'Integrated test runner',
    lead: 'Runs your project’s own test command and reports what it actually did.',
    points: [
      'Detects npm, pnpm and yarn test scripts, pytest, cargo, go, Maven, Gradle and dotnet.',
      'Streams output live; pass or fail comes from the exit code.',
      'Hand a failing run to an agent and its fix arrives as a diff for approval.',
    ],
    doc: 'testing',
  },
  {
    id: 'debugger',
    group: 'Developer tools',
    title: 'Agent debugger',
    lead: 'Every run as it actually happened, built from the agent’s real events.',
    points: [
      'Timeline of reasoning, output, tool calls and results, with timing for each step.',
      'Filter by event type or search inside the trace; cancel a run that is still going.',
      'Export a run or a diagnostics bundle with keys, tokens and private keys redacted.',
    ],
    doc: 'testing',
  },
  {
    id: 'monitoring',
    group: 'AI',
    title: 'Model monitoring',
    lead: 'What the agent loop measured — nothing estimated.',
    points: [
      'Runs, errors, tool calls and latency (average and p95) per model, over the last hour to the last 30 days.',
      'Token counts exactly as providers report them; a provider that reports none shows as not reported.',
      'Most-used tools and an activity chart.',
    ],
    doc: 'testing',
  },
  {
    id: 'sdk',
    group: 'Developer tools',
    title: 'TypeScript SDK',
    lead: 'Everything the app can do, from your own code.',
    points: [
      'Zero dependencies: the WebSocket and WebCrypto built into Node 22+ and browsers.',
      'Typed methods, streamed agent tasks, approvals and structured errors.',
      'Ready for npm, not yet published — use it from the repository for now.',
    ],
    doc: 'sdk',
  },
];

export function featuresPage(): Page {
  const groups = [...new Set(FEATURES.map((f) => f.group))];
  return {
    path: '/features/',
    title: 'Features',
    section: 'features',
    description:
      'What OpenPulse does: local models, enforced permissions, Git workspaces, diff review, checkpoints, workflows, MCP, tests, debugging and monitoring.',
    body: html`
      <section class="page-head">
        <div class="wrap">
          <p class="eyebrow">Features</p>
          <h1>Built for agents you can trust with real code</h1>
          <p class="lead">
            Every feature below exists in the current build. Where something is not finished, it
            says so.
          </p>
          <nav class="chip-nav" aria-label="Feature groups">
            ${groups.map((g) => html`<a href="#${FEATURES.find((f) => f.group === g)!.id}">${g}</a>`)}
          </nav>
        </div>
      </section>
      <section class="section">
        <div class="wrap feature-list">
          ${FEATURES.map(
            (f) =>
              html`<article class="feature" id="${f.id}">
                <div class="feature-head">
                  <p class="eyebrow">${f.group}</p>
                  <h2>${f.title}</h2>
                  <p>${f.lead}</p>
                  ${f.doc ? html`<a class="text-link" href="${href(`/docs/${f.doc}/`)}">Read the docs →</a>` : ''}
                </div>
                <ul class="checks">
                  ${f.points.map((p) => html`<li>${p}</li>`)}
                </ul>
              </article>`,
          )}
        </div>
      </section>
    `,
  };
}
