# Codex

## Terminal

```bash
npm install -g @openai/codex
codex login
```

Apiary runs `codex exec --json` and resumes sessions between turns. **Safe** access uses the `workspace-write` sandbox; **Full access** uses `danger-full-access`. Codex has no system-prompt flag, so Apiary sends its team instructions with the first message.

## Web (API key)

Paste an OpenAI API key and **enter a model name** (required) under **Connections → Codex → Web · API key**. Web agents are text-only.

## Test it

Press **Test connection**, or run `apiary status`.
