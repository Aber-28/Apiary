# Repositories

Point agents at a repository to read information from, such as notes, code or documents.

1. Open **Agents → Repositories**.
2. Paste the repository's web address (for example `https://github.com/owner/name`, even a page like `.../tree/dev`), `owner/name`, a `git@` address, or a folder on this computer. A branch in the address is picked up automatically. Add a name, a branch, and what agents should use it for.
3. Choose who may read it: everyone, or only certain agents.

GitHub repositories are copied into `~/.apiary/repos`; use **Update from GitHub** to refresh them. Folders are used where they are. Agents only **read** from a repository and never change it. Private repositories need GitHub connected under Connections. Never put a password in an address.
