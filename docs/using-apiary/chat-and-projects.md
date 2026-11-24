# The main chat and projects

Apiary opens on **Chat**: a general assistant for questions, thinking out loud and quick tasks. It is not part of any project, it never needs a folder, and it remembers your earlier conversations (see [Memory](memory.md)).

When something becomes real work with its own goals and files, such as a website, an app or a report series, start a **project** (the **New project** button). Each project is a separate space with:

* its own **lead**, and optionally a ready-made [team](teams-and-hiring.md);
* its own **Organisation** chart of the people on it;
* its own **Files** tab for documents and data;
* its own chat, terminal and, for repositories, branches and pull requests.

Nothing from one project leaks into another: the chat, team and files belong to the project, and project notes in memory are shared only inside it.

## Files: documents and data

Open a project and choose the **Files** tab. A project that Apiary created for you starts with `documents` and `data` folders. You can:

* browse folders and open text files;
* edit and save a file, create a **New document**, delete a file, or download any file;

Agents work in the same folder, so what you save is immediately visible to them, and what they write appears here. For a git repository project this is the lead's checkout, and agents commit their work on their own branches as usual.

Files up to 2 MB can be saved from the browser. The `.git` folder is managed by Apiary and cannot be opened, and nothing outside the project folder can be reached (links that point outside are refused).

## Who is responsible

Every project shows a **Responsible** agent, in the project's header and on its card in the Projects list. It starts as your CEO. Change it from the drop-down to any teammate or another project's lead.

The project's own lead agent still does the work. The responsible agent is the one who answers for it: it can give the lead work or ask how it is going, and the lead can report back to it. Tasks work the same way, with **Responsible** on every card (see [Tasks](tasks.md)).
