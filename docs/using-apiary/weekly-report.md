# Weekly report

**Workspace > Plan and reuse > Weekly report** gives you a plain-English summary of the week and how many tokens were used compared with last week. Switch on **Make a report every week**, choose the day and time (default Monday 08:00), and a new report is saved automatically. Past reports stay in the list. **Make one now** creates one on demand.

## What is in it

- **Progress:** projects that finished or started a phase, and how far along they are.
- **Tasks:** how many were finished, and which are stuck (blocked, or in progress with no change for a week).
- **Approvals** waiting for you, and how many you answered.
- **Health:** the current warnings. **Servers down:** devices on the map that are not answering.
- **Tokens used** this week by AI (for example Claude and Codex) and by agent, compared with last week, plus a chart of the last 8 weeks. A red triangle marks a week in which a usage limit was hit.
- **Next week:** the next steps of each project's current phase, or the open tasks on the board.

The report is built from Apiary's own records, so writing it uses no tokens. Token numbers are the ones the AI reports, or a rough estimate (about 4 characters per token) when it does not.

## Telegram

Tick **Also send a short version to Telegram** to get a one-paragraph digest with counts and token totals when a scheduled report is made. Task names and other titles are not sent. See [Telegram alerts](telegram-alerts.md).

## API

`GET/PUT /api/reports` (settings and list), `POST /api/reports/run`, `GET /api/reports/{id}` (see the API reference).
