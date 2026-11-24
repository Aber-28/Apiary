# Configuration

Apiary needs no config file. Everything is set in the interface or with environment variables.

## Environment variables

| Variable | Default | Meaning |
| --- | --- | --- |
| `APIARY_PORT` | `7777` | Port to listen on |
| `APIARY_HOST` | `127.0.0.1` | Address to listen on. Anything other than local **requires** `APIARY_TOKEN` |
| `APIARY_TOKEN` | none | Secret needed to use the app. `apiary start --lan` creates one for you (`~/.apiary/token`) |
| `APIARY_ALLOWED_HOSTS` | none | Extra host names accepted (comma separated) |
| `APIARY_HOME` | `~/.apiary` | Where Apiary stores everything |
| `APIARY_MAX_DEPTH` / `_AGENTS` / `_ROUNDS` / `_PEER_MESSAGES` | 2 / 12 / 4 / 30 | Default [delegation limits](../using-apiary/rules.md) |
| `APIARY_MOCK` | off | `1` enables a fake test AI (for development) |

## Files

| Path | Contents |
| --- | --- |
| `~/.apiary/memory.json` | Agent memory: notes and task history (mode 0600) |
| `~/.apiary/state.json` | Projects, chats, logs, saved agents, settings, keys (mode 0600) |
| `~/.apiary/workspaces/` | Folders for projects without a repository |
| `~/.apiary/repos/` | Repositories cloned from GitHub |
| `~/.apiary/worktrees/` | One checkout per agent |

## Backup

Copy `~/.apiary/state.json`. Work in repositories is on git branches.


## Files (0.5.0)

- `~/.apiary/agents/<scope>/<role>.md`: agent profiles
- `~/.apiary/org/company.md`: what the interview learned about your setup
- `~/.apiary/meetings/<scope>/<date>.md`: meeting minutes
- `~/.apiary/vault.json`: encrypted secrets (safe to back up; useless without the passphrase)

Set `APIARY_NO_UPDATE_CHECK=1` to disable the automatic update check.
