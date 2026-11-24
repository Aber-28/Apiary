# Contributing

Thanks for helping make Apiary better.

1. Fork and clone, then `npm test` (needs Node.js 20+ and git).
2. Run the UI with a fake AI: `APIARY_MOCK=1 npm start`.
3. Keep it **dependency-free** and **build-step-free**. Render dynamic text with `textContent` only.
4. Add a test in `test/e2e.mjs` for every behaviour change, and update `docs/` if users will notice.
5. Open a pull request with a short description of what and why. CI must pass.

See [docs/development](docs/development/contributing.md) for the architecture.
