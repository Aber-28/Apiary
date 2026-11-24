# Teams, hiring and the organisation chart

A project can work like a small company: a **CEO** (the lead) who hands each job to the right specialist, specialists who check with each other before acting, and an **organisation chart** that shows who is on the team.

## Starting with a team

Choose a team when you create a project (**Start with a team?**), or create your own under **Agents → Teams**. The built-in **Operations team** has a CEO and Networking, Security and Research specialists. These members stay on the project, keep their own memory and work on their own git branch.

## How a job flows

1. You give the CEO a task. It decides who is best placed and **assigns** it to that member.
2. **Before anything is done**, the assigned member checks with the other members. Each replies with a verdict: `GO`, `CONDITIONS` (with prerequisites) or `BLOCK`.
3. If someone **blocks** it, nothing starts. The CEO is told why and decides what to do or asks you.
4. If someone sets **conditions**, that person does their prerequisite **first** (for example Security reviews the firewall rules before Networking changes them). In a git project their work is merged into the lead's branch, asking you first, and the assigned member's checkout is brought up to date.
5. Only then does the assigned member do the job, with the verdicts and the finished prerequisites in front of it. Its work is merged the same way, and the CEO summarises the result for you.

A pre-check with no clear verdict is reported as **unclear**, never treated as a quiet yes. A failed prerequisite stops the job. All of this counts against the [agent-to-agent message limit](rules.md).

## Hiring

When a project needs a specialist the team lacks, the lead **suggests a hire**. You see a card with, for each person:

* the name, department and who they report to;
* **why** the lead wants them;
* their **profile and guardrails**, written for you automatically.

Tick the ones you want and choose **Approve hiring** (or Deny). You never have to write instructions: Apiary builds each profile from the department (Engineering, Marketing, Design, Security, Networking, Research, Data, Product, Operations, Finance, Legal) plus guardrails every agent gets, such as: stay in your role, no destructive or irreversible actions unless asked, never expose secrets, ask before risky steps, and report briefly.

With approvals switched off for the project, hires happen straight away. Hired people are permanent members: they appear in the chart, can be given work by the lead, and take part in pre-checks.

## The organisation chart

Open a project's **Organisation** tab: the CEO is on top, with departments underneath (engineers, marketing, security and so on) and each person shown beneath whoever they report to. Click anyone to talk to them directly. Pending hiring suggestions appear above the chart, and if nobody has been hired yet you can ask the lead for a hiring plan with one click.

One-off helpers created with `apiary-spawn` are temporary and are not shown in the chart.
