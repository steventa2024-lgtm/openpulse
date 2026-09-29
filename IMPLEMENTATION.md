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
