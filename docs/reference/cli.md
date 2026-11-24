# The apiary command

```text
apiary [start] [--lan] [--port N]  Start Apiary. --lan: reachable from other devices, with a token
apiary service <install|uninstall|status> [--lan]
                                   Start Apiary automatically at login (systemd user service)
apiary token                       Print the access link used with --lan
apiary status                      Show connections, projects and agents
apiary connect <claude|codex|github> [--method cli|api|token] [--model NAME]
apiary attach <agent-name>         Follow an agent's terminal log (read-only)
apiary --version | --help
```

## status

```text
● claude  connected  via terminal  · 2.1.331 (Claude Code)
○ codex   not connected  via terminal
○ github  not connected  via terminal

1 project(s), 3 agent(s)
```

## connect

Switch how a service is reached. For keys and tokens, **pipe them in** so they never appear in your shell history or process list:

```bash
echo "$ANTHROPIC_API_KEY" | apiary connect claude --method api --model claude-sonnet-5-5
echo "$GITHUB_TOKEN"      | apiary connect github --method token
apiary connect codex --method cli
```

It runs a connection test afterwards and exits non-zero on failure.

## attach

```bash
apiary attach researcher
```

Matches by name (or id) and prints new log lines as they arrive. Read-only.

`status`, `connect` and `attach` talk to a running Apiary. If you use a non-default port or token, set `APIARY_PORT` / `APIARY_TOKEN` for the command too.

## start --lan

```bash
apiary start --lan
```

Listens on all network addresses and protects Apiary with an access token (created once, stored in `~/.apiary/token`, readable only by you). It prints a ready-to-open link for each address of the machine. `apiary token` prints the link again. See [Run it as a service](../getting-started/service.md#using-it-from-another-device-vm-server-phone).

## service

```bash
apiary service install [--lan]   # start automatically at login
apiary service status
apiary service uninstall
```

Installs, shows or removes a systemd **user** service (no root needed). `--lan` makes the service use [LAN mode](../getting-started/service.md#using-it-from-another-device-vm-server-phone). Uninstalling does not stop a copy that is already running. Start the service now with `systemctl --user start apiary`.

## apiary user

`apiary user` shows whether sign-in is on. `apiary user set <name>` creates or changes the username and password (hidden prompt; piped input also works). `apiary user remove` turns sign-in off. See [Sign-in](../using-apiary/sign-in.md).
