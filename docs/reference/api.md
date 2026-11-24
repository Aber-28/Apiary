# HTTP API

The web interface uses a small JSON API. It is the same API the `apiary` command uses. All write requests must send `Content-Type: application/json`. If a token is set, send it as the `x-apiary-token` header.

| Method and path | Purpose |
| --- | --- |
| `GET /api/state` | Agents, connected AIs, limits, saved agents, version |
| `GET /api/events` | Live updates (Server-Sent Events, including `approval` events) |
| `POST /api/agents` | Create a project. Body: `provider`, `goal`, `name`, `access`, `source`, `base`, `approvals` |
| `GET /api/agents/:id/messages` | Chat history |
| `POST /api/agents/:id/messages` | Send a message. Body: `text`. With `@Name` tags, the tagged agents get it and `tagged` lists them |
| `GET /api/tasks/agents` | Agents a task can be given to (the CEO first) |
| `POST /api/tasks/:id/start` | Send the task to its agent now |
| `GET /api/agents/:id/mentionables` | Who can be tagged from this chat |
| `GET /api/agents/:id/logs` | Terminal log lines |
| `POST /api/agents/:id/stop` | Stop an agent and its team |
| `GET /api/agents/:id/resume` | Command to resume the session in a terminal |
| `POST /api/agents/:id/takeover` | Stop and return the resume command |
| `POST /api/agents/:id/pr` | Push and open a pull request. Body: `title`, `body` |
| `DELETE /api/agents/:id` | Delete an agent and its team |
| `GET /api/agents/:id/diff` | Changes on the agent's branch (for review) |
| `GET /api/approvals` | Pending and recent approval requests |
| `POST /api/approvals/:id/decide` | Answer a request. Body: `decision` (`approve`/`deny`), `note`, `only` (indexes of sub-agents to create) |
| `GET /api/connections` | Connection status (never includes secrets) |
| `PUT /api/connections/:id` | Change method, key/token, model |
| `POST /api/connections/:id/test` | Run a real connection test |
| `GET /api/github/repos?q=` | Your repositories |
| `GET /api/github/branches?repo=owner/name` | Branches of a repository |
| `GET/POST /api/defs`, `PUT/DELETE /api/defs/:id` | Saved agents |
| `GET/PUT /api/settings` | Delegation limits, default for approvals, `defaultProvider`, `onboardingDone` |
| `GET /api/connections/:id/models` | Models to offer as the default (from your account when a key is saved, else suggestions) |
| `GET /api/service`, `POST /api/service` | Status of the auto-start service; body `enabled`, `startNow` |
| `GET /api/chat` | The main chat agent (created on first use) |
| `GET /api/projects/:id/org` | Organisation chart of a project (lead, departments, who reports to whom) |
| `GET /api/agents/:id/files?path=` | List a folder of the project |
| `GET/PUT/DELETE /api/agents/:id/file?path=` | Read (`raw=1` to download), save (body `content`) or delete a project file |
| `GET/POST /api/teams`, `PUT/DELETE /api/teams/:id` | Teams (a lead plus members); `POST /api/agents` accepts `team` |
| `GET/POST /api/memory`, `DELETE /api/memory/:id` | Search (`q`, `agent`, `kind`) and add notes, forget items |
| `GET /api/memory/preview/:agentId?q=` | The MEMORY text an agent would be given |
| `PUT /api/settings` | also accepts `memory` (true/false) |



## 0.5.0 endpoints

