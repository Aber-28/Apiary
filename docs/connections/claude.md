# Claude Code

## Terminal

```bash
npm install -g @anthropic-ai/claude-code
claude          # sign in once
```

Apiary runs `claude -p --output-format stream-json` for each turn and resumes the same session between turns (`--resume`). **Safe** access uses `--permission-mode acceptEdits`; **Full access** uses `bypassPermissions`.

Optional model: set a model name under **Connections → Claude Code** or per saved agent.

## Web (API key)

Paste an Anthropic API key under **Connections → Claude Code → Web · API key**. The default model is `claude-sonnet-5-5`; you can change it. Web agents are text-only.

## Test it

Press **Test connection**, or run `apiary status`.
