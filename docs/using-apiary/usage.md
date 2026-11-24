# Usage

**Connections → Usage** shows how many tokens each agent has used over the last 14 days. A token is a small piece of text, roughly three-quarters of a word.

- A chart shows tokens per day, split by agent.
- A table lists each agent's input, output and share.
- Under **Limits** you can set a number per day or per week for each AI. Next to each connection in the sidebar a bar fills as you get close, and turns red when you pass it.

Apiary cannot see the real limit of your plan. The limits are numbers *you* choose to stay under. Apiary also notices when the AI itself says its limit has been reached, and shows "Limit reached" for a few hours.

Numbers come from the AI when it reports them. Otherwise Apiary estimates (about 4 characters per token) and marks them as estimated. Cached input is not counted.

## Real usage, taken from the AI itself
Under each AI in the sidebar (and on this page) you see small bars from 0% to 100% with the numbers **the provider itself reports**: for example the 5-hour session and the weekly limit, and when each resets. This matters when you use the same subscription somewhere else too, because Apiary can only count its own tokens.

- It refreshes **every hour** by itself. Press the **↻ button** next to the bars to refresh right away (at most once every 15 seconds).
- **Claude Code:** read with your Claude Code login, the same way Claude Code's own status line does. If the login has expired, run Claude Code once in the terminal.
- **Codex:** read with your Codex (ChatGPT) login. If that does not work, Apiary shows the last numbers Codex wrote into its own records and tells you how old they are.
- If you use a pay-per-use API key, there is no subscription limit to read. Then the numbers are only what Apiary counted, and it says so.
- The login is only used to ask the provider for these numbers. It is never stored, logged or sent anywhere else.

These provider calls are not officially documented, so they can change. If one stops working, Apiary falls back to its own count and shows why.
