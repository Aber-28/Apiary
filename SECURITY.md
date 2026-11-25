# Security policy

Apiary can run commands on your computer through the agents it controls, so security reports are taken seriously.

**Please do not open a public issue for a vulnerability.** Use GitHub's private reporting: *Security → Report a vulnerability* on this repository.

Include what you found, steps to reproduce, and the Apiary version (`apiary --version`). You can expect an acknowledgement within a few days.

Supported version: the latest release on `main`.

## Check your own install

`bash scripts/security-check.sh` runs a read-only self-test and prints a report that is safe to share. The checklist is in [docs/reference/security-checklist.md](docs/reference/security-checklist.md).

## What Apiary does by default

- Listens only on `127.0.0.1`; refuses to open to the network without an access token.
- Keeps its data folder private (700) and its files at 600; secrets live in an AES-256-GCM vault and are redacted from chat, logs, memory and exports.
- Rejects foreign `Host` headers and cross-site requests, and sends a strict Content-Security-Policy.
- Asks you before creating sub-agents, merging, or running commands that change things.
