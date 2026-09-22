---
name: github
description: Work with GitHub issues, pull requests and CI runs using the gh CLI.
homepage: https://cli.github.com
metadata: { 'openpulse': { 'emoji': '🐙', 'requires': { 'bins': ['gh'] } } }
---

# GitHub

Use the `gh` CLI through `exec`. It must already be authenticated (`gh auth status`).

Common commands:

```bash
gh pr list --repo owner/repo --limit 10
gh pr view 123 --repo owner/repo --comments
gh pr checks 123 --repo owner/repo
gh issue list --repo owner/repo --label bug
gh issue create --repo owner/repo --title "…" --body "…"
gh run list --repo owner/repo --limit 5
gh run view <run-id> --repo owner/repo --log-failed
```

- Always pass `--repo owner/repo` unless you're inside a clone.
- Prefer `--json` + `--jq` when you need structured output.
- Creating issues, commenting or merging acts on the user's behalf — confirm first.
