# Health

**Infrastructure > Health** warns you before things break, and says what to do about each warning. A number on the menu item shows how many warnings there are (red when something needs attention).

Apiary checks every 5 minutes and when you press **Check now**. The check also tests every device on your [map](infrastructure.md), so a device that stops answering turns red on its own.

## What is checked

| Check | Warns when | What it tells you to do |
| --- | --- | --- |
| Disk | Less than 15% or 5 GB is free (needs attention below 5% or 1 GB) | Free space: old backups, finished projects, downloads |
| Devices | A device on the map did not answer the last test | Check power and network, then press Test |
| Logins | A task failed with a sign-in problem (Claude or Codex), or the saved GitHub login stopped working | Sign in again, then press Test connection |
| Secrets vault | The vault is locked, or auto-unlock is not working | Unlock it, or turn auto-unlock on |
| Backups | The last backup failed, backups stopped, the second copy failed, or backups are off | Fix the problem and press Back up now |

A login warning clears by itself after the next task that works.

## API

`GET /api/health` shows the last result and `POST /api/health/check` runs a check now (see the API reference).
