# Changelog

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
