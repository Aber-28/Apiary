# Factory reset

**Settings > Factory reset** deletes everything Apiary holds and starts again from the setup wizard, as on a brand-new install.

## What is deleted

Every project, chat, task and agent, your CEO and team, memory, meetings, the infrastructure map, the Secrets vault and its auto-unlock key, saved connections (including the GitHub token), settings, and the project folders and repository copies that Apiary itself created.

## What is kept

* Apiary itself (the program) and your access link.
* Your sign-in account, unless you tick **Also remove my sign-in account**.
* Claude Code and Codex sign-ins (those belong to the tools).
* Any folder on your computer that a project was only pointed at. Those are your own files and are never touched.

## Three checks

1. Type **YES** (capital letters).
2. Type **YES** again.
3. Answer a simple sum.

A wrong answer at any step cancels everything and nothing is deleted. The server enforces this, so it cannot be skipped. A started reset also expires after five minutes.

When you answer the sum correctly, Apiary deletes the data, restarts and opens the setup wizard. There is no undo. Use [Export and import](export-import.md) first if you want a copy (include the vault to keep your secrets).
