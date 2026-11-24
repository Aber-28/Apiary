# Delegation rules

Open **Agents → Delegation rules**.

| Setting | Default | Meaning |
| --- | --- | --- |
| How deep the team can go | 2 | `1` = only the lead creates sub-agents. `2` = sub-agents may create their own |
| Maximum agents per project | 12 | Hard cap including the lead |
| Delegation rounds per message | 4 | How many times the lead may hand out work and read reports before it must answer |
| Agent-to-agent messages per project | 30 | How many messages agents may send each other. `0` turns teammate messaging off |

The same page has **Ask me first**, the default for new projects: approve or deny new sub-agents and merges. See [Approvals and review](approvals.md).

Changes apply to the next message. Defaults can also be set with the environment variables `APIARY_MAX_DEPTH`, `APIARY_MAX_AGENTS`, `APIARY_MAX_ROUNDS` and `APIARY_MAX_PEER_MESSAGES`; the values saved in the interface take priority.

Smaller numbers are simpler to follow and cheaper to run.
