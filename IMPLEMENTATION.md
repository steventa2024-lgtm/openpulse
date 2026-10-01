# OpenPulse — implementation progress

Living record of the platform build. Updated as each piece lands; nothing is marked done until its
tests pass and it is wired to the real gateway.

Legend: `[ ]` not started · `[~]` in progress · `[x]` done and verified · `[!]` blocked

## Baseline (before this build)

Commit `83ef1af`. Three packages, ~17k lines TypeScript, 132 passing tests.

- `packages/gateway` — WS control plane (protocol v3), agent loop over the Vercel AI SDK, 16 tools,
  sessions/transcripts, skills, cron, heartbeat, Telegram channel, exec approvals, device pairing.
- `packages/cli` — onboarding, gateway control, TUI chat, every RPC as a command.
- `packages/dashboard` — Control UI (React + Vite) served by the gateway.

Verified working: agent turns with tool calls against Ollama, approval prompts end to end, config
hot reload, cron, skills gating, CLI + Control UI against a live gateway.

## Phases

- [x] **A — Repository audit**
- [x] **B — Desktop foundation** (Electron shell, gateway supervision, tray, packaging config)
- [x] **C — Core developer environment** (workspaces, Git, editor, diff approval)
- [x] **D — Agent reliability** (permission enforcement, debugger, checkpoints)
- [x] **E — AI infrastructure** (model setup, MCP, monitoring, skills registry)
- [x] **F — Developer automation** (multi-agent workflows, test runner)
- [x] **G — SDK**
- [x] **H — Unified dashboard navigation** (and the "Halo" redesign)
- [x] **I — Public website** (built and tested locally; not deployed — no hosting credentials)
- [ ] **J — Packaging and release** (installer builds locally; CI and release workflow still to do)
- [ ] **K — Final verification**

## Features

| #   | Feature                      | Status | Notes                                                                                                       |
| --- | ---------------------------- | ------ | ----------------------------------------------------------------------------------------------------------- |
| 1   | Local AI model setup wizard  | [x]    | Ollama/LM Studio detection, live test prompt, default + ordered fallbacks (fallbacks now used by the agent) |
| 2   | Execution security           | [x]    | modes, folder roots and deny list enforced in tools; shell approvals                                        |
| 3   | GitHub workspace manager     | [x]    | projects, clone/status/branches/log via the git CLI; no GitHub API (not needed for these)                   |
| 4   | AI code editor               | [x]    | offline Monaco, conflict detection; agent edits arrive as proposals                                         |
| 5   | Git diff approval            | [x]    | side-by-side/inline/text, per-file approve/reject, stale-patch guard, checkpoint first                      |
| 6   | Agent debugger               | [x]    | timeline from real events, kept across restarts, redacted export                                            |
| 7   | Checkpoints and rollback     | [x]    | git objects under refs/openpulse incl. uncommitted work, restore preview                                    |
| 8   | MCP support                  | [x]    | stdio + HTTP, per-tool switches, approval unless trusted                                                    |
| 9   | Multi-agent workflows        | [x]    | roles, parallel steps, coding steps propose (no shared-file overwrites) instead of separate worktrees       |
| 10  | Skills registry              | [x]    | install from git/folder, validate, update, remove; scripts listed, never run                                |
| 11  | Developer SDK                | [x]    | `packages/sdk`, zero deps, builds for Node and browsers; not published to npm                               |
| 12  | Integrated test runner       | [x]    | ecosystem detection, streamed output, agent fix as a change set                                             |
| 13  | Model monitoring             | [x]    | measured values only; token counts as providers report them                                                 |
| 14  | Unified workspace experience | [x]    | grouped navigation, Ctrl+K search, three-column chat with project/approvals/system context                  |

## Known blockers (require credentials or authorization)

| Blocker                                          | What it stops            | What is delivered instead                                                       |
| ------------------------------------------------ | ------------------------ | ------------------------------------------------------------------------------- |
| No code-signing certificate                      | Signed installer         | electron-builder signing hooks wired; unsigned build, never described as signed |
| No GitHub release permission in this environment | Published release assets | Release workflow committed; runs on tag push by the repo owner                  |
| No npm auth                                      | Published SDK            | `packages/sdk` publishable config, not published                                |
| No hosting credentials                           | Live website             | `apps/web` builds to static output, deploy documented                           |

## Log

