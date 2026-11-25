# Security

Agents can run commands on your computer, so Apiary is strict by default.

* **Local only.** It listens on `127.0.0.1`. It will not start on another address without `APIARY_TOKEN`.
* **Host and origin checks.** Requests with an unexpected `Host` (DNS rebinding) or a cross-site `Origin` (CSRF) are rejected. Write requests must be JSON.
* **Secrets stay put.** API keys and tokens live in `~/.apiary/state.json` (permissions 0600, folder 0700). The interface only ever sees the last four characters.
* **Tokens are not written into repositories.** GitHub tokens are passed to git per command, not saved in `.git/config`.
* **Browser protections.** Every response sends a strict Content Security Policy (only Apiary's own scripts run), `X-Frame-Options: DENY`, `nosniff` and `no-referrer`. API answers are never cached.
* **Sign-in.** An optional username and password (see [Sign-in](../using-apiary/sign-in.md)). Only a salted scrypt hash is stored, in `~/.apiary/auth.json` (0600). The session cookie is HttpOnly and SameSite=Strict, signed, lasts 14 days, and stops working when the password changes. Wrong tries are delayed per address and per username.
* **Token handling.** The access token is checked in constant time. The first visit through the access link stores it in an HttpOnly, SameSite=Strict cookie and removes it from the address bar.
* **GitHub token scope.** The token is attached only to requests to `https://github.com/`, never to other servers.
* **Safe imports.** An import is refused if the file contains special files, hard links leaving the export, or anything stored beneath a link. Only import files you exported yourself.
* **Safe by default.** New projects use **Safe** access. **Full access** must be chosen per project.
* **Your checkout is untouched.** In git projects, agents work in separate worktrees on separate branches, and nothing is pushed until you open a pull request.
* **No markup injection.** The interface renders all agent text as plain text.
* **You decide.** By default agents must ask before creating sub-agents or merging their work, and nothing is pushed until you open a pull request. See [Approvals and review](../using-apiary/approvals.md).
* **Limits.** Team depth, size, delegation rounds and agent-to-agent messages are capped, and agents cannot wait on each other in a circle.

## Using it beyond your own computer

Start it with `apiary start --lan`. This enables an access token and accepts requests addressed to an IP address (which cannot be used for DNS rebinding). Host names must be listed in `APIARY_ALLOWED_HOSTS`. Put it behind HTTPS or a VPN if it leaves a network you trust. Turn on a username and password (Security > Sign-in) so you do not need the long link. Plain http sends the password unencrypted, so outside a network you trust use an SSH tunnel, Tailscale or an https reverse proxy. Do **not** expose it directly to the internet: anyone who can sign in can run commands as your user.

**Plain http is not encrypted.** On your own computer (`localhost`) that does not matter. From another device, the access link, API keys and vault passphrase cross the network readable. Prefer an SSH tunnel (`ssh -L 7777:localhost:7777 you@host`), Tailscale, or an https reverse proxy in front of Apiary. Apiary shows "Not encrypted" in the top bar when you are on plain http from another address.

Run `scripts/security-check.sh` for an automatic check, or see the [security checklist](security-checklist.md).

## Reporting a problem

Open a private security advisory on the GitHub repository.


## Secrets

Secrets live only in the encrypted vault (AES-256-GCM, key derived with scrypt from your passphrase, which is never stored). Agents can use a secret only when it is assigned to them and you approve (once or always). Values reach only the running command and are redacted from chat, logs, memory and meeting minutes.


## The code itself

Apiary installs and updates from the official GitHub repository, so that repository is protected: only the owner can change the main branch or the release tags, history cannot be rewritten, and outside pull requests are not accepted. Report problems through private vulnerability reporting.
