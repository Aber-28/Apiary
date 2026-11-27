---
description: A simple, chat-first way to run teams of Claude Code and Codex agents on your Linux machine.
---

# Apiary

Apiary is a local web app for Linux. You tell one **lead agent** what you want done. The lead can create **sub-agents** (using Claude, Codex, or both), hand out work in parallel, and report back to you in a single chat.

It was built to be easy: no accounts, no API keys required, no config files. If you can already run `claude` or `codex` in a terminal, Apiary can use them.

> **Use at your own risk.** Agents can run commands and change files. You are responsible for how you use Apiary and for what the agents do. The author is not liable for any damage, data loss or costs. See [Licence and limits](reference/limits.md).

## What you get

* **Chat first.** One conversation per project. Sub-agents appear as a team tree beside it.
* **Claude and Codex together.** A lead on Claude can ask a Codex sub-agent for a second opinion.
* **Terminal or web connections.** Reuse your existing CLI logins, or paste an API key in the browser.
* **You stay in control.** Agents ask before creating sub-agents or merging work, and you can review the changes first.
* **Never stuck on a limit.** If Claude runs out, Codex picks up exactly where it left off using a short handover note, and the other way round. [How it works](using-apiary/continuity.md)
* **A real team.** Agents can message each other and hand work across the team.
* **GitHub built in.** Work on a repository from GitHub; every agent gets its own branch; open a pull request when you are happy.
* **Safe by default.** Listens only on your own computer. Your own working copy is never touched.
* **Take over any time.** Stop an agent and continue its session in your own terminal.
* **Dark and light mode,** a sidebar with sub-menus, and a layout that works on a phone.

## Where to start

1. [Install Apiary on Linux](getting-started/install.md)
2. Follow the [setup wizard](getting-started/setup-wizard.md) to connect Claude, Codex and GitHub, or do it [by hand](getting-started/first-run.md)
3. [Start your first project](using-apiary/projects.md)
4. Learn how [approvals](using-apiary/approvals.md) and [agent collaboration](using-apiary/collaboration.md) work
