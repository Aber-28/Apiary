# Secrets vault

Passwords, tokens and keys are never stored in plain text.

- Create the vault under Settings → Secrets vault and choose a passphrase. It is never stored; if you forget it the secrets cannot be recovered.
- Add secrets: a name, an optional **username**, the secret itself (password, token or key) and a note. A token or key needs only the secret. A login needs both. You can add or change the username later. Values are encrypted with AES-256-GCM.
- **Assign** each secret to agents: *No access*, *Ask me each time* or *Always allowed*.
- When an agent needs a secret you get an approval: **Allow once**, **Allow always** or **Deny**.
- The value is handed only to the command that runs, as an environment variable named `APIARY_SECRET_<NAME>` (and `APIARY_SECRET_<NAME>_USER` when you set a username), and is removed from messages, logs, memory and minutes.
- The vault locks when Apiary restarts. Unlock it with your passphrase; agents cannot use secrets while it is locked.

Do not paste secrets into chats: use the vault.
