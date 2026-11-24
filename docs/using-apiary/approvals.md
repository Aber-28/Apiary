# Approvals and review

Apiary is built so that **agents propose and you decide**. By default, every new project asks for your approval before two things happen:

| Request | When it appears | What you can do |
| --- | --- | --- |
| **Create sub-agents** | An agent wants to hand work to new agents | See each agent's name, role, AI and complete task. Tick the ones you want, add a note, **Approve** or **Deny** |
| **Merge changes** (git projects) | A sub-agent finished and its branch would be merged into its parent's | Read the file summary and the full changes, then **Approve merge** or **Deny** |

A third checkpoint is always yours: **nothing is pushed to GitHub until you press Open pull request**, and you can **Review changes** first.

## Where requests show up

* **In the chat** of the project, as a highlighted card above the message box.
* **Workspace → Approvals**, which lists everything waiting for you (with a badge on the sidebar and in the browser tab title) and your earlier decisions.
* If the browser tab is in the background, Apiary also shows a desktop notification when your browser allows it.

While a request is open, the agent shows **Waiting for you**. Nothing runs until you answer.

## What happens when you answer

* **Approve** – the agent carries on. A note you add is passed to the agent.
* **Approve only some** – untick sub-agents you do not want. The lead is told only some were created.
* **Deny** – the agent is told you declined (with your note) and continues without it. For a merge, the branch is **kept**, so nothing is lost and you can merge it yourself later.
* **Stop** – stopping an agent cancels its open requests.

If Apiary restarts while a request is open, the request expires and the agent is idle; just message it again.

## Review changes

Git projects have a **Review changes** button in the project header. It shows what the selected agent's branch adds compared with its parent (or the base branch for the lead), as a file summary and a coloured patch. Changes are committed automatically after each turn, so you see the finished work, not half-written files.

## Turning approvals on or off

* **Per project:** the checkbox *Ask me before agents create sub-agents or merge changes* in the **New project** dialog.
* **Default for new projects:** **Agents → Delegation rules**.

{% hint style="warning" %}
With approvals off, agents create sub-agents and merge their work without asking. Use that only for work you trust, and keep **Safe** access.
{% endhint %}

## What approvals do not cover

Approvals gate Apiary's own decisions (new agents, merges, pull requests). They do not intercept every individual command inside a Claude or Codex session. Use **Safe** access (the default) to limit what an agent can do on its own, and review the result before opening a pull request.
