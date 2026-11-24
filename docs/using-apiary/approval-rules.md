# Approval rules

Approval rules let you decide once instead of approving every request. Open **Settings > Approval rules**.

## What a rule says

A rule has an action, a kind of request, and optional limits:

- **Action:** *Allow without asking*, *Always ask me*, or *Block*.
- **Kind:** use a secret, create sub-agents, hire a team member, accept a project plan, merge code, or anything.
- **Limits (optional):** one project, one secret name (for secrets), and words the request must mention.

Examples:

- *Always ask me* when an agent wants to use the secret "Router password".
- *Allow without asking* when an agent wants to accept a project plan, in one project.
- *Block* any secret request that mentions "delete".

## Which rule wins

If more than one rule fits a request, the most careful wins: **block, then ask, then allow**. A request that no rule covers is asked as usual. An allowed or blocked request is recorded in the Approvals list as decided by a rule, and in the [Audit log](audit-log.md); you are not notified.

## What rules do not cover

Rules cover Apiary's own approvals: secrets, new agents, hires, plans and merges. They do not judge the individual commands an agent runs in its terminal (for example "read-only checks on a server"): those follow each agent's **Safe** or **Full** access setting. Allowing a secret does not skip the other protections: the secret must still be assigned to the agent and the vault unlocked. Agents cannot create or change rules.

## API

`GET/POST /api/policy`, `DELETE /api/policy/{id}` (see the API reference).