- **2026-09-28** — Phase H, workspace screens. Navigation regrouped into Home / Workspace / AI /
  Automation / Developer tools / System with every existing screen kept; a project switcher in the
  top bar drives all workspace pages. New pages: Projects (open folder, clone, switch, remove), Git
  (status, per-file diff, commit, branches, history, fetch), Editor (Monaco bundled for offline use,
  file tree with create/rename/delete, tabs, search, preferences, read-only mode, AI actions that
  explain or propose reviewable changes), Changes (Monaco side-by-side and inline diff, per-file
  approve/reject, apply with an automatic checkpoint), Checkpoints (save, previewed and typed-confirm
  restore).
  Verified in the browser against a live gateway and a real git repository: registered a project;
  edited and saved a file (on disk); a second writer changed the file mid-edit and the editor flagged
  the conflict, refused the stale save and kept the other writer's content; git showed the real
  diff; approved one file of a two-file proposal, applied it with a checkpoint (the rejected file
  was never created); restored the checkpoint from the UI and confirmed the file on disk. Three bugs
  found and fixed on the way: the editor treated the echo of its own save as a conflict, Ctrl+S was
  re-registered on every keystroke and could miss, and placeholder text was double-escaped.

- **2026-09-28** — Phase G: `packages/sdk` (`@openpulse/sdk`). Zero runtime dependencies — native
  WebSocket and WebCrypto in Node 22+ and browsers — over the existing protocol, not a second API.
  Typed helpers for health, sessions, models, tools, runs/traces, workflows and approvals;
  `runTask()` streams text, reasoning, tool calls, approval requests and the final answer;
  `createDeviceIdentity()` for remote gateways; every failure is an `OpenPulseError` with a code.
  Publishable package config, README, example project. Not published (no npm authorisation).
  Added a `tools.list` gateway RPC for tool inspection.
  Verified: 12 tests against a real gateway (scripted model), including streaming, device identity,
  debugger traces and a multi-agent workflow run end to end.

- **2026-09-28** — Multi-agent workflows (gateway side). Roles (planner, researcher, coder, tester,
  reviewer, plus custom) set instructions, model and a permission level that maps to tools. Every
  workflow step is an ordinary agent turn in its own session; steps run in dependency order and
  independent ones run side by side up to a limit. No step can write files: coding roles propose
  changes, which is how parallel agents are kept from overwriting each other, and change sets a
  step proposes are linked to the run for review. Graphs are validated (unknown roles, unknown
  dependencies, cycles); failed dependencies skip their dependants; cancel aborts running steps;
  runs and definitions persist, and a run interrupted by a restart is recorded as such.
  New RPCs: workflows.list/save/remove/role.save/role.remove/start/cancel/executions/execution.
  Verified: 11 tests driving real (scripted-model) agent turns, including parallel research steps
  and a coder step whose proposal lands in review without touching the file.

- **2026-09-28** — Skills registry (gateway side). `SkillRegistry` validates a skill folder
  (frontmatter, name, size) and lists every script it ships; installs from a local folder or a git
  repository (byte-exact clone, `.git` stripped, commit recorded); updates from the recorded origin;
  scaffolds new skills from a starter template; removes managed and workspace skills while refusing
  bundled ones and anything outside the skill directories. Nothing a skill ships is run on install —
  a test plants an `install.sh` that would write a marker file and checks it never appears.
  New RPCs: skills.inspect/validate/install/create/remove/upgrade.

- **2026-09-28** — Test runner and debugger (gateway side). `detectTestSuites` finds the test
  commands a project declares (npm/pnpm/yarn/bun scripts, pytest, cargo, go, maven, gradle, dotnet)
  and checks each tool is installed, reporting unavailable suites with the reason. `TestRunner`
  spawns the real command, streams output, takes pass/fail from the exit code, supports cancel, and
  parses failure names where the format allows — never invents them. `tests.fix` hands a real
  failure to the agent and asks for a fix via `propose_change`, so it lands in review. Suites run by
  id only, so the RPC cannot run arbitrary commands; read-only mode refuses to run tests at all.
  `TraceRecorder` builds a per-run timeline from the events the runner already emits (start, model,
  reasoning, tool calls with timing, output, errors, approvals, end) and redacts secrets on the way
  in — pattern-based plus the gateway's own literal keys and tokens. New RPCs: tests.detect/run/
  cancel/history/get/fix, debug.runs/trace/export/diagnostics.
  Verified: 226 gateway tests, including a trace and telemetry recorded from an actual scripted run.

