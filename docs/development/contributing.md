# Contributing and tests

```bash
git clone https://github.com/Aber-28/Apiary.git
cd apiary
npm test                         # end-to-end tests with the mock AI
APIARY_MOCK=1 npm start          # run the UI with a fake AI, no accounts needed
```

The tests start a real server and exercise: the delegation and message parsers, approvals (approve, partial, deny, stop, merge review), agent-to-agent messaging (including deadlock refusal), security checks, delegation and parallel sub-agents, stop and delete, persistence, saved agents, settings and connections (including that secrets are never returned), and a full git project with worktrees, merges, a push and cleanup.

## Guidelines

* Keep it dependency-free and build-step-free.
* Render all dynamic text with `textContent` (the `h()` helper does this).
* Add a test for every behaviour change.
* Keep the interface simple: one obvious action per screen.

## Documentation

The `docs/` folder is the source of the GitBook site (`docs/SUMMARY.md` is the table of contents). Edit it here and let GitBook's Git Sync publish it.
