# Agents and sub-agents

## How delegation works

Apiary works the same way for Claude and Codex, because it needs nothing but text. When an agent wants help, it writes a small block in its reply:

````
```apiary-spawn
{"name":"Researcher","role":"Finds facts","task":"Find three sources on X","provider":"codex"}
```
````

Apiary removes the block from the chat, creates the sub-agent, runs it, and gives the report back to the parent as its next message. Several blocks in one reply run in parallel.

| Field | Meaning |
| --- | --- |
| `name` | Short name shown in the team list |
| `role` | What the agent is good at |
| `task` | Complete, self-contained instructions (sub-agents cannot see the chat) |
| `provider` | Optional: `claude` or `codex`. Default is the parent's |
| `agent` | Optional: the name of a [saved agent](saved-agents.md) to reuse |

## Limits

To keep teams small and costs predictable, Apiary enforces limits you can change under [Delegation rules](rules.md): team depth, agents per project, and delegation rounds per message. An agent that hits a limit is told so and must do the work itself.

## Mixing Claude and Codex

A lead can create sub-agents on the other AI, for example Claude as lead and Codex as a reviewer. Each agent uses its own connection (terminal or web).

## The All agents page

**Agents → All agents** lists every agent across projects with its role, AI, connection, status and git branch.
