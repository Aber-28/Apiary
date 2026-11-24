# The apiary command

```text
apiary [start]                     Start Apiary
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
