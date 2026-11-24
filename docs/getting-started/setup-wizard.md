# The setup wizard

The first time you open Apiary it walks you through setup. It takes about two minutes and you can skip it and come back any time under **Settings → Setup guide**.

## Step 1: Connect your AI

Apiary first **checks what you already have**. If Claude Code or Codex is installed or an API key is saved, it makes a tiny real test request to confirm you are actually signed in. Each service then shows one of:

* **Connected**: nothing to do.
* **Not connected**: with the reason and what to do next.

For anything not connected, choose how to connect it:

* **Terminal**: install the command if needed (`npm install -g @anthropic-ai/claude-code` or `@openai/codex`), sign in once in a terminal (`claude` / `codex login`), then press **I have signed in. Check again**.
* **Web · API key**: paste your key and press **Save and check**. Web agents can chat but cannot edit files.

You need at least one AI connected to continue.

## Step 2: Default models

For every connected AI, pick the model it should use by default:

* With an **API key**, the list comes straight from your account.
* With a **terminal login**, Apiary offers suggestions. Leave it on **Default (let it choose)** to use whatever the command is set to, or choose **Other…** and type any model name your plan allows.

If both AIs are connected, you also choose **which one leads new projects** by default. Individual projects and saved agents can still override the model.

## Step 3: GitHub (optional)

Connect through `gh auth login` or a personal access token, or skip it. See [Connect GitHub](../github/connect.md).

## Step 4: Run automatically?

Choose whether Apiary should **start by itself when you log in**:

* **Yes**: Apiary installs a systemd *user* service (no root needed). Tick **Switch to the background service now** to hand over right away; Apiary restarts and the page reloads on its own. Otherwise it starts at your next login.
* **No**: you start it yourself with `apiary`.

If this machine has no systemd user session (for example inside a container), Apiary says so and you can continue without it.

## Step 5: All set

A summary of what is connected, the default models, and whether Apiary starts automatically. Press **Open Apiary** to start your first project.

## Changing things later

| What | Where |
| --- | --- |
| Connections, keys, models | **Connections** (each service has its own page) |
| Run automatically at login | **Settings → Startup**, or `apiary service install` / `uninstall` |
| Default AI for new projects | **Setup guide** (step 2) |
| Run the wizard again | **Settings → Setup guide** |
