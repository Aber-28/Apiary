# Task IDs and handovers

Every piece of work in Apiary has a task with its own **ID**, such as **T-0042**. IDs are unique and counted up: an ID is never reused, even if a task is deleted. Tasks from before this feature were numbered oldest first.

## How work becomes a task

- When you ask an agent for something in a chat, a task is opened for that agent and shows on the Tasks page (labelled *chat*).
- Tasks you create, tickets and the goal of a new project are tasks too.
- When the agent finishes, it closes its own task.

## Handing work over

If the agent that received a task is not the right one, it hands the work to the proper agent (or a sub-agent). Apiary then:

1. opens a **subtask** with its own ID, linked to the first task ("Subtask of T-0042"), assigned to the proper agent;
2. keeps the first task open, showing **Waiting for T-0043** until the subtask is closed;
3. lets the proper agent do the work and **close the subtask**, which records **"Closed by Router Rex. Refer to T-0042."**;
4. gives the result, with the subtask ID, back to the first agent, which continues, or finishes and closes its own task ("Closed by Captain Atlas. Refer to T-0043.").

If the proper agent cannot finish, the subtask is marked Blocked (it is not closed) and the first agent is told.

Every task that is closed, by an agent, by Apiary on an agent's behalf or by you, records who closed it and which task to refer to. It shows in green on the task card and in the task's history. Quick pre-checks that teammates give before a job starts are opinions, not tasks.

Task IDs are searchable in [global search](global-search.md), and opening, handing over and closing a task are recorded in the [Audit log](audit-log.md).
