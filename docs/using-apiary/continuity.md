# Keep going when an AI runs out (continuity)

Claude and Codex each have a usage limit. When one runs out in the middle of a job, most tools simply stop. Apiary keeps the work moving.

## What happens

1. An agent is working on a multi-step task with Claude. It keeps a short **handover note** up to date.
2. Claude reaches its limit, or its sign-in expires.
3. Apiary hands the step to **Codex** (or the other way round) and tells it to **read the handover note first**.
4. Codex checks the files that were being changed, carries on from the next step, and updates the same note.

You see one plain message in the chat ("Claude has reached its usage limit, so Codex takes over this step"). You do not have to copy anything across or explain the task again.

## The handover note

* **One file per task**, overwritten each time. It never grows, however many requests you make.
* Headings: Goal, Done, In progress, Next steps, Decisions, Files changed. Usually well under 40 lines.
* Only kept for real multi-step work. Quick questions do not get one.
* Stored in Apiary's own folder, not in your project, so it does not clutter your code or appear in Git.
* Never contains passwords, keys or tokens (agents are told not to write them, and secrets are redacted from chats and logs).
* **Deleted 7 days** after its last update.

## Why a note and not "the same conversation"

Claude and Codex each keep their own private memory of a conversation, and neither can read the other's. A plain Markdown file is something both can read, so it carries the plan across.

## Limits to know about

* The note is refreshed at the end of a finished turn. If an AI is cut off half-way through a step, the note shows the state before that step. The new AI is told to check the changed files before trusting them.
* It is the agent that writes the note, so it is only as good as what the agent wrote. Apiary does not read the other AI's private memory.
* It needs **both** Claude and Codex connected. With only one, there is nothing to hand over to, and you are asked what to do instead (see [Retries and recovery](recovery.md)).
* Agents using a web API connection cannot write files, so they have no note.
* Writing the note costs a few lines of output per turn. You can switch it off under **Settings, Writing style, Handover notes**.

## Settings

**Handover notes** (on by default) lives on the same settings page as the writing style. Turning it off stops agents from keeping notes and stops the "read the note first" instruction on a switch; the switch itself still happens.
