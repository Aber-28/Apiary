# Agents talking to each other

Agents in the same project can **message each other** and **hand work to one another**, not only from parent to child.

## How it works

Like sub-agents, it needs nothing but text. An agent writes a small block in its reply:

````
```apiary-send
{"to":"Writer","text":"Please draft a summary of these three findings: ...","wait":true}
```
````

| Field | Meaning |
| --- | --- |
| `to` | A teammate's name or id. Also `parent` (whoever created me) or `lead` |
| `text` | The question or task. It must stand alone: the teammate cannot see your conversation |
| `wait` | `true` (default): wait for the reply and receive it as your next message. `false`: deliver it and carry on |

The recipient sees it as **Message from teammate NAME**, does the work in its own turn (it can use its own tools and even create its own sub-agents), and its reply goes back to the sender. Both chats show the exchange, so you can follow it in the **Team** list.

Every agent is told who its teammates are and how to message them, so you can simply ask for it: *"Have the Researcher check the numbers with the Writer before reporting."*

## Delegating to an existing agent

Sending a task to a teammate **is** delegation: a Reviewer can hand a fix back to the Coder, or a sub-agent can ask a sibling for a missing fact. To create a *new* agent, an agent uses [`apiary-spawn`](agents.md) instead (which needs your approval by default).

## Safety rails

* **No deadlocks.** An agent cannot wait for someone who is already waiting for it (for example a sub-agent asking its busy parent). Apiary refuses the wait, explains why, and suggests `"wait":false`.
* **No endless chatter.** A project has a limit on agent-to-agent messages (default 30), set under **Agents → Delegation rules**. `0` switches teammate messaging off.
* **Same project only.** Agents can reach only teammates in their own project.
* **Code stays separate.** In git projects each agent has its own branch. Teammates exchange *messages*, not files. Work is merged upwards, from a sub-agent into its parent, after your approval.
