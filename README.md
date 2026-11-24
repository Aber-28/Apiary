# Apiary

A simple, chat-first web app for Linux that runs teams of **Claude Code** and **Codex** agents. One lead agent, as many sub-agents as it needs, one chat, and GitHub built in.

## Install (Linux)

Needs Node.js 20+ and git.

```bash
curl -fsSL https://raw.githubusercontent.com/Aber-28/Apiary/main/install.sh | bash
```

The installer starts Apiary and prints where to open it. On a server, answer **y** when it asks about other devices (or add `-s -- --lan` after `bash`) and open the private link it prints.

The setup wizard opens on first run: it detects your AI logins, helps you sign in, lets you pick default models and can start Apiary automatically at login.

Open <http://127.0.0.1:7777> (on a VM or server? run `apiary start --lan` and open the link it prints from your own computer), go to **Connections**, and connect Claude, Codex and GitHub through your terminal or the web.

Prefer to do it by hand?

```bash
git clone https://github.com/Aber-28/Apiary.git ~/.local/share/apiary
ln -sf ~/.local/share/apiary/bin/apiary.js ~/.local/bin/apiary
```

## Highlights

* Chat-first projects with a live team tree; dark and light mode
* Claude and Codex together, via your CLI logins or API keys
* Approve or deny new sub-agents and merges; review the diff first
* Agents message each other and hand work across the team
* A main chat for everyday questions; every project is its own space with its own files, team and organisation chart
* Memory for every agent: tonight, yesterday, last week, last month and last year are recalled automatically
* Teams with a CEO: work goes to the right specialist, who checks with the others first; hiring suggestions come with reasons and ready-made profiles
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

Free to use, not open for modification: see [LICENSE](LICENSE). Documentation: https://aber-28.gitbook.io/aber-28-docs/
