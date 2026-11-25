# Changelog

## 0.33.0

- **Chat looks like a messaging app.** Your messages are on the right. Each agent is on the left in its own colour, with its name. A handoff reads as @Name: text (for example @Neo: do A, B, C). Task codes such as T-0012 are links that open the task.

## 0.32.2

- **Secrets vault is compact.** Each secret is a small box showing its name and who it is assigned to. Click the name to open its details, connection, who may use it and its actions in a window.

## 0.32.1

- **Fix:** All agents lists the whole team, including the CEO and its team members (it showed "No agents yet" when the team had no project lead).
- **Organisation cards** show only the name and the department (for example Security or Marketing).

## 0.32.0

Fixes from a review of the approval, trust, messaging and task code.

- **Command safety.** A background `&` splits commands. Leading `VAR=value` and wrappers (sudo, env, nohup, xargs and others) are judged by the command they run. Code passed to bash, python and eval is checked for destructive words. Scripts run by path and build or package tools are at least risk 2. `apiary-ssh` judges the command it runs on the other machine, and an unknown remote command is risk 3. Options that change things are no longer read-only (ip, git branch, journalctl, date, hostname, ss, curl and wget write options, sort -o).
- **Level 3 text.** The slider text now says what level 3 does: chains run; scripts, changes and destructive commands ask.
- **Approval token.** The approval bridge settings are in a private file, not on the command line, and are removed after the run.
- **Visible decisions.** Decisions made without asking (trust setting or rule) appear on the Approvals page and in the chat.
- **Rules on the Access page.** Rules that decide for an agent are listed under its slider, with a Remove button.
- **Hire names.** A hire with no name gets a codename. A name longer than 40 characters is shortened at a word boundary, and the person is told.
- **Peer messages.** The limit is per hour, not for the life of the project. A reply cannot start another reply, and the person is told when the limit is reached.
- **Trust input.** An empty, null or non-numeric level is rejected.
- **Task page.** Live updates no longer wipe the message box. Unknown statuses show a neutral label.
- **Tests.** The GitHub-tool check is skipped on machines that have the tool installed, so the tests after it run.

## 0.31.0

- **One slider for all agents.** The Access and safety page has an "All agents at once" slider above the list. Move it to set every agent to the same position, then move any single agent's slider to change just that one.

## 0.30.0

- **Agents talk freely in any direction.** A message to a teammate no longer holds the sender's chat until the teammate has finished. The message is delivered, and the reply comes back as a new message in the sender's own chat. Before, Bruce's chat sat at "waiting for Neo" until Neo's turn ended, and anything you sent to Bruce queued behind it. A child agent is no longer refused for asking its parent.

## 0.29.0

- **How much each agent may do without asking.** The Access and safety page has a slider under each agent. All the way left, every command asks you. All the way right, everything runs. The positions between allow more as you move right: read-only commands; simple commands; chains and scripts too; everything except deleting, rebooting and destroying. A Deny rule on Approval rules still wins, and an agent on Full access runs everything.

## 0.28.0

