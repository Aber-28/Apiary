# Security

Agents can run commands on your computer, so Apiary is strict by default.

* **Local only.** It listens on `127.0.0.1`. It will not start on another address without `APIARY_TOKEN`.
* **Host and origin checks.** Requests with an unexpected `Host` (DNS rebinding) or a cross-site `Origin` (CSRF) are rejected. Write requests must be JSON.
* **Secrets stay put.** API keys and tokens live in `~/.apiary/state.json` (permissions 0600, folder 0700). The interface only ever sees the last four characters.
* **Tokens are not written into repositories.** GitHub tokens are passed to git per command, not saved in `.git/config`.
* **Safe by default.** New projects use **Safe** access. **Full access** must be chosen per project.
* **Your checkout is untouched.** In git projects, agents work in separate worktrees on separate branches, and nothing is pushed until you open a pull request.
* **No markup injection.** The interface renders all agent text as plain text.
* **You decide.** By default agents must ask before creating sub-agents or merging their work, and nothing is pushed until you open a pull request. See [Approvals and review](../using-apiary/approvals.md).
* **Limits.** Team depth, size, delegation rounds and agent-to-agent messages are capped, and agents cannot wait on each other in a circle.

## Using it beyond your own computer

Set `APIARY_TOKEN` and `APIARY_ALLOWED_HOSTS`, and put it behind HTTPS. Do **not** expose it directly to the internet: anyone with the token can run commands as your user.

## Reporting a problem

Open a private security advisory on the GitHub repository.
