# First run and connections

Open Apiary at <http://127.0.0.1:7777>. On first run the [setup wizard](setup-wizard.md) guides you through everything below; this page is the manual version.

The sidebar on the left shows the three connections and whether each is ready (green) or not (red).

## 1. Connect your AI

Go to **Connections** in the sidebar. For each service you can choose **Terminal** or **Web**.

### Terminal (recommended)

Apiary runs the `claude` and `codex` commands for you, so it reuses the login you already have.

```bash
# Claude Code
npm install -g @anthropic-ai/claude-code
claude            # log in once, then exit

# Codex
npm install -g @openai/codex
codex login
```

Back in Apiary, press **Test connection**. It sends a tiny real request, so a green tick proves the login works.

### Web (API key)

Choose **Web · API key**, paste your key and press **Save**. Keys are stored only on your machine in a private file (`~/.apiary/state.json`, readable only by you) and are never shown again in the interface.

Web agents can chat and delegate, but **cannot edit files or run commands**. Use the terminal connection for coding work.

You can do the same from a terminal:

```bash
echo "$ANTHROPIC_API_KEY" | apiary connect claude --method api
```

## 2. Connect GitHub (optional)

See [Connect GitHub](../github/connect.md).

## 3. Start a project

Press **New project**, describe the goal and pick the lead agent's AI. See [Projects and chat](../using-apiary/projects.md).
