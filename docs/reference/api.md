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

