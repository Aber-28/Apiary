# HTTP API

The web interface uses a small JSON API. It is the same API the `apiary` command uses. All write requests must send `Content-Type: application/json`. If a token is set, send it as the `x-apiary-token` header.

| Method and path | Purpose |
| --- | --- |
| `GET /api/state` | Agents, connected AIs, limits, saved agents, version |
| `GET /api/events` | Live updates (Server-Sent Events) |
| `POST /api/agents` | Create a project. Body: `provider`, `goal`, `name`, `access`, `source`, `base` |
| `GET /api/agents/:id/messages` | Chat history |
| `POST /api/agents/:id/messages` | Send a message. Body: `text` |
| `GET /api/agents/:id/logs` | Terminal log lines |
| `POST /api/agents/:id/stop` | Stop an agent and its team |
| `GET /api/agents/:id/resume` | Command to resume the session in a terminal |
| `POST /api/agents/:id/takeover` | Stop and return the resume command |
| `POST /api/agents/:id/pr` | Push and open a pull request. Body: `title`, `body` |
| `DELETE /api/agents/:id` | Delete an agent and its team |
| `GET /api/connections` | Connection status (never includes secrets) |
| `PUT /api/connections/:id` | Change method, key/token, model |
| `POST /api/connections/:id/test` | Run a real connection test |
| `GET /api/github/repos?q=` | Your repositories |
| `GET /api/github/branches?repo=owner/name` | Branches of a repository |
| `GET/POST /api/defs`, `PUT/DELETE /api/defs/:id` | Saved agents |
| `GET/PUT /api/settings` | Delegation limits |
