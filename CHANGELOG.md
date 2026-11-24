# Changelog

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
