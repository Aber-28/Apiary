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

## “Port 7777 is already in use”
`APIARY_PORT=7790 apiary`, or stop the other process.

## “Host not allowed”
You opened Apiary using a name other than `localhost` / `127.0.0.1`. Set `APIARY_ALLOWED_HOSTS=that-name` and a token.

## “Token required”
Open the page once with `/?token=YOUR_TOKEN`.

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
