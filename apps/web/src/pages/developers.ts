import { html } from '../html.js';
import type { Page } from '../layout.js';
import { REPO_URL, SITE, href } from '../site.js';

export function developersPage(): Page {
  return {
    path: '/developers/',
    title: 'Developers',
    section: 'developers',
    description:
      'Build on OpenPulse: the TypeScript SDK, the CLI, the gateway WebSocket protocol, MCP servers and skills.',
    body: html`
      <section class="page-head">
        <div class="wrap">
          <p class="eyebrow">Developers</p>
          <h1>Everything the app does, you can do from code</h1>
          <p class="lead">
            The desktop app, the CLI and the SDK are all clients of the same gateway protocol. There
            is no private API.
          </p>
        </div>
      </section>

      <section class="section">
        <div class="wrap split-2 align-start">
          <div>
            <h2 class="section-title">TypeScript SDK</h2>
            <p>
              <code>@openpulse/sdk</code> has no runtime dependencies — it uses the WebSocket and
              WebCrypto built into Node 22+ and browsers. Typed calls, streamed agent tasks,
              approvals and structured errors.
            </p>
            <p class="note note-warn">
              The package is ready for npm but has not been published yet. Use it from
              <code>packages/sdk</code> in the repository until it is.
            </p>
            <p><a class="text-link" href="${href('/docs/sdk/')}">SDK reference →</a></p>
          </div>
          <pre class="code-block"><code>import { OpenPulseClient } from '@openpulse/sdk';

const op = await OpenPulseClient.connect({
  url: 'http://127.0.0.1:${SITE.defaultPort}',
  token: process.env.OPENPULSE_TOKEN,
});

for await (const update of op.runTask('Why does the auth test fail?')) {
  if (update.type === 'text') process.stdout.write(update.delta);
  if (update.type === 'tool') console.log('\\n→', update.summary);
  if (update.type === 'approval') await op.approve(update.id, 'deny');
}

await op.close();</code></pre>
        </div>
      </section>

      <section class="section section-alt">
        <div class="wrap split-2 align-start">
          <pre class="code-block"><code>openpulse gateway              # run the gateway
openpulse agent -m "summarise the diff"
openpulse tui                  # chat in the terminal
openpulse status --json
openpulse gateway call models.detect
openpulse approvals            # pending shell approvals
openpulse skills list</code></pre>
          <div>
            <h2 class="section-title">CLI</h2>
            <p>
              <code>openpulse</code> runs and inspects the gateway, chats in the terminal with
              inline approvals, and can call any gateway method directly. Every command takes
              <code>--json</code>, and <code>--url</code>/<code>--token</code> for a gateway on
              another machine.
            </p>
            <p><a class="text-link" href="${href('/docs/cli/')}">CLI reference →</a></p>
          </div>
        </div>
      </section>

      <section class="section">
        <div class="wrap card-grid">
          <div class="card">
            <h3>Gateway protocol</h3>
            <p>
              JSON frames over one WebSocket: requests, responses and events. A client answers a
              signed
              <code>connect.challenge</code> with the gateway token and gets the method list and a
              state snapshot back.
            </p>
            <a class="text-link" href="${href('/docs/protocol/')}">Protocol →</a>
          </div>
          <div class="card">
            <h3>MCP servers</h3>
            <p>
              Any Model Context Protocol server — local over stdio or remote over HTTP — adds its
              tools to the agent, under your approval rules.
            </p>
            <a class="text-link" href="${href('/docs/mcp/')}">MCP →</a>
          </div>
          <div class="card">
            <h3>Skills</h3>
            <p>
              A folder with a <code>SKILL.md</code> teaches the agent a procedure. Share them as Git
              repositories.
            </p>
            <a class="text-link" href="${href('/docs/skills/')}">Skills →</a>
          </div>
        </div>
      </section>

      <section class="section section-alt">
        <div class="wrap narrow">
          <h2 class="section-title">Build from source</h2>
          <p>
            A pnpm monorepo in TypeScript: the gateway, CLI, dashboard, SDK, desktop app and this
            website.
          </p>
          <pre><code>git clone ${REPO_URL}.git
cd openpulse
pnpm install
pnpm build
pnpm check          # format, lint, typecheck, tests
pnpm cli -- gateway # run it</code></pre>
          <p>
            Needs Node.js 22.12 or newer and pnpm. Contributions are welcome — open an issue or a
            pull request on <a href="${REPO_URL}" rel="noopener">GitHub</a>.
          </p>
        </div>
      </section>
    `,
  };
}