- **Open a task and carry on with it.** Task titles on the Tasks board are links. A task page shows its details, status, subtasks, history and the conversation with the agent doing it. You can send that agent the next instruction (it is linked to the task's code), ask it to carry on, or start work on the task.

## 0.27.1

- **Fix:** a hire that cannot go ahead is no longer dropped silently. The chat and the activity log now say why (for example, a role that already exists or the team size limit), and a hire waiting for your approval is announced in the chat.

## 0.27.0

- **Choose how much an agent may do without asking.** When an agent wants to run a shell command, the Approvals page now offers: Allow once, Always allow this exact command, Always allow any command that runs the same program, Always allow read-only commands, Allow everything for this agent (asks you to confirm), and Deny.
- **Approval rules cover commands.** Rules on the Approval rules page can cover one command, one program, read-only commands, or everything, and can be limited to one agent. The most careful matching rule wins, so a Deny rule beats an allow rule.
- **Safety list.** Commands that delete, reboot, change packages, services or containers, write data over the network, run other programs, or chain commands together are always asked about, unless you choose Allow everything for that agent.

## 0.26.0

- **Approve shell commands from the Approvals page.** In safe mode, when an agent wants to run a command that is not already allowed, Apiary now shows it on the Approvals page with the exact command, and waits for your Approve or Deny. Before, the command was refused and no request appeared. Denied or stopped requests are not run. Full-access agents are unchanged. Codex agents are not yet covered.
- **Replaces the 0.25.1 shortcut.** The blanket allow rule for `apiary-ssh` is gone, so every shell command in safe mode is decided by you.

## 0.25.1

- **Fix:** an agent in safe mode can now run the `apiary-ssh` helper after you approve its vault login. Before, the shell command was refused because nobody could answer its permission prompt, so the agent reported "needs approval". Only that one helper is pre-approved; other commands still need approval, and full-access agents are unchanged.

## 0.25.0

- **Connect GitHub without a terminal.** Connections → GitHub now has a **Sign in with GitHub** button: Apiary shows a one-time code, you type it on github.com, and the page updates by itself. Apiary never sees a password.
- **Install the GitHub tool from the page.** If it is missing, one button installs GitHub's official release into your home folder (no sudo).
- **Clear failure messages** (no internet, expired code, cancelled) with Try again, and a one-click link that opens GitHub's token form already filled in.

## 0.24.1

- **Fix:** standing team members now see the Infrastructure map (names, types, addresses, what runs on what, and vault secret names, never secret values). Before, only leads and the CEO did, so a job handed to a teammate could fail with "no address" even though the device was on the map.

## 0.24.0

- **Task IDs.** Every task gets a unique code (T-0001, T-0002, ...) that is never reused. Existing tasks were numbered. Work asked of an agent in a chat is now a task too.
- **Handovers open subtasks.** When an agent passes work to the proper agent, a linked subtask opens, the first task shows *Waiting for T-xxxx*, the proper agent closes the subtask, and the first agent continues with the result and closes its own task.
- **Closing is recorded.** Closed tasks say *Closed by Agent X. Refer to T-xxxx.* Opening, handing over and closing are in the Audit log.

## 0.23.2

- Fixed the Secrets vault showing `[object HTMLDivElement]` instead of the agent's name under "Who may use it". Each agent that has access is listed with its access level and a **Remove** button.

## 0.23.1

- **Setup wizard now requires a sign-in.** A new "Create your sign-in" step comes before Startup, and Skip, Open Apiary and the automatic restart all send you back to it until a username and password exist. Existing installs without a sign-in see a red reminder in the sidebar.

## 0.23.0

- **Menu reorganised** into a tree with folders inside headings (Workspace > Plan and reuse, Agents > Library and Knowledge, Connections > AI tools, Settings > Data and System). New **Security** heading for Sign-in, Secrets vault, Approval rules, Access and safety and Audit log. Counts show on closed headings and folders, and the breadcrumb follows the menu.

## 0.22.0

- **Runbook library** (Workspace > Runbooks): agents save the steps of problems they solved as drafts; you read, edit and approve them. Only approved runbooks are given to agents to follow. Passwords are masked, and an agent can never change an approved runbook.
- **Approval rules** (Settings > Approval rules): decide once to allow, always ask, or block a kind of request (secrets, sub-agents, hires, plans, merges), optionally for one project, one secret or requests that mention certain words. The most careful matching rule wins. Automatic decisions are recorded in the Approvals list and the Audit log.

## 0.21.0

- **Weekly report** (Workspace > Weekly report): a plain-English summary made once a week on the day and time you choose (progress, tasks, approvals, health, servers down, next week's plan) with tokens used this week by AI and by agent compared with last week, and a chart of the last 8 weeks that marks weeks a usage limit was hit. Optionally sends a short digest to Telegram.
- The search box no longer squeezes the breadcrumb in the top bar.

## 0.20.0

- **Project templates** (Workspace > Project templates): save a project's goal, plan phases and team roles, and start new projects from it. Passwords, secrets, folders and specific servers are never saved; they are stripped and you are told how many details were removed.
- **Global search**: a box in the top bar (Ctrl+K) that finds projects, team members, tasks, devices, templates, past chats and secret names. Secret values are never searched.

## 0.19.0

- **Telegram alerts** (Settings > Telegram alerts): urgent alerts to your own Telegram bot when an approval is waiting, a health warning appears or a long task finishes. The bot token is stored in the vault. Only the chat you link (with a one-time code) is answered. Alerts only: command output, file contents and secrets are never sent. `/status` in the linked chat gives a one-line summary.

## 0.18.0

- **Health page** (Infrastructure > Health): warns about a nearly full disk, a device on the map that stopped answering, an expired Claude/Codex/GitHub login, a locked vault, and failed or stopped backups. Each warning says what is wrong and what to do. It checks every 5 minutes and tests the devices, so the map turns red by itself. The menu shows a warning count.

## 0.17.0

- **Audit log** (Settings > Audit log): a searchable record of commands agents ran (including over SSH), files they changed, git commits, which secrets were used (names only), approvals, sign-ins and failed sign-ins, vault unlocks, device changes and backups. Filter by type, person and time. Entries are kept 30 days and then deleted automatically. Values and command output are never recorded.

## 0.16.0

* **Automatic backups** (Settings > Backups). Choose daily or weekly and a time, and Apiary makes the same export you can make by hand, saves it in a folder, and keeps the newest few (7 by default). Each file is opened and checked right after it is written, so a broken backup is reported at once. Choose whether to include the Secrets vault (it stays encrypted) and project folders. A second folder, such as a network share, gets a copy, because a backup on the same disk does not survive the disk. There is **Back up now**, and each backup can be downloaded. Restore one with Export and import.
* **Machine usage in the top bar.** A very small strip shows CPU, memory and disk of the computer Apiary runs on, refreshed every 5 seconds from Linux. It turns amber when high and red when nearly full; hover for details.

## 0.15.1

* **Factory reset** (Settings > Factory reset). Deletes everything Apiary holds (projects, chats, tasks, agents, the CEO and team, memory, the infrastructure map, the vault and its auto-unlock key, connections and settings) and restarts into the setup wizard. It takes three checks: type YES, type YES again, then answer a simple sum. A wrong answer cancels everything, and the checks are enforced by the server, not just the page. Your access link and sign-in account are kept (tick a box to remove the account too), and folders on your computer that a project only pointed at are never touched.
* **Live activity.** A new page, and a **Working now** box in the sidebar, show every agent that is working right now: your CEO, specialists and project helpers, with what they are doing and their latest output. Open their chat or stop them from there. Tasks show a live line with a **Watch** button while their agent (or one of that agent's specialists) is working.
* **Smaller text** throughout.

## 0.15.0

* **Infrastructure.** A new **Infrastructure** menu with two pages. **Devices** lists everything you run or connect to (Proxmox, Raspberry Pi, VMs, containers, NAS, routers, websites, services). Each has **Test connection** (a quick check that the address or website answers), **Update** and **Remove**, and **Add new** creates one. **Map** draws it as a diagram: boxes inside a box run on it, arrows are connections, and the outline shows the last test. The map redraws as things change.
* **Help me map it.** The CEO asks short questions, guesses what it can, and proposes each device, link or question as an **Is this right?** card. Nothing is added until you press *Yes, add it* (or *Edit first* or *No*).
* An item names the vault login that gives access to it. Passwords are never stored in the map. The map is part of exports and imports.

## 0.14.0

* **Vault auto-unlock.** On the Secrets page, turn on **Auto-unlock** (it asks for your passphrase once). After a restart or an update the vault then opens by itself, so agents can use their secrets straight away. The key is a private file (only your user can read it) kept in `~/.config/apiary/`, outside the Apiary folder, so exports and backups never contain it. Your passphrase still works as a backup, and you can turn auto-unlock off at any time, which deletes the key file.
* Importing an export, or copying the folder to another computer, keeps the vault locked until you enter the passphrase there.

## 0.13.0

* **The CEO leads everything.** A new project is led by your CEO, who hands work to the specialists he created. There is no hidden "project lead" agent any more. The agent shown as **Responsible** is the one acting in the project chat, and you can change it per project. Projects you already have keep whoever is responsible today.
* Secrets given to the CEO work in his projects without asking again, and specialists doing project work get access to the project folder.
* **Sign-in with a username and password**, so you can use Apiary from any laptop. Create it under **Settings > Sign-in**, with `apiary user set <name>`, or when the installer asks. The password is stored only as a salted scrypt hash, sessions last 14 days, wrong guesses are slowed down, and changing the password signs every other device out. The access link keeps working as a backup.
* New command: `apiary user [set <name>|remove]`. It is also the way back in if you forget the password.

## 0.12.1

* An agent that asks for a secret that is not assigned to it no longer just gets refused. You get an approval card saying the secret is **not assigned** to that agent: *Allow once*, *Always allow* (which also assigns it), or *Deny*. This fixes the case where you gave a secret to the CEO but the project's lead agent was the one doing the work.

## 0.12.0

* **Kinds of secret.** Add an **SSH login** (server, port, username, password or private key), a **Login** (username and password) or an **API key or long-lived token**. Agents you give access to can use all of them.
* **`apiary-ssh`.** Agents log in to servers with `apiary-ssh "Name" -- command`. Apiary handles the password or key itself, so the agent never sees it: passwords go through ssh's own prompt mechanism and keys through a short-lived ssh-agent, never a file. Server fingerprints are remembered in Apiary's own `known_hosts`.
* Private keys can be chosen from a file, so they are never displayed. Existing secrets keep working: one with a username becomes a Login, one without becomes an API key or token.

## 0.11.4

* **Responsible agent for projects.** Every project shows who is responsible (the CEO by default) in its header and on its card, and you can change it. The responsible agent and the project lead can now message each other, which teams could not do before.
* Tasks show **Responsible** on the card, with a drop-down to change it right there.
* Agents no longer receive Apiary's own access token in their environment.
* Codex agents now receive an approved secret. Codex hides variables with KEY, SECRET or TOKEN in the name unless told otherwise.

## 0.11.3

* **Fixed: giving an agent access to a secret never worked from the screen.** The page and the server disagreed about the format, so agents always showed as "No access" and nothing was saved. Fixed, and the server now accepts both formats.
* Agents are now told the names of the secrets assigned to them (never the values). The CEO and project leads also see who holds which, so "use the router login" is enough.
* **Every task has an agent.** New tasks go to the CEO by default; pick anyone in "Who does it", and change it later. A new **Start** button sends the task to its agent.

## 0.11.2

* Security: *Replace secret* no longer uses the browser's plain prompt, which showed the new secret as you typed it. It now opens a dialog with a hidden field (with an optional "Show what I type" tick). The typed value is cleared from the page as soon as it is saved or cancelled.

## 0.11.1

* Secrets: *Who may use it* is now a drop-down. Choose an agent, choose *Ask me each time* or *Always allowed*, press **Add**. Agents with access are listed with a **Remove** button, instead of one long list of "No access" boxes.
* Agent names in that list show the person's name with the job in brackets, and no longer read "CEO (CEO)".

## 0.11.0

* **Call an agent with @.** Type @ in any chat to pick a teammate, the CEO or a project lead. They receive your message in their own chat, and their answer is shown in the chat you are in. See "Call an agent with @" in the docs.

## 0.10.4

* Fixed the dashboard asking you to set up your CEO after you already had. The page never picked up that the CEO existed, so the banner always showed and the Organisation tab stayed hidden.

## 0.10.3

* Fixed the installer saying Apiary was not running when it was (it could not tell, because a network-enabled Apiary asks for the access token first).

## 0.10.2

* The installer now offers to install git, curl and Node.js 20+ itself on Debian/Ubuntu (it asks first). Set `APIARY_YES=1` to skip the question.

## 0.10.1

Security hardening after a full review.

* Every page and answer now carries strict browser security headers (a Content Security Policy that blocks outside scripts, no framing, no content sniffing, no referrer). The small theme script moved into its own file so scripts can be locked down.
* The access token is compared in constant time, and after you open the access link it is moved into a cookie (30 days) and removed from the address bar.
* Your GitHub token is now only ever sent to github.com. Before, it could be sent to any address that merely contained "github.com".
* Branch names are checked before they reach git.
* Importing a file now refuses archives that hide links to write outside the data folder, and re-locks the permissions of the secret files.
* Opened over plain http from another device, the top bar now says "Not encrypted".

## 0.10.0
- **Install the AI from inside Apiary**: if no Claude Code or Codex is found, the first screen offers *Install Claude Code*, *Install Codex* or *Install both*. A progress bar, step list and live log show what is happening, and plain-language errors with *Try again* if it fails. Installed for your user only, no sudo
- Apiary also finds tools in `~/.local/bin` when started as a service

## 0.9.1
- **Installer now starts Apiary**: it sets up the service (or runs it in the background), waits until it answers, and prints the link. It asks whether you will open it from another device and prints your private access link for that. Clear errors if the port is taken

## 0.9.0
- **Real usage from the AI itself**: the usage bars show what Claude and Codex report (5-hour session, weekly, reset times) instead of Apiary's own count, so use from other tools is included. Refreshes every hour, or press ↻. Falls back to Apiary's count and says why when the provider cannot be read
- **Update checks are your choice**: daily, weekly, monthly, or only when you press the button

## 0.8.2
- Updates now run `systemctl --user restart apiary` for you (the same command you would type), and only exit with an error code if that command fails

## 0.8.1
- Fixed: the service restart after an update no longer depends on `systemctl` working from inside the service

## 0.8.0
- **Export and import**: move everything to another computer in one file (vault optional, stays encrypted and needs its passphrase on import; the old data is kept in a backup folder)
- **Project stages**: Building, Maintenance and Closed. Finished plans move to Maintenance by themselves. Closing keeps everything
- **CEO interview**: pick several answers and add your own words
- Fixed: Organisation no longer stays on "Opening chat…"
- Fixed: time fields are dark in the dark theme
- The usage bar (0% to 100%) always shows under each AI in the sidebar

## 0.7.0
- Fixed: after an in-app update the service now restarts by itself (it used to stay stopped until restarted by hand)
- **Update progress screen**: progress bar, steps, live log and timer while updating, automatic rollback if it fails, page refreshes when done
- **Secrets**: optional username next to the password, token or key (`APIARY_SECRET_<NAME>_USER`)
- **Model per agent**: dropdown on each agent, filled in for its provider (Claude, Codex…), with "Other…"
- **Project plans**: big projects get a phased plan you approve; progress bars and a Plan tab show where it stands
- Back burner is the first Tasks column

## 0.6.0
- **Tasks** board: To do, Back burner, In progress, Blocked, Done. You add to-do items and back-burner ideas; agents add and move tasks as they work, and team jobs and tickets show up automatically
- **Usage**: tokens per agent per day as a chart, a table per agent, optional limits per AI, and a usage bar next to each connection in the sidebar. Apiary also notices when an AI says its limit is reached
- **Model advice**: hires and profiles suggest the model that fits the role and how hard the work is (most capable, balanced, or fast and cheap); you can pick another when approving
- **Repositories**: point agents at a repository (paste a URL, owner/name or a folder) to read information from; choose who may read it; read-only
- **Support tickets**: describe a problem; an agent works on it and answers, asks you when it needs to, and you close it when it is fixed
- **Plain, simple English** by default for every agent (can be turned off under Appearance)
- Only one sidebar submenu stays open at a time; a Documentation link opens the docs in a new tab
- **License** changed to a use-only license; the code can only be changed by the owner

## 0.5.0
- **Setup wizard creates your CEO**: after connecting your AI, an interview (asked one question at a time by the AI) learns your infrastructure, network and goals, then proposes 4 to 5 team members with a reason, profile and guardrails each, all written for you and saved as Markdown files
- **Comic-book names** for every agent (original codenames), editable at any time; hire approvals let you rename before approving
- **Team meetings**: choose daily or weekly; agents report what they did and react to each other; minutes saved as Markdown and added to memory; "Hold a meeting now"
- **Encrypted secrets vault** (AES-256-GCM, passphrase never stored): assign secrets to agents, approve each use once or always; secrets are injected only into the running command and redacted from messages, logs, memory and minutes
- **Approvals archive**: decisions older than 24 hours move to Archived decisions
- **Updates**: Apiary checks GitHub, downloads without installing, shows Install; installing restarts the service and refreshes the browser
- Profile editor, Organisation and Team meetings pages

## 0.4.0
- **Main chat**: Apiary opens on a general chat; projects are separate spaces, each with its own team, organisation chart and **Files** tab for documents and data (browse, edit, create, download)
- **Memory for every agent**: tonight, yesterday, this week, this month, this year and older history is recalled automatically, with notes (`apiary-remember`), monthly summaries instead of forgetting, a Memory page and an on/off switch
- **Teams**: the lead assigns each job to the right member (`apiary-assign`); the member first checks with the others (GO / CONDITIONS / BLOCK), prerequisites are done before the job starts, and git work is merged with your approval; presets and a team editor
- **Hiring**: leads suggest hires with a reason and an automatically written profile and guardrails; you approve; an **Organisation** chart shows the CEO, departments and who reports to whom

## 0.3.0
- First-run setup wizard: detects existing logins (with a real test), guides sign-in per AI (terminal or API key), lets you choose the default model per AI and the default AI, optional GitHub, and asks whether to start automatically
- Auto-start at login: systemd user service from the wizard, Settings → Startup, or `apiary service install`
- New default models are used by new projects and sub-agents; Settings → Setup guide re-runs the wizard

## 0.2.1
- `apiary start --lan` and `apiary token`: reach Apiary from other devices (VMs, servers) with an automatic access token; IP addresses accepted when a token is set; friendly page when the token is missing

## 0.2.0
- Approvals: approve, deny or partially approve new sub-agents; review the diff before a sub-agent's work is merged; inbox, badge and notifications
- Review changes screen for any git agent
- Agents can message each other and hand work across the team (`apiary-send`), with deadlock protection and a message limit
- Settings: default for approvals, limit for agent-to-agent messages

## 0.1.0
- First release: chat-first projects with lead and sub-agents (Claude Code and Codex)
- Web interface with dark/light mode and sidebar sub-menus
- Terminal (CLI) and web (API key / token) connections
- GitHub: clone, branch and checkout per agent, auto-commit, merge, pull requests
- Take over in your own terminal; `apiary` command; documentation in `docs/`
