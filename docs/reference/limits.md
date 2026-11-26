# Limits and what to expect

Honest numbers, so nothing surprises you. Every figure here was checked against the code for this version.

## Pictures and screenshots

| | |
|---|---|
| Where they live | On the computer Apiary runs on, in its own folder (never inside your project) |
| How long | **30 days** by default. Choose 90, 180 or 365 days, or **never delete**, under Access and safety |
| Types | PNG, JPEG, GIF and WebP only (judged by the file contents, not its name). SVG is refused because it can carry scripts |
| Size | Up to **8 MB** each, **6** per message |
| Privacy | Whatever is visible in a picture is sent to the AI you chose. Do not attach pictures of passwords or private data |

## Handover notes

One short file per multi-step task, overwritten each time, deleted **7 days** after the last update. Switch off under Settings. See [Keep going when an AI runs out](../using-apiary/continuity.md).

## When an AI hits its limit

* A short network problem or a run that goes quiet for **20 minutes** is retried, **2 times** by default (0 to 5).
* A usage limit or lost sign-in hands that step to the other AI, **if you have both connected**. The agent keeps its own AI for later steps.
* If nothing works, you get a plain-words request on the Approvals page.
* The two AIs cannot read each other's private memory. The handover note is what carries the plan across, and it can miss work that was cut off mid-step.

## Updates

* While an update is waiting for running jobs, **new work is held**, so the wait cannot grow forever.
* The update only installs after you press **Update now!**. Held work resumes after the restart.
* Updates come from the project's `main` branch with no signature check. See the [security audit](security-audit.md).

## Approvals

* Decided approvals move to the archive after **1 hour**.
* Decisions made automatically by your own rules are hidden from the list.
* Requests nobody answers stay waiting; they are not approved for you.

## Audit log

Entries are kept for **30 days**, then removed.

## Backups

* Off by default. When on, daily or weekly at the time you pick.
* The newest **7** backups are kept by default (1 to 60); older ones are deleted.
* Each backup is opened and checked right after it is written.
* A backup on the same machine does not protect you if the machine is lost. Set a second folder on another disk or share.
* You need the vault password to read the vault from a restored backup.

## Safety

* Safe mode lets an agent edit files only in its own folder. **Full access lets it do anything your Linux user can do.** Use a dedicated low-privilege user.
* Apiary listens on your own computer only, unless you change that. Keep it off the open internet.
* The security audit was a self-check by the AI that helped write the code. It is **not** an independent penetration test.

## What Apiary does not do

* It is not a cloud service: there is no sync between machines other than export and import.
* It cannot see your real usage figure from Claude or Codex. It only knows what you set as limits, or the moment an AI refuses.
* It does not make an AI's answers correct. Reviewer agents and your approvals are the safety net.
