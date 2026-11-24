# Memory

Every agent remembers. Before each turn Apiary adds a short **MEMORY** section to the agent's instructions, built from:

* **Notes**: things you or an agent asked to always remember;
* **Tonight / earlier today**, **yesterday**, **earlier this week**, **earlier this month** and **further back** (up to a year and more): what the agent did and was asked, newest first;
* **Related history**: anything older that matches what you are asking now, found by keyword.

This applies to **every** agent: the main chat, project leads, team members and helpers. Specialists keep their own history across projects (the Networking specialist remembers its past jobs in a new project), and a project's notes are shared by everyone working on it.

## How it is recorded

After an agent finishes a task, Apiary stores a short record: who asked, what, and the answer. Agents can also save a lasting fact themselves with a block in their reply:

````
```apiary-remember
{"text":"The VPN port is 51820","scope":"project"}
```
````

`scope` is `agent` (only that agent), `project` (the whole team on this project) or `global` (everyone, in every project).

## Nothing is forgotten

Records older than 90 days are folded into one **summary per agent and month**, so the file stays small while a year-old conversation can still be found. Nothing is deleted unless you choose **Forget** on it.

## Managing it

Open **Agents → Memory** to search, filter by agent, add a note for every agent, forget items, or turn memory off. Memory is stored on your machine in `~/.apiary/memory.json` (readable only by you). Nothing is sent anywhere except as part of what an agent is already told, and memory is background context: your current message and the agent's standing instructions come first.
