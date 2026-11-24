# Saved agents

Saved agents are reusable specialists such as a *Reviewer*, a *Test writer* or a *Security checker*.

Open **Agents → Saved agents** and press **New saved agent**:

| Field | Meaning |
| --- | --- |
| Name | How agents refer to it. Must be unique |
| Role | A short description |
| AI | Always use Claude or Codex, or follow the agent that calls it |
| Model | Optional model override |
| Instructions | Standing instructions added to its system prompt |

Every lead and sub-agent is told which saved agents exist. To use one, an agent writes `{"agent":"Reviewer","task":"..."}` in a delegation block. You can also ask in chat: *"Have the Reviewer check the changes."*