| Method | Path | Purpose |
|---|---|---|
| POST | `/api/interview` | Next interview question, or the proposed team when done |
| POST | `/api/org` | Create the CEO and team from the interview |
| GET/PUT | `/api/agents/:id/profile` | Read or edit an agent's Markdown profile and name |
| GET | `/api/meetings`, `/api/meetings/:scope/:date` | List and read minutes |
| POST | `/api/meetings/run` | Hold a meeting now |
| GET | `/api/vault` | Vault status, secret names and eligible agents (never values) |
| POST | `/api/vault/init`, `/unlock`, `/lock`, `/secrets` | Create, unlock, lock, add |
| PUT/DELETE | `/api/vault/secrets/:id` | Edit (value, optional username, note), assign, delete |
| GET | `/api/update` | Update status |
| POST | `/api/update/check`, `/api/update/install` | Check (downloads) and install (install answers 202 and runs in the background; `GET /api/update` then returns `progress` with `pct`, `steps`, `log`, `failed`) |
| GET | `/api/tools` | Which AI tools are installed, and the progress of a running install |
| POST | `/api/tools/install` | Install `{tools: ["claude", "codex"]}` for the current user (answers 202; watch `GET /api/tools`) |
| GET | `/api/provider-usage` | Usage as reported by Claude and Codex themselves (cached, refreshed hourly) |
| POST | `/api/provider-usage/refresh` | Refresh now (`{id}` for one AI) |
| PUT | `/api/settings` | includes `updateCheck`: `daily`, `weekly`, `monthly` or `manual` |
| PUT | `/api/projects/:id/stage` | Set `{stage: building\|maintenance\|closed, note}` |
| GET | `/api/export?vault=0\|1&files=0\|1` | Download everything as a .tar.gz (`&info=1` shows what is included) |
| POST | `/api/import` | Upload an export (`content-type: application/gzip`, header `x-apiary-import: 1`, header `x-vault-passphrase` URL-encoded); Apiary then restarts |
| GET/PUT/DELETE | `/api/projects/:id/plan` | Read, edit or clear a project's phased plan |
| POST | `/api/projects/:id/plan/ask` | Ask the lead to draft a plan |


## 0.6.0 endpoints

| Method | Path | Purpose |
|---|---|---|
| GET/POST | `/api/tasks` | List the board, add a task (to do or back burner) |
| PUT/DELETE | `/api/tasks/:id` | Move, edit, delete |
| GET | `/api/usage?days=` | Tokens per day, per agent and per AI |
| PUT | `/api/usage/limits` | Set limits per AI |
| GET/POST | `/api/repos` | List, add a repository |
| PUT/DELETE | `/api/repos/:id`, POST `/sync` | Edit who may read, remove, update |
| GET/POST | `/api/tickets` | List, open a ticket |
| POST | `/api/tickets/:id/comment`, `/status` | Reply, close or reopen |
| GET | `/api/agents/:id/model-advice` | Suggested model |
| PUT | `/api/agents/:id/model` | Change the model |

## Sign-in

* `POST /api/login` `{username,password}` sets the session cookie. `POST /api/logout` clears it.
* `GET /api/account` shows whether an account exists. `POST /api/account` `{username,password,current}` creates or changes it. `DELETE /api/account` `{current}` removes it.

## Infrastructure

* `GET /api/infra` lists items. `POST /api/infra` adds one. `PUT /api/infra/:id` updates, `DELETE` removes.
* `POST /api/infra/:id/test` checks reachability. `POST /api/infra/:id/confirm` `{ok}` accepts or rejects a suggestion. `POST /api/infra/:id/answer` `{text}` answers a question.

## Factory reset

`POST /api/reset` `{action:"start"}` begins; then `{id, answer}` answers each check in order (YES, YES, a sum). `{action:"cancel"}` cancels. `removeAccount:true` on the last answer also removes the sign-in account.

## Backups and machine usage

* `GET /api/backups` shows settings, status and saved backups. `PUT /api/backups` changes settings. `POST /api/backups/run` makes one now. `GET /api/backups/<file>` downloads one.
* `GET /api/system` returns CPU, memory and disk figures for the local machine.

## Audit log

- `GET /api/audit?q=&kind=&actor=&project=&from=&to=&limit=&offset=` returns `{ total, items: [{ t, kind, actor, project, action, detail }], facets, retentionDays }`, newest first. `kind` can be a comma-separated list. Entries older than 30 days are deleted.

## Health

- `GET /api/health` returns `{ at, level, count, items: [{ id, level, title, problem, fix, link }] }`. `level` is `ok`, `info`, `warn` or `err`.
- `POST /api/health/check` tests the devices and runs every check now, and returns the same shape.