- **2026-09-28** — Model setup and monitoring (gateway side). `detectLocalProviders` probes Ollama
  and LM Studio and reports what is installed, what is running and what to do when neither is —
  no invented model lists. `inspectOllamaModel` reads the real context window and tool-calling
  capability, and warns about the 4k default window that quietly truncates agent prompts.
  `Runtime.testModel` runs an actual turn plus a tool-call probe, because that is the only honest
  way to say a model works. `TelemetryStore` records what the agent loop measured — provider token
  counts, wall-clock duration, tool calls, errors, aborts — persisted as JSONL and summarised per
  model, per session and per hour. Nothing is estimated: a provider that reports no usage shows
  zero, not a guess.
  New RPCs: models.detect/inspect/test/use/credentials.set, telemetry.summary/runs.
  Verified: 204 gateway tests, 11 new covering detection, inspection warnings and summaries.

- **2026-09-28** — MCP support (gateway side). `McpClient` speaks JSON-RPC 2.0 over stdio
  (newline-delimited) and HTTP (JSON or single-event SSE), covering initialize, tools/list and
  tools/call. `McpManager` connects the servers declared in `openpulse.json`, reports health, and
  exposes their tools as `mcp__<server>__<tool>` so nothing can shadow a built-in. Untrusted servers
  route every call through the existing approval flow; trusted ones run directly. Tool allow/deny
  and trust changes apply without dropping the connection — only transport changes reconnect.
  New RPCs: mcp.status/connect/disconnect/add/remove/tool.set/call.
  Verified: 193 gateway tests, including 16 against a real MCP server (`test/fixtures/mcp-test-server.mjs`)
  covering handshake, discovery, calls, tool failure, a server that refuses to start, approval
  granted and declined, and per-tool switches.

  Still open: the MCP management page in the UI.

- **2026-09-28** — Change proposals and checkpoints (gateway side). `ChangeStore` records proposed
  edits with the hash each file had when proposed; approval is per file, applying re-checks the hash
  so a stale patch is skipped with a reason instead of reverting newer work. Diffs are computed in
  process (`changes/diff.ts`), so review works for untracked files and projects without git. The
  agent proposes through a new `propose_change` tool, which stays available even in read-only mode
  because it writes nothing. `CheckpointService` snapshots a project including uncommitted and
  untracked work — in git repos through a scratch index and a real commit object, leaving the
  developer's index and branch untouched, with line-ending translation off so restores are
  byte-exact; elsewhere by copying. Restoring previews what it would change, always takes a
  "before restoring" checkpoint first, and requires an explicit confirm.
  New RPCs: changes.list/get/create/decide/apply/remove, checkpoints.list/create/preview/restore/remove.
  Verified: 174 gateway tests (12 change, 6 checkpoint, including a rollback of a rollback).

  Still open on these two features: the review and checkpoint UI, and wiring `git.commit` into the
  approval flow.

- **2026-09-28** — Phase C, gateway half. `FsPolicy` now bounds every filesystem tool by declared
  roots and a secret deny list (the deny globs were silently never matching until a test caught the
  pattern translation — fixed). Security modes select tools: read-only removes write/exec/browser,
  custom switches named tools off. `ProjectStore` registers developer projects (validated paths, git
  detection) and those paths are what widen the policy. `GitRepo` wraps the git CLI with argument
  arrays only — a branch name containing `; echo pwned` is just an invalid ref. `FileService` serves
  the editor with hash-based conflict detection. New RPCs: projects._, security._, workspace.tree,
  workspace.file.*, workspace.search, git.status/branches/log/diff/show/checkout/fetch/commit/clone.
  Verified: 156 gateway tests, including 18 security, 10 git (against real git), 10 file service and
  12 over-the-wire RPC tests.

- **2026-09-28** — Phase B: `apps/desktop` (Electron + TypeScript). Gateway supervisor attaches to a
  running gateway, or spawns the bundled one with the Electron binary (`ELECTRON_RUN_AS_NODE=1`), so
  an installed OpenPulse needs no Node or pnpm. Port probing distinguishes an OpenPulse gateway, a
  foreign listener and a free port, and falls back to the next port when something else holds the
  preferred one — which is exactly what happened on the build machine, where a Windows service holds 18789. Tray, window-state persistence, notifications, diagnostics, desktop log, single instance,
  IPC bridge without credentials, generated icon, NSIS + portable packaging.
  Verified: 13 supervisor tests; `electron .` starts and loads the Control UI; `electron-builder`
  produced `OpenPulse-Setup-0.1.0-x64.exe` (83 MB) and a portable build; the **packaged** app
  (`packaged: true`) launched, spawned its bundled gateway, created a fresh state dir and connected
  the Control UI. Installer signature status checked: **NotSigned** (no certificate present).
