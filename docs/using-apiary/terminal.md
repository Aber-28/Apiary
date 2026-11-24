# Terminal sessions and take over

Agents connected through the terminal run the real `claude` or `codex` command, so every session is a normal CLI session you can continue yourself.

## Terminal sessions page

**Workspace → Terminal sessions** lists every terminal agent with its folder and status.

## Take over

Press **Take over** on an agent. Apiary:

1. **stops** the agent, so you and the agent never write at the same time, and
2. shows the exact command to continue the same session in your own terminal, for example:

```bash
cd '/home/you/.apiary/worktrees/ab12cd34/lead' && claude --resume 'SESSION-ID'
```

When you are finished, message the agent in Apiary to hand it back. Because agents commit after each turn, your changes and theirs stay on the agent's branch.

## Watch without interfering

```bash
apiary attach "Researcher"
```

This follows an agent's log live and is **read-only**. The **Terminal** tab in the workspace shows the same log.

{% hint style="info" %}
Web (API key) agents have no terminal session, so Take over is not offered for them.
{% endhint %}
