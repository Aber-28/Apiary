# HTTP API

The web interface uses a small JSON API. It is the same API the `apiary` command uses. All write requests must send `Content-Type: application/json`. If a token is set, send it as the `x-apiary-token` header.

| Method and path | Purpose |
| --- | --- |
| `GET /api/state` | Agents, connected AIs, limits, saved agents, version |
| `GET /api/events` | Live updates (Server-Sent Events, including `approval` events) |
| `POST /api/agents` | Create a project. Body: `provider`, `goal`, `name`, `access`, `source`, `base`, `approvals` |
| `GET /api/agents/:id/messages` | Chat history |
| `POST /api/agents/:id/messages` | Send a message. Body: `text` |
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
