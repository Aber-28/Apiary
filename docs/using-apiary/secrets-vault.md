# Secrets vault

Passwords, tokens and keys are never stored in plain text.

- Create the vault under Settings → Secrets vault and choose a passphrase. It is never stored; if you forget it the secrets cannot be recovered.
- Add secrets: a name, an optional **username**, the secret itself (password, token or key) and a note. A token or key needs only the secret. A login needs both. You can add or change the username later. Values are encrypted with AES-256-GCM.
- **Choose who may use it.** Under *Who may use it*, pick an agent from the drop-down, choose *Ask me each time* or *Always allowed*, and press **Add**. Agents with access are listed below, where you can change the choice or press **Remove**. An agent that is not listed has no access.
- When an agent needs a secret you get an approval: **Allow once**, **Allow always** or **Deny**.
- The value is handed only to the command that runs, as an environment variable named `APIARY_SECRET_<NAME>` (and `APIARY_SECRET_<NAME>_USER` when you set a username), and is removed from messages, logs, memory and minutes.
- The vault locks when Apiary restarts. Unlock it with your passphrase; agents cannot use secrets while it is locked.

Do not paste secrets into chats: use the vault.

## What agents know about secrets

Each agent is told the **names** of the secrets assigned to it (never the values), so you can just say "use the router login". Your CEO and project leads also see which teammate holds which secret, and hand the job to that person, who asks for the secret themselves.

## How an agent can use a secret when the vault is locked and password protected

It cannot open the vault, and it never gets the passphrase. Only **you** unlock it, in the browser, and Apiary keeps the key in memory only while it runs (it locks again on every restart). When an agent needs a secret:

1. It asks by name. Apiary checks that the vault is unlocked and that the secret is assigned to that agent.
2. Unless you chose *Always allowed*, you approve each use.
3. Apiary hands the value to that one agent for that one task, as an environment variable for its shell commands. It is removed afterwards.
4. Agents never see the value in the conversation: it is hidden in what is shown and saved.

If the vault is locked, agents are told so and nothing is handed out. Apiary's own access token is never passed to agents.
