# Export and import (move to another computer)

Settings → **Export and import** moves everything from one Apiary to another.

## Export
Pick what to include and press **Download export**. You get one `.tar.gz` file with your projects, agents and chats, memory, tasks, tickets, repositories, settings, team meeting minutes, agent profiles and (if you choose) the project files.

- **The secrets vault** can be included. It stays encrypted. It cannot be opened without its passphrase.
- The file also holds your connection keys and tokens. Keep it private and delete it after the move.
- Folders **outside** Apiary's own folder (for example a repository you pointed an agent at) cannot travel in the file. Apiary lists them. Copy them yourself.
- `node_modules` folders are left out to keep the file small. Run your install command again on the new computer.

## Import
On the new computer, install Apiary, open **Export and import**, choose the file and press **Import**.

- If the file has a vault, you must type its **passphrase**. It is checked first. A wrong one changes nothing.
- The file is checked before anything is replaced (unsafe or unexpected content is refused).
- What was on the new computer is **not deleted**. It is moved to `~/.apiary/backup-before-import-<date>`.
- Paths are updated to the new location, then Apiary restarts and the page refreshes. Unlock the vault with the same passphrase.
- Agents that were working at the time of the export start as idle.

You can also use the API: `GET /api/export` and `POST /api/import` (see the API reference).
