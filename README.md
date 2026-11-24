# Apiary

A simple, chat-first web app for Linux that runs teams of **Claude Code** and **Codex** agents. One lead agent, as many sub-agents as it needs, one chat, and GitHub built in.

## Install (Linux)

Needs Node.js 20+ and git.

```bash
curl -fsSL https://raw.githubusercontent.com/Aber-28/Apiary/main/install.sh | bash
apiary
```

Open <http://127.0.0.1:7777>, go to **Connections**, and connect Claude, Codex and GitHub through your terminal or the web.

Prefer to do it by hand?

```bash
git clone https://github.com/Aber-28/Apiary.git ~/.local/share/apiary
ln -sf ~/.local/share/apiary/bin/apiary.js ~/.local/bin/apiary
```

## Highlights

* Chat-first projects with a live team tree; dark and light mode
* Claude and Codex together, via your CLI logins or API keys
* Git branch + checkout per agent, auto-commits, merges, pull requests
* Take over any agent in your own terminal
* Local only by default; zero dependencies

## Documentation

Full docs (install, usage, reference, security) are in [`docs/`](docs/README.md) and published on GitBook.

## Development

```bash
npm test
APIARY_MOCK=1 npm start
```

MIT licensed.
