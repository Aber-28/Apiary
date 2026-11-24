# Automatic backups

**Settings > Backups** makes a copy of everything on a schedule, so you do not rely on remembering to export.

## How it works

* Pick **daily** or **weekly** and a time. Apiary makes the same export you can make by hand under *Export and import*, saves it as `apiary-backup-<date>-<time>.tgz` (private to your user), and keeps the newest few (you choose how many, 7 by default). Older ones are deleted.
* **Every backup is checked.** Right after saving, Apiary opens the file and reads its contents. If it cannot be read, the page shows *Last backup failed* and why.
* **The vault** can be included. It stays encrypted, and restoring it needs your passphrase. Without the passphrase, the vault in a backup is useless.
* **Project folders and repositories** can be included (bigger backups) or left out.
* **Two places.** The backup goes to the folder you choose (by default `~/.apiary/backups`). Add a second folder, such as a mounted network share, and each backup is copied there too. A backup on the same disk does not survive that disk failing. If the copy fails, the page says so, and the main backup still counts.
* **Back up now** makes one immediately. Each saved backup can be downloaded.
* If Apiary was off at the scheduled time, it backs up when it starts again.

## Restore

Download the backup (or find the file in the folder) and use **Settings > Export and import > Import**. Importing makes a safety copy of what was there first. See [Export and import](export-import.md).

## Notes

* A [factory reset](factory-reset.md) does not delete your backups.
* The backups folder is not itself included in a backup.