- **2026-09-28** — Phase A audit complete. Confirmed absent: Electron, installer, website, SDK, MCP,
  editor, git integration, diff approval, checkpoints, multi-agent, test runner, telemetry, CI.
  Started Phase B.

### 2026-09-28 — Dashboard batch 2 (models, monitoring, workflows, tests, debugger, MCP, permissions, skills registry UI)

- New pages routed under AI / Developer tools / System; typecheck, lint (0 errors) and build pass.
- Browser-verified against a live gateway: Tests page ran the demo project's real `npm test` (passed, output streamed); Models page detected the local Ollama models and a real test prompt to qwen2.5-coder:1.5b answered in 5s; Permissions, Workflows, MCP, Monitoring render with real (empty) data.
- Fixed Monaco DiffEditor "TextModel got disposed" on unmount (keep models, dispose after the editor); verified in the browser: no console error after leaving Changes.
- 2026-09-30: real agent runs via the SDK against Ollama qwen3:8b (one used the `read` tool, 21s) show up in Debugger and Monitoring. Token usage was always 0 because the OpenAI-compatible provider did not request stream usage; now `includeUsage: true` (verified: 4027 in / 153 out), and a provider that reports nothing shows "not reported" instead of 0. Debugger/Workflows list+detail layout no longer overflows horizontally. Test runner passes one quoted command line to the shell (no DEP0190 warning). `pnpm run check`: 303 tests pass.
- Next: Phase I (website), Phase J (CI/release), docs, final report.

### 2026-09-30 — Gateway fixes found while documenting, the website, and the "Halo" redesign

- **Fallback models** were stored but never used. The runner now tries the next fallback when a model
  fails before producing anything (unreachable, not installed, no key); explicit model requests don't
  fall back. Recorded as a `model.fallback` event in the debugger. Tests: `model-fallback.test.ts`.
- **Ollama context window.** Ollama loads models with 4,096 tokens and silently drops the start of longer
  prompts; the agent's system prompt alone is ~4k, so every file read made qwen3:8b forget its task.
  The built-in `ollama` provider now uses Ollama's native API (`ollama-ai-provider-v2`) and sends
  `num_ctx` (default 16,384, `models.providers.<id>.contextTokens`). History is trimmed to fit the
  model's window. Verified with real Ollama: `ollama ps` shows 16384, and qwen3:8b now reads a file and
  calls `propose_change` (it didn't before). Tests: `ollama-native.test.ts` against a fake `/api/chat`.
- **Active project in chat.** The chat agent is told which project is open, so "src/auth.js" resolves in
  it (verified in the browser with qwen3:8b). Test in `agent.test.ts`.
- **Debugger history** now survives gateway restarts (traces were written but never read back).
- `propose_change` result wording made unambiguous (a small model claimed the change was "approved").
- **SDK build** fixed: the published build had no Node types but read `process` directly.
- **Website** (`apps/web`): static generator, pages /, /download, /features, /developers, /docs/* (14),
  /changelog, /roadmap, /privacy, 404. Download page reads the live GitHub releases API — verified it
  returns an empty list for this repo, so the page says no download is available yet; never links an
  installer directly. No third-party scripts/fonts/cookies. Tests: release selection + built-site checks
  (links, no secrets, no direct .exe links, no unconditional "signed" claims). Not deployed.
- **"Halo" redesign** to the user's concept image: halo logo (`assets/brand`), app icon variants,
  desktop `.ico` and loading/error screens, dashboard palette/top bar/sidebar icons/Ctrl+K search,
  three-column Chat (conversations, welcome starters, capability chips, composer, Project Context /
  Pending Approvals / System from live data), icon-rail layout down to the desktop app's 900px minimum,
  website hero ("Build with AI on your machine.") with the real Chat screenshot, README logo + banner.
  Screenshots are captured from the running app by `apps/web/scripts/capture-screenshots.ts`; brand
  rasters by `scripts/render-brand.ts`.
- `pnpm run check`: 339 tests pass, 0 lint errors. Installer and portable build rebuilt (unsigned —
  `Get-AuthenticodeSignature` reports NotSigned).
- Next: Phase J (CI + release workflow), then final verification.
