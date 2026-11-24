# Project templates

A template saves a setup you repeat, so a new project starts with the same goal, plan and team already in place. Open **Workspace > Project templates**.

## Save one

Open a project that has a plan and a team and press **Save as template**. A template keeps:

- the goal,
- the plan phases and their steps (all unticked),
- the team roles: title, role, department and standing instructions.

It never keeps passwords or specific servers. Secrets are masked, and IP addresses, web links, `user@host` targets and the names and addresses of devices on your [map](infrastructure.md) are replaced with `<server>` or `<link>`. Apiary tells you how many details it removed. Project folders and repositories are not saved either. You can read and edit the goal and description on the Templates page.

## Start from one

Press **Start project** on a template, choose the name, the AI and (optionally) a folder. The new project gets the saved team and plan, and its lead is told to confirm anything specific, such as which servers apply, before starting on the first phase. The original project is not touched.

## API

`GET/POST /api/templates`, `PUT/DELETE /api/templates/{id}`, `POST /api/templates/{id}/start` (see the API reference).
