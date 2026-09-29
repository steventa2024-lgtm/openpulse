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
- [ ] **C — Core developer environment** (workspaces, GitHub, editor, diff approval)
- [ ] **D — Agent reliability** (permission enforcement, debugger, checkpoints)
- [ ] **E — AI infrastructure** (model wizard, MCP, monitoring, skills registry)
- [ ] **F — Developer automation** (multi-agent workflows, test runner)
- [ ] **G — SDK**
- [ ] **H — Unified dashboard navigation**
- [ ] **I — Public website**
- [ ] **J — Packaging and release**
- [ ] **K — Final verification**

## Features

| #   | Feature                      | Status | Notes                                                             |
| --- | ---------------------------- | ------ | ----------------------------------------------------------------- |
| 1   | Local AI model setup wizard  | [ ]    | detect Ollama/LM Studio, list models, test inference              |
| 2   | Execution security           | [ ]    | workspace roots enforced in tools, not just command globs         |
| 3   | GitHub workspace manager     | [ ]    | git CLI + GitHub API, no invented repo lists                      |
| 4   | AI code editor               | [ ]    | Monaco over gateway file RPCs                                     |
| 5   | Git diff approval            | [ ]    | real patches, per-file approve/reject, stale-patch guard          |
| 6   | Agent debugger               | [ ]    | real agent events, sanitized export                               |
| 7   | Checkpoints and rollback     | [ ]    | git-object snapshots incl. uncommitted work                       |
| 8   | MCP support                  | [ ]    | stdio + HTTP transports, tools routed through the approval policy |
| 9   | Multi-agent workflows        | [ ]    | roles, delegation, isolated worktrees                             |
| 10  | Skills registry              | [ ]    | install/import/enable, no silent script execution                 |
| 11  | Developer SDK                | [ ]    | `packages/sdk`, same WS protocol                                  |
| 12  | Integrated test runner       | [ ]    | detect toolchain, stream output, AI fix proposals                 |
| 13  | Model monitoring             | [ ]    | only metrics the runtime actually measures                        |
| 14  | Unified workspace experience | [ ]    | navigation across all modules                                     |

## Known blockers (require credentials or authorization)

| Blocker                                          | What it stops            | What is delivered instead                                                       |
| ------------------------------------------------ | ------------------------ | ------------------------------------------------------------------------------- |
| No code-signing certificate                      | Signed installer         | electron-builder signing hooks wired; unsigned build, never described as signed |
| No GitHub release permission in this environment | Published release assets | Release workflow committed; runs on tag push by the repo owner                  |
| No npm auth                                      | Published SDK            | `packages/sdk` publishable config, not published                                |
| No hosting credentials                           | Live website             | `apps/web` builds to static output, deploy documented                           |

## Log

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
