# Projects and chat

A **project** is one conversation with a **lead agent**. Everything else (sub-agents, branches, logs) hangs off it.

## Create a project

Press **New project** (top of the sidebar).

1. **What should the team do?** Describe the goal in plain words.
2. **Project name** (optional). Defaults to your goal.
3. **Lead agent uses**: Claude or Codex, shown with how it is connected (Terminal or Web).
4. **Where does the work happen?**
   * **Empty workspace**: a fresh folder under `~/.apiary/workspaces/`.
   * **Local folder**: a folder or git repository on your machine.
   * **GitHub repository**: pick one of your repositories and a branch. Apiary clones it for you.
5. **Access**: **Safe** (edits files in its folder) or **Full access** (runs any command without asking).

## The workspace

* **Chat** (centre): talk to the selected agent. Press **Enter** to send, **Shift+Enter** for a new line.
* **Team** (right): the lead and its sub-agents with live status. Click any agent to read its conversation or message it directly.
* **Terminal** tab: the raw commands and output of the selected agent.
* Header buttons: **Stop**, **Take over**, **Open pull request** (repository projects) and **Delete**.

## What happens when you send a message

1. The lead works on it. Short replies stream into the chat as they are written.
2. If it decides to delegate, sub-agents appear in the team list and run **in parallel**.
3. Their reports come back to the lead, which writes the final answer for you.

You can message a sub-agent directly at any time. Stopping the lead stops its whole team.
