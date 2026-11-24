# Troubleshooting

## `apiary: command not found`
`~/.local/bin` is not on your `PATH`. Run `echo 'export PATH="$HOME/.local/bin:$PATH"' >> ~/.bashrc && source ~/.bashrc`.

## `Node.js 20 or newer is required`
See [Install on Linux](../getting-started/install.md) for installing a current Node.js.

## A connection shows “Not connected”
* **Terminal:** run `which claude` / `which codex`. If missing, install it. Then log in once by running the command.
* Running as a service? Add the CLI's folder to `Environment=PATH=` in the service file.
* **Web:** make sure a key is saved. Codex also needs a model name.
* Press **Test connection** to see the real error message.

## The setup wizard says the systemd user session is not reachable
Apiary can only install the service from a normal login session (SSH or desktop), not inside a container or after `su`/`sudo`. Log in as the user who will run Apiary and retry, or start it yourself with `apiary`.

## The wizard says I am not signed in, but I am
Press **Check again** after signing in. The check makes a real request, so it also fails if the account has no access or no credit. The message shown is the CLI's own.

## I want to see the setup wizard again
**Settings → Setup guide**.

## “Port 7777 is already in use”
`APIARY_PORT=7790 apiary`, or stop the other process.

## I can't open Apiary from another computer or VM
The default is local-only. Start it with `apiary start --lan` and open the link it prints. If it still fails, allow the port in the firewall (`sudo ufw allow 7777/tcp`) and check you use the server's IP address, not `127.0.0.1`.

## “Host not allowed”
You opened Apiary using a name or address it was not told to accept. Start it with `apiary start --lan` and use the server's IP address, or set `APIARY_ALLOWED_HOSTS=that-name` (with a token) to use a host name.

## “Token required”
Open the full link once (`/?token=…`). Run `apiary token` on the server to see it again.

## GitHub: “Not signed in”
Run `gh auth login`, or save a token under Connections → GitHub.

## “Could not open the pull request”
Push needs write access and an `origin` remote on GitHub. Check the token scopes ([Connect GitHub](../github/connect.md)).

## A sub-agent's work was not merged
Its branch conflicted with another agent's. Apiary aborted the merge and kept the branch (`git branch --list 'apiary/*'`). Ask the lead to resolve it, or merge it yourself.

## An agent seems stuck
Press **Stop**. Use **Take over** to continue in your terminal. Check the **Terminal** tab for errors.

## Reset everything
Stop Apiary and delete `~/.apiary` (this removes projects, saved agents and keys).

## An agent says “Waiting for you”
It needs an approval. Open **Workspace → Approvals** (or the card in the project chat) and approve or deny.

## “This request was already answered or has expired”
Another tab answered it, or Apiary restarted. Message the agent again to continue.

## An agent could not message a teammate
Read the note it received: the name may not exist in this project, the teammate may be waiting for it (use `"wait":false`), or the project reached its message limit (**Agents → Delegation rules**).
