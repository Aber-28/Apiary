# Security checklist and self-check

A short list to run through after installing Apiary, plus a script that checks most of it for you.

## Run the self-check

```bash
bash ~/.local/share/apiary/scripts/security-check.sh
```

It prints one plain report. It starts a separate throw-away copy of Apiary (port 7899, temporary folder, no real AI), plants a fake secret in it and checks that the secret never appears in the files, the log, the export or any page. It also looks at your real install: who can reach it and who can read its files. It changes nothing, asks for no passwords, and the report holds no secrets, addresses or host names, so it is safe to share.

## The checklist

1. **Only this computer can open it.** Unless you chose `--lan`, Apiary listens on `127.0.0.1` only.
2. **If you chose `--lan`, protect the route.** Plain http is readable on the network. Use a VPN, an SSH tunnel or an https reverse proxy. Never put Apiary directly on the internet.
3. **Turn on sign-in** (Security → Sign-in) so you do not rely on the long access link.
4. **Keep the data folder private.** `~/.apiary` should be mode 700 and the files inside 600. The self-check tests this.
5. **Use the vault for logins.** Passwords and keys go in Secrets, never in chat. Values are redacted from chat, logs, memory and exports.
6. **Leave approvals on.** Agents ask before creating sub-agents, merging, or running commands that change things. Review the plan before you approve it.
7. **Prefer Safe access** for new projects. Choose Full access only per project, on purpose.
8. **Back up** (Settings → Backups) and keep one copy off the machine.
9. **Stay current.** The Updates page shows new versions; read the changelog before you update.
10. **Use a throw-away machine to try risky things.** A virtual machine you can delete is the best place to let an agent loose.

## Reporting a problem

Use GitHub's private reporting: *Security → Report a vulnerability* on the repository. See `SECURITY.md`.
