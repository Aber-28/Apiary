# Audit log

The audit log is a searchable record of who did what in Apiary. Open it from **Settings > Audit log**.

## What is recorded

| Type | Examples |
| --- | --- |
| Command | A command an agent ran in a terminal |
| SSH | A command an agent ran on a server through `apiary-ssh` |
| File change | An agent edited or wrote a file (the file name, not the contents) |
| Tool | Any other tool an agent used, such as reading a file or searching |
| Commit | An agent saved its work to a git branch |
| Secret used | Which secret an agent used, **by name only**. The value is never written. |
| Approval | A request that was made, and whether you approved or denied it |
| Sign-in | Sign-ins, failed sign-ins and sign-outs, with the address they came from |
| Vault | Unlocking or locking the vault, turning auto-unlock on or off |
| Device | Devices added, removed or tested on the Infrastructure page |
| Backup | Backups made or failed, by hand or on schedule |

Command output and file contents are never recorded, and anything that matches a known secret value is masked before it is written.

## Searching

Type words in the search box: every word must appear somewhere in the entry (who, project, what or details), in any order. Combine this with the **What happened**, **Who** and **When** filters. The newest entries come first; press **Show more** to go further back.

## How long it is kept

Entries older than **30 days** are deleted automatically. The log is a private file, `audit.jsonl`, in the Apiary data folder (permissions 0600). A factory reset deletes it; backups and exports do not include it.

## API

`GET /api/audit?q=&kind=&actor=&project=&from=&to=&limit=` (see the API reference).
