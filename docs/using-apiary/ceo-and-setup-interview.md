# Your CEO and the setup interview

At the end of the setup wizard Apiary creates your **CEO**, the agent you talk to in the main chat.

1. Name your CEO. A comic-book style name is suggested; type any name you like.
2. Answer a few questions. The AI asks them one at a time (infrastructure, network, goals, tools). Choose a suggestion or type your own answer. Never type passwords here.
3. Review the proposed team (usually 4 or 5 people). Each has a title, a reason, a name you can change, and an automatically written profile with guardrails. Untick anyone you do not want.
4. Apiary writes everything as Markdown files in `~/.apiary/agents/` and `~/.apiary/org/company.md`.

Skipped it? The Chat page shows **Set up my CEO** until you do it. Edit any profile later with **Edit profile** on the agent.

## Names

Every agent has a name (default: an original comic-book style codename) and a title (for example Network Engineer). Rename anyone in Edit profile or while approving a hire.

## Markdown files

Profiles are plain Markdown. The file is the source of truth: edit it in Apiary or in any editor and the agent uses the new text next turn.
