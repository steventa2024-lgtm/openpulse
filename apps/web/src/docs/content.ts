import { html, type Html } from '../html.js';
import { REPO_URL, SITE, href } from '../site.js';

export interface DocPage {
  slug: string;
  title: string;
  summary: string;
  group: 'Start' | 'Use' | 'Extend' | 'Reference';
  body: Html;
}

const port = SITE.defaultPort;

export const DOCS: DocPage[] = [
  {
    slug: 'getting-started',
    title: 'Quick start',
    summary: 'Install OpenPulse, connect a local model and run your first task.',
    group: 'Start',
    body: html`
      <h2>1. Install</h2>
      <p>
        Download the installer or the portable build from the
        <a href="${href('/download/')}">download page</a>. If the build is not code-signed, Windows
        SmartScreen warns the first time; check the SHA-256 checksum, then choose
        <em>More info</em> → <em>Run anyway</em>.
      </p>
      <p>
        On first start OpenPulse creates <code>%USERPROFILE%\\.openpulse</code> — the configuration,
        the agent workspace, sessions and logs — and starts its gateway. The dashboard opens in the
        app window.
      </p>

      <h2>2. Connect a model</h2>
      <p>
        Install <a href="https://ollama.com" rel="noopener">Ollama</a> or
        <a href="https://lmstudio.ai" rel="noopener">LM Studio</a>
        and download a model that supports tool calling, for example:
      </p>
      <pre><code>ollama pull qwen3:8b</code></pre>
      <p>
        Open <strong>AI → Models</strong>. OpenPulse lists what it finds; press <em>Test</em> next
        to a model to send it a real prompt, then <em>Use</em> to make it the default. See
        <a href="${href('/docs/local-models/')}">Local models</a> for choosing one.
      </p>

      <h2>3. Add a project</h2>
      <p>
        Open <strong>Workspace → Projects</strong> and add a folder, or clone a repository. The
        project becomes the agent’s working area: in the default <em>balanced</em> mode it can read
        and change files inside it, and nowhere outside the project and its own workspace.
      </p>

      <h2>4. Ask for something</h2>
      <p>
        In <strong>AI → Chat</strong>, ask a question about the project or for a change. The agent
        reads files, runs commands that your approval policy allows, and proposes edits. Review them
        in <strong>Workspace → Changes</strong>, approve what you want, and apply — a checkpoint is
        taken first.
      </p>

      <h2>Running from source instead</h2>
      <pre><code>git clone ${REPO_URL}.git
cd openpulse
pnpm install
pnpm build
pnpm cli -- onboard
pnpm cli -- gateway</code></pre>
      <p>Then open <code>http://127.0.0.1:${port}</code> in a browser.</p>
    `,
  },
  {
    slug: 'desktop',
    title: 'The desktop app',
    summary: 'How the app runs the gateway, which ports it uses, and where it keeps things.',
    group: 'Start',
    body: html`
      <h2>What happens at start-up</h2>
      <ol>
        <li>
          The app checks port ${port}. If an OpenPulse gateway already answers there, it
          <strong>attaches</strong> to it.
        </li>
        <li>
          If the port is free, it <strong>starts its own</strong> gateway using the runtime bundled
          inside the app — no Node.js install is needed.
        </li>
        <li>
          If something else holds the port, it tries the next ones and remembers the port that
          worked.
        </li>
      </ol>
      <p>
        A gateway the app started is restarted automatically if it crashes (with a growing delay, up
        to five times), and is shut down when you quit. A gateway the app merely attached to is
        never stopped or restarted by it.
      </p>

      <h2>Tray and window</h2>
      <p>
        By default, closing the window keeps OpenPulse running in the tray so scheduled jobs and
        chat channels keep working; untick <em>Keep running in the tray</em> in the tray menu to
        quit on close instead. The tray menu also opens the window, restarts the gateway, opens the
        logs folder and quits.
      </p>

      <h2>Where things live</h2>
      <table>
        <tr>
          <th>Path</th>
          <th>What</th>
        </tr>
        <tr>
          <td><code>%USERPROFILE%\\.openpulse</code></td>
          <td>Configuration, workspace, sessions, credentials, logs. Shared with the CLI.</td>
        </tr>
        <tr>
          <td><code>%APPDATA%\\OpenPulse\\desktop.log</code></td>
          <td>The desktop app’s own log: gateway start, health and crashes.</td>
        </tr>
        <tr>
          <td><code>%APPDATA%\\OpenPulse\\desktop-preferences.json</code></td>
          <td>Window and port preferences.</td>
        </tr>
      </table>
      <p>
        Uninstalling removes the program but never <code>.openpulse</code>; delete it yourself if
        you want a clean slate.
      </p>

      <h2>Security</h2>
      <p>
        The gateway token is read by the app’s main process and never handed to the window through
        desktop IPC. The window talks to the gateway the same way a browser would, and the gateway
        listens on loopback only unless you configure otherwise.
      </p>
    `,
  },
  {
    slug: 'local-models',
    title: 'Local models',
    summary: 'Ollama, LM Studio, choosing a model, fallbacks and hosted providers.',
    group: 'Start',
    body: html`
      <h2>Detection</h2>
      <p>
        <strong>AI → Models</strong> looks for Ollama at <code>http://127.0.0.1:11434</code> and LM
        Studio at <code>http://127.0.0.1:1234</code>, lists the installed models with their size and
        quantisation, and shows which one is the default.
      </p>

      <figure class="shot doc-shot">
        <img
          src="${href('/img/models.png')}"
          alt="The Models screen listing the Ollama models installed on this machine, with Test and Use buttons"
          width="1280"
          height="800"
          loading="lazy"
        />
      </figure>

      <h2>Testing a model</h2>
      <p>
        <em>Test</em> sends a short real prompt through the same code path the agent uses and
        reports the time to answer and whether the model called a tool. A model that never calls
        tools can chat but cannot read files or run commands.
      </p>

      <h2>Choosing one</h2>
      <ul>
        <li>
          Pick a model trained for tool calling — recent Qwen, Llama and Mistral instruct models are
          good starting points.
        </li>
        <li>
          Bigger is slower. On a laptop, an 8B model at Q4 is a reasonable balance; coding-specific
          models help with edits.
        </li>
      </ul>

      <h2>Context window</h2>
      <p>
        The agent’s instructions and tool list take about 4,000 tokens before any file is read.
        Ollama loads models with a 4,096-token window unless asked otherwise and silently drops the
        start of a longer prompt, so OpenPulse uses Ollama’s native API and asks for
        <strong>16,384 tokens</strong> on every request. Raise it if your machine has the memory:
      </p>
      <pre><code>models: { providers: { ollama: { contextTokens: 32768 } } }</code></pre>
      <p>
        Conversation history is trimmed to fit whatever window the model has. LM Studio sets the
        window when it loads a model — choose at least 16k in its model settings.
      </p>

      <h2>Fallbacks</h2>
      <p>
        Models are addressed as <code>provider/model</code>, e.g. <code>ollama/qwen3:8b</code>. Set
        an ordered list of fallbacks on the Models page and OpenPulse tries the next one when a
        model fails before answering — not running, not installed or missing a key. A model that
        fails part-way through a reply is not swapped, so two models’ answers are never spliced
        together. In <code>openpulse.json</code>:
      </p>
      <pre><code>agents: {
  defaults: {
    model: { primary: "ollama/qwen3:8b", fallbacks: ["lmstudio/qwen2.5-coder-7b"] },
  },
}</code></pre>

      <h2>Hosted providers</h2>
      <p>
        Hosted models are optional. <code>anthropic/…</code>, <code>openai/…</code>,
        <code>openrouter/…</code> or any OpenAI-compatible endpoint work with a key you add on the
        Models page or under <code>models.providers</code>. Keys are stored in your local
        configuration and are never shown back in the dashboard.
      </p>

      <h2>Token counts</h2>
      <p>
        Monitoring shows the token counts a provider reports. Ollama and LM Studio report them; a
        provider that does not shows “not reported” rather than an estimate.
      </p>
    `,
  },
  {
    slug: 'workspace',
    title: 'Projects, editor and changes',
    summary: 'Projects, Git, the editor, reviewing agent changes and checkpoints.',
    group: 'Use',
    body: html`
      <h2>Projects</h2>
      <p>
        A project is a folder you register. Add one from <strong>Workspace → Projects</strong> or
        clone a Git URL. The active project — chosen in the top bar — is what the editor, Git,
        Changes, Tests and Checkpoints screens work on, and registered projects are automatically
        readable (and in balanced mode writable) by the agent.
      </p>

      <h2>Git</h2>
      <p>
        The Git screen shows status, branches, recent commits and diffs using the Git installed on
        your machine. Cloning private repositories uses Git’s own credential manager; OpenPulse
        never asks for or stores a Git token in the dashboard.
      </p>

      <h2>Editor</h2>
      <p>
        A Monaco editor with a file tree and tabs. If a file changes on disk while it is open —
        because you edited it elsewhere or a change was applied — the editor tells you and does not
        overwrite it silently.
      </p>

      <h2>Changes</h2>
      <p>
        Agents do not write into your project directly when they propose. Each proposal is a change
        set:
      </p>
      <ol>
        <li>
          Open it under <strong>Workspace → Changes</strong> and read each file’s diff side by side,
          inline or as text.
        </li>
        <li>Approve or reject file by file.</li>
        <li>
          Apply. OpenPulse takes a checkpoint (unless you untick it), then writes only the approved
          files.
        </li>
      </ol>
      <p>
        If a file changed after the agent read it, applying that file is refused as stale instead of
        overwriting your edit. Ask the agent to redo it against the current version.
      </p>

      <h2>Checkpoints</h2>
      <p>
        A checkpoint records every tracked and untracked file of a project, including uncommitted
        work, as Git objects under
        <code>refs/openpulse/checkpoints/</code>. It never touches your branch, index or stash.
        Restoring first shows the files that would change and asks you to confirm. Checkpoints need
        the project to be a Git repository.
      </p>
    `,
  },
  {
    slug: 'agents',
    title: 'Chat and workflows',
    summary: 'Talking to the agent, sessions, and multi-agent workflows with roles.',
    group: 'Use',
    body: html`
      <h2>Chat</h2>
      <p>
        <strong>AI → Chat</strong> streams the agent’s reply with its tool calls shown inline. When
        it wants to run a command your policy says a person must approve, the request appears in the
        chat with <em>Allow once</em>, <em>Always</em> and <em>Deny</em>. Each conversation is a
        session you can find again under <strong>Sessions</strong>.
      </p>

      <h2>Workflows</h2>
      <p>
        A workflow runs several agents on one request. Each step is a real agent turn in its own
        session, with a role that decides its instructions, model and tools. Two workflows are built
        in:
      </p>
      <ul>
        <li>
          <strong>Plan, code, test, review</strong> — Planner → Coding Agent → Testing Agent →
          Review Agent.
        </li>
        <li><strong>Research, then plan</strong> — Research Agent → Planner.</li>
      </ul>
      <p>
        Steps whose dependencies are done run in parallel. A step sees the output of the steps it
        depends on. Coding steps propose changes instead of writing files, so parallel agents never
        overwrite each other; you review the result under Changes when the run finishes.
      </p>

      <h2>Roles</h2>
      <table>
        <tr>
          <th>Role</th>
          <th>Can</th>
        </tr>
        <tr>
          <td>Planner</td>
          <td>Read only</td>
        </tr>
        <tr>
          <td>Research Agent</td>
          <td>Read only, including web search and fetch</td>
        </tr>
        <tr>
          <td>Coding Agent</td>
          <td>Read and propose changes</td>
        </tr>
        <tr>
          <td>Testing Agent</td>
          <td>Read and run commands (under your approval policy)</td>
        </tr>
        <tr>
          <td>Review Agent</td>
          <td>Read only</td>
        </tr>
      </table>
      <p>
        Create your own roles and workflows on the Workflows screen. Runs are saved and can be
        cancelled while running.
      </p>
    `,
  },
  {
    slug: 'security',
    title: 'Permissions and safety',
    summary: 'Security modes, folder boundaries, the secret deny list and shell approvals.',
    group: 'Use',
    body: html`
      <p>
        The agent acts as you, on your machine. These limits are enforced inside the gateway’s tools
        on every call; they are not instructions the model could ignore.
      </p>

      <h2>Modes</h2>
      <table>
        <tr>
          <th>Mode</th>
          <th>What the agent can do</th>
        </tr>
        <tr>
          <td>Read only</td>
          <td>
            Read the workspace and projects. No write, edit, shell, process or browser tools; it can
            only propose changes.
          </td>
        </tr>
        <tr>
          <td>Balanced (default)</td>
          <td>
            Change files inside registered projects and its workspace. Shell commands follow the
            approval policy.
          </td>
        </tr>
        <tr>
          <td>Custom</td>
          <td>Balanced, with individual tools switched off.</td>
        </tr>
      </table>

      <h2>Folders</h2>
      <p>
        Reading is allowed in the agent workspace, registered projects and any extra folders you add
        on
        <strong>System → Permissions</strong>. Writing is allowed only in the workspace, projects
        and extra folders you mark writable — and never in read-only mode. Paths are resolved before
        checking, so <code>..</code> tricks do not escape.
      </p>

      <h2>Always refused</h2>
      <p>
        These are refused everywhere, even inside an allowed folder. You can add patterns; you
        cannot remove the built-in ones.
      </p>
      <pre><code>**/.ssh/**  **/.aws/credentials  **/.aws/config  **/.gnupg/**
**/.openpulse/credentials/**  **/.openpulse/identity/**  **/.openpulse/devices/**
**/id_rsa*  **/id_ed25519*  **/*.pem  **/*.pfx  **/.npmrc  **/.git-credentials</code></pre>

      <h2>Shell commands</h2>
      <p>
        Every command is risk-classified. Catastrophic ones are refused outright. Otherwise the
        policy in
        <code>exec-approvals.json</code> decides: <code>deny</code>, <code>allowlist</code> or
        <code>full</code>, and whether to ask when a command is not on the allowlist. Pending
        approvals show up in chat, the dashboard and <code>openpulse approvals</code>; unanswered
        ones fall back to the configured answer after a timeout.
      </p>

      <h2>Secrets in logs and exports</h2>
      <p>
        API keys, bearer tokens, private keys and the gateway token are redacted from debugger
        traces and diagnostics exports, and secret-named fields are masked.
      </p>

      <h2>Configuration</h2>
      <pre><code>security: {
  mode: "balanced",           // "read-only" | "balanced" | "custom"
  readRoots: ["D:/datasets"],
  writeRoots: [],
  denyPatterns: ["**/secrets/**"],
  tools: { browser: false },  // custom mode only
}</code></pre>
    `,
  },
  {
    slug: 'mcp',
    title: 'MCP servers',
    summary: 'Connecting Model Context Protocol servers and controlling their tools.',
    group: 'Extend',
    body: html`
      <p>
        OpenPulse is an MCP client. Each server you connect contributes tools named
        <code>mcp__&lt;server&gt;__&lt;tool&gt;</code>
        to every agent run.
      </p>
      <h2>Adding a server</h2>
      <p>On <strong>Developer tools → MCP</strong>, choose:</p>
      <ul>
        <li>
          <strong>Local process (stdio)</strong> — a command and arguments, e.g.
          <code>npx -y @modelcontextprotocol/server-filesystem C:\\projects</code>, plus optional
          environment variables.
        </li>
        <li>
          <strong>Remote (HTTP)</strong> — the server’s URL. JSON and server-sent-event responses
          are both supported.
        </li>
      </ul>
      <p>
        The server is connected straight away; its tools, version and output appear on the same
        screen.
      </p>

      <h2>Approval</h2>
      <p>
        By default every call to a server’s tools waits for your approval, like an unlisted shell
        command. Mark a server
        <em>trusted</em> only if you have read its code. Individual tools can be switched off, and
        any tool can be tried by hand from the dashboard.
      </p>

      <h2>Configuration</h2>
      <pre><code>mcp: {
  servers: {
    files: {
      transport: "stdio",
      command: "npx",
      args: ["-y", "@modelcontextprotocol/server-filesystem", "C:/projects"],
      trust: "ask",
    },
    docs: { transport: "http", url: "https://mcp.example.com/mcp", headers: { Authorization: "Bearer \${DOCS_TOKEN}" } },
  },
}</code></pre>
      <p>
        <code>\${VAR}</code> is replaced from the environment, so tokens need not be written into
        the file.
      </p>
    `,
  },
  {
    slug: 'skills',
    title: 'Skills',
    summary: 'What skills are, installing them safely and writing your own.',
    group: 'Extend',
    body: html`
      <p>
        A skill is a folder with a <code>SKILL.md</code>: front matter with a name and a description
        of when to use it, then instructions. The agent sees the list of skills and reads one when
        the description matches the task.
      </p>
      <h2>Where skills come from</h2>
      <table>
        <tr>
          <th>Source</th>
          <th>Location</th>
        </tr>
        <tr>
          <td>Bundled</td>
          <td>Shipped with OpenPulse.</td>
        </tr>
        <tr>
          <td>Managed</td>
          <td><code>~/.openpulse/skills</code> — installed from Git or a folder.</td>
        </tr>
        <tr>
          <td>Workspace</td>
          <td><code>skills/</code> inside the agent workspace, versioned with it.</td>
        </tr>
      </table>

      <h2>Installing</h2>
      <p>
        On <strong>Developer tools → Skills</strong>, install from a Git URL (optionally a
        subfolder) or a local folder. The skill is validated first; problems and warnings are shown.
        Scripts the skill ships are <strong>listed, never run</strong> — installing only copies
        files. The agent uses a script only if it decides to run it, under your normal approval
        rules.
      </p>

      <h2>Writing one</h2>
      <pre><code>---
name: release-notes
description: Draft release notes from the commits since the last tag.
---

1. Run \`git describe --tags --abbrev=0\` to find the last tag.
2. Read \`git log &lt;tag&gt;..HEAD --oneline\`.
3. Group the changes into Added / Changed / Fixed and write them to RELEASE_NOTES.md.</code></pre>
      <p><em>Create a skill</em> on the Skills screen writes this template for you.</p>
    `,
  },
  {
    slug: 'testing',
    title: 'Tests, debugger and monitoring',
    summary: 'Running tests, fixing failures with an agent, reading traces and metrics.',
    group: 'Extend',
    body: html`
      <h2>Tests</h2>
      <p>
        <strong>Developer tools → Tests</strong> detects the active project’s test setup:
        <code>package.json</code> test scripts (npm, pnpm, yarn), pytest, cargo, go, Maven, Gradle
        and dotnet. <em>Run</em> starts the project’s own command and streams its output; pass or
        fail comes from the exit code.
      </p>
      <p>
        On a failed run, <em>Ask the agent for a fix</em> sends the output to an agent. Its fix
        arrives as a change set under Changes — nothing is written until you approve it.
      </p>

      <h2>Debugger</h2>
      <p>
        Every agent run is recorded from its real events: start, reasoning, output, tool calls with
        input and output, approvals, errors and the end, each with a timestamp and duration. Filter
        by kind, search the trace, cancel a running run, or export it as JSON.
        <em>Export diagnostics</em> bundles versions, configuration shape and recent runs. Exports
        are redacted.
      </p>
      <p class="muted">
        The last 200 runs are kept, across restarts, in <code>~/.openpulse/traces</code>. If the
        primary model fails before answering and a fallback takes over, the timeline shows the
        switch.
      </p>

      <h2>Monitoring</h2>
      <p>
        Runs, errors, tool calls, token counts and latency (average and p95) per model for the last
        hour, day, week or month, plus most-used tools and an activity chart. Only measured values
        are shown.
      </p>
    `,
  },
  {
    slug: 'sdk',
    title: 'SDK',
    summary: 'The TypeScript/JavaScript SDK: connecting, running tasks, events and errors.',
    group: 'Reference',
    body: html`
      <p class="note note-warn">
        <code>@openpulse/sdk</code> is prepared for npm but not published yet. Use it from
        <code>packages/sdk</code> in the repository until it is.
      </p>
      <h2>Connect</h2>
      <p>
        The gateway token is in <code>~/.openpulse/openpulse.json</code> under
        <code>gateway.auth.token</code>.
      </p>
      <pre><code>import { OpenPulseClient } from '@openpulse/sdk';

const op = await OpenPulseClient.connect({
  url: 'http://127.0.0.1:${port}',
  token: process.env.OPENPULSE_TOKEN,
});
console.log(op.hello.server.version);</code></pre>
      <p>
        From the same machine the token is enough. From another machine the gateway also requires a
        paired device: create one with <code>createDeviceIdentity()</code>, keep its keys, and
        approve it once with <code>openpulse devices approve &lt;requestId&gt;</code>.
      </p>

      <h2>Run a task</h2>
      <pre><code>const result = await op.run('Summarise the README in three bullet points');
console.log(result.text, result.usage);

for await (const update of op.runTask('Find the failing test and explain it')) {
  if (update.type === 'text') process.stdout.write(update.delta);
  if (update.type === 'tool') console.log(update.phase, update.summary);
  if (update.type === 'approval') await op.approve(update.id, 'deny'); // or 'allow-once', 'allow-always'
  if (update.type === 'error') console.error(update.message);
}</code></pre>

      <h2>Other calls</h2>
      <table>
        <tr>
          <th>Call</th>
          <th>What it does</th>
        </tr>
        <tr>
          <td><code>op.health()</code>, <code>op.status()</code></td>
          <td>Gateway health and state</td>
        </tr>
        <tr>
          <td>
            <code>op.sessions.list()</code>, <code>.history(key)</code>, <code>.reset(key)</code>
          </td>
          <td>Conversations</td>
        </tr>
        <tr>
          <td><code>op.models.list()</code>, <code>.detect()</code>, <code>.test(ref)</code></td>
          <td>Models and a live test</td>
        </tr>
        <tr>
          <td><code>op.tools.list()</code></td>
          <td>Tools a run would get now, including MCP tools</td>
        </tr>
        <tr>
          <td>
            <code>op.runs.list()</code>, <code>.trace(runId)</code>,
            <code>.cancel(sessionKey)</code>
          </td>
          <td>Run history and traces</td>
        </tr>
        <tr>
          <td>
            <code>op.workflows.start(id, request)</code>, <code>.wait(id)</code>,
            <code>.cancel(id)</code>
          </td>
          <td>Workflows</td>
        </tr>
        <tr>
          <td><code>op.on(event, listener)</code></td>
          <td>Any gateway event</td>
        </tr>
        <tr>
          <td><code>op.request(method, params)</code></td>
          <td>Any gateway method</td>
        </tr>
      </table>

      <h2>Errors</h2>
      <p>
        Every failure is an <code>OpenPulseError</code> with a <code>code</code> —
        <code>UNAUTHORIZED</code>, <code>PAIRING_REQUIRED</code>, <code>NOT_FOUND</code>,
        <code>INVALID_REQUEST</code>, <code>CONFLICT</code>, <code>FORBIDDEN</code>,
        <code>TIMEOUT</code>, <code>CLOSED</code>, <code>CONNECT_FAILED</code> — and
        <code>retryable</code> is true for connection problems worth retrying.
      </p>
    `,
  },
  {
    slug: 'cli',
    title: 'CLI',
    summary: 'The openpulse command: running the gateway, chatting and scripting.',
    group: 'Reference',
    body: html`
      <pre><code>openpulse onboard                   first-run wizard
openpulse setup                     config + workspace, no prompts
openpulse gateway                   run the gateway (also: gateway status, gateway call)
openpulse tui                       interactive chat with inline approvals
openpulse agent -m "…"              one turn, printed
openpulse status | health | doctor  what is going on
openpulse logs --follow             stream the log
openpulse sessions | channels | pairing | devices | cron | skills | approvals | config</code></pre>
      <p>
        Every command takes <code>--json</code> for scripting, <code>--url</code> and
        <code>--token</code> for a gateway on another machine, and <code>--profile</code> for a
        second state directory.
      </p>
      <h2>Calling any method</h2>
      <pre><code>openpulse gateway call models.detect
openpulse gateway call tests.detect
openpulse gateway call tests.run '{"suiteId":"node:test"}'</code></pre>
      <h2>Configuration</h2>
      <pre><code>openpulse config get agents.defaults.model.primary
openpulse config set agents.defaults.model.primary '"ollama/qwen3:8b"'</code></pre>
    `,
  },
  {
    slug: 'protocol',
    title: 'Gateway protocol',
    summary: 'Frames, the connect handshake, methods and events.',
    group: 'Reference',
    body: html`
      <p>
        One WebSocket on the gateway’s port (default ${port}) carries JSON text frames. The
        dashboard, CLI, SDK and desktop app all use it.
      </p>
      <h2>Frames</h2>
      <pre><code>{ "type": "req",   "id": "1", "method": "models.detect", "params": {} }
{ "type": "res",   "id": "1", "ok": true, "payload": { … } }
{ "type": "res",   "id": "2", "ok": false, "error": { "code": "NOT_FOUND", "message": "…" } }
{ "type": "event", "event": "chat", "payload": { … }, "seq": 42 }</code></pre>

      <h2>Handshake</h2>
      <ol>
        <li>The server sends a <code>connect.challenge</code> event with a nonce.</li>
        <li>
          The client sends a <code>connect</code> request: protocol range
          (<code>minProtocol</code>/<code>maxProtocol</code>, currently 3), client info,
          <code>auth.token</code>, and a <code>device</code> block — its ECDSA P-256 public key and
          a signature over the nonce.
        </li>
        <li>
          The server answers with <code>hello-ok</code>: server version, the methods and events
          available, and a state snapshot.
        </li>
      </ol>
      <p>
        Devices on loopback are paired automatically. Anything else gets
        <code>PAIRING_REQUIRED</code> until approved with <code>openpulse devices approve</code>.
      </p>

      <h2>Errors</h2>
      <p>
        <code>INVALID_REQUEST</code>, <code>UNAUTHORIZED</code>, <code>FORBIDDEN</code>,
        <code>NOT_FOUND</code>, <code>CONFLICT</code>, <code>UNAVAILABLE</code>,
        <code>PAIRING_REQUIRED</code>, <code>INTERNAL</code>.
      </p>

      <h2>Discovering methods</h2>
      <p>
        The <code>hello-ok</code> payload lists every method. Groups include <code>chat.*</code>,
        <code>sessions.*</code>, <code>projects.*</code>, <code>workspace.*</code>,
        <code>git.*</code>, <code>changes.*</code>, <code>checkpoints.*</code>,
        <code>models.*</code>, <code>mcp.*</code>, <code>tests.*</code>, <code>debug.*</code>,
        <code>workflows.*</code>, <code>skills.*</code>, <code>security.*</code> and
        <code>config.*</code>.
      </p>
    `,
  },
  {
    slug: 'configuration',
    title: 'Configuration',
    summary: 'openpulse.json: format, hot reload and the main sections.',
    group: 'Reference',
    body: html`
      <p>
        <code>~/.openpulse/openpulse.json</code> is JSON5 — comments and trailing commas are fine.
        It is validated strictly, so a misspelled key is an error rather than silently ignored, and
        <code>\${ENV_VAR}</code> is replaced from the environment. The gateway watches the file and
        reloads everything except the port and bind address.
      </p>
      <p>
        Edit it by hand, on <strong>System → Config</strong>, or with
        <code>openpulse config set</code>.
      </p>
      <table>
        <tr>
          <th>Section</th>
          <th>What it holds</th>
        </tr>
        <tr>
          <td><code>gateway</code></td>
          <td>Port, bind address and auth token</td>
        </tr>
        <tr>
          <td><code>agents.defaults</code></td>
          <td>Model (primary and fallbacks), thinking level, workspace, heartbeat</td>
        </tr>
        <tr>
          <td><code>models.providers</code></td>
          <td>Base URL and API key per provider</td>
        </tr>
        <tr>
          <td><code>security</code></td>
          <td>Mode, extra read/write folders, deny patterns, tool switches</td>
        </tr>
        <tr>
          <td><code>mcp.servers</code></td>
          <td>MCP servers</td>
        </tr>
        <tr>
          <td><code>channels</code></td>
          <td>Chat channels such as Telegram</td>
        </tr>
      </table>
    `,
  },
  {
    slug: 'troubleshooting',
    title: 'Troubleshooting',
    summary: 'Common problems and where to look.',
    group: 'Reference',
    body: html`
      <h2>The app says the gateway failed to start</h2>
      <p>
        Open diagnostics from the error screen or the tray, and read
        <code>%APPDATA%\\OpenPulse\\desktop.log</code> and
        <code>%USERPROFILE%\\.openpulse\\logs</code>. A configuration error in
        <code>openpulse.json</code> is the usual cause — the log names the key.
      </p>
      <h2>Port ${port} is taken</h2>
      <p>
        The desktop app moves to the next free port by itself. From the CLI, set
        <code>gateway.port</code> or pass <code>--port</code>.
      </p>
      <h2>Ollama is not detected</h2>
      <p>
        Check that it is running (<code>ollama list</code> should work) and listening on
        <code>127.0.0.1:11434</code>. If you run it elsewhere, set
        <code>models.providers.ollama.baseUrl</code>.
      </p>
      <h2>The model answers but never uses tools</h2>
      <p>
        Use <em>Test</em> on the Models page. If it reports no tool calls, pick a model trained for
        tool calling and give it a larger context window.
      </p>
      <h2>“… is outside the allowed workspace”</h2>
      <p>
        The agent tried to touch a path outside its permissions; the message lists the folders it
        may use. Register the project, or allow the folder on <strong>System → Permissions</strong>.
        “Always-denied list” means the path matches a secret pattern and is refused everywhere.
      </p>
      <h2>Applying a change says the file is stale</h2>
      <p>
        The file changed after the agent read it. Ask the agent to redo the change against the
        current file.
      </p>
      <h2>Reporting a bug</h2>
      <p>
        Export diagnostics from the Debugger (it is redacted, but read it before sharing) and open
        an issue on
        <a href="${REPO_URL}/issues" rel="noopener">GitHub</a>.
      </p>
    `,
  },
];
