# Architecture

Apiary is deliberately small: **Node.js ≥ 20, no dependencies, no build step**.

```text
public/            vanilla JS single-page app (index.html, app.js, style.css)
src/server.js      HTTP + Server-Sent Events, security checks, static files
src/engine.js      agents, chat, delegation loop, git worktrees
src/providers.js   claude/codex CLI runners, API runners, mock
src/connections.js connection settings and tests
src/github.js      gh CLI and REST access
src/git.js         worktree, commit, merge, push helpers
src/store.js       JSON state file (mode 0600)
bin/apiary.js      the apiary command
test/e2e.mjs       end-to-end tests with a mock AI
```

## Providers

A provider turns "run this prompt for this agent" into either a **CLI subprocess** (`claude -p --output-format stream-json`, `codex exec --json`) or a **streaming API call**. Each streams text, activity and log lines through callbacks. A `mock` provider makes tests deterministic.

## Delegation

Agents delegate by writing fenced `apiary-spawn` JSON blocks. The engine parses them, creates children, runs them in parallel, merges their branches, and returns the reports as the parent's next message. This is provider-agnostic because it needs only text.

## Git model

One worktree and branch per agent; children branch from their parent; auto-commit after every turn; conflicts abort and are reported; branches survive deletion. See [Branches, worktrees and pull requests](../github/workflow.md).

## State

Everything is in one JSON file written atomically, debounced by 300 ms. In-flight work interrupted by a restart is marked idle.
