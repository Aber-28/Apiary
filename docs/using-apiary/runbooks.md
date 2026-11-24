# Runbooks

A runbook is a short list of steps for a problem that was solved once, so it can be followed again. Open **Workspace > Plan and reuse > Runbooks**.

## How they are made

- **By an agent.** When an agent solves something that could come back (a fix, a setup, a recovery) it saves the steps. The runbook appears as a **Draft** and the menu shows how many are waiting for your review.
- **By you.** Press **New runbook**, write the title, the problem it solves and one step per line. Runbooks you write are approved straight away.

## Approving

Read the steps, edit them if needed, and press **Approve**. Only approved runbooks are given to agents as instructions: the CEO and project leads see them in their briefing and are told to follow a matching one and say which they used. Drafts are never given to agents. If an agent tries to change a runbook you have approved, a separate draft called "... (update)" is made so you can compare, and the approved text stays as it was. **Stop trusting** turns an approved runbook back into a draft.

## Passwords

Passwords, keys and tokens are masked when a runbook is saved. Steps should name the secret to use (for example "log in with the secret Pi login") and never contain the value.

Runbooks are included in [global search](global-search.md).

## API

`GET/POST /api/runbooks`, `PUT/DELETE /api/runbooks/{id}` (see the API reference). Agents save drafts with an `apiary-runbook` block containing `title`, `problem`, `steps` and `tags`.
