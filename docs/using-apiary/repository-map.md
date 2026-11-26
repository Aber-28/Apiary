# GitHub repository map

A page that shows **where you are** in a repository, at a glance. Open **Connections, GitHub, GitHub repository map**.

## Pick a repository

The drop-down at the top has two groups:

* **On this computer:** repositories Apiary knows about. These are the ones agents read from (see [Repositories](repositories.md)) and the ones your projects work in.
* **On your GitHub account:** every repository your connected GitHub login can see, even if it is not on this computer. Connect GitHub first under Connections.

## For a repository on this computer

* **You are here:** the branch you are on, the main branch, whether anything is waiting to be saved, how many saves are waiting to be sent to GitHub or fetched from it, the latest save, and where the folder is.
* **Branches:** every branch with its latest save and a small bar showing how far it has moved from the main branch (grey is behind, coloured is ahead). Branches made by Apiary projects are labelled with the project's name, so you can tell agent work from your own.
* **Checkouts on this computer:** each agent works in its own copy, so your own files are never touched. They are listed here with the agent they belong to.
* **Map:** the first picture. The main branch is a line of its latest saves, labelled with version tags where there are some. A green **You are here** marker shows where your checkout is. Branches that have **not been merged into main yet** hang off the line on dashed curves, from the save they started at, with a note saying how many saves ahead they are and whether they exist only on this computer. Branches already merged are listed in one line underneath.
* **Detailed history** (collapsed): the full drawing for people who want every save.  a drawing of the latest saves, newest at the top, in coloured lanes. A line leaving a save sideways is a **branch splitting off** (an arrow shows where it goes). A line joining a **ringed** save is a **merge**, marked with a "merge" tag. Branch and tag names sit beside the save they point to. Up to 60 saves and 10 lanes are drawn.

## For a repository on GitHub

The same **Map** as above (without a "You are here" marker, because the repository is not on this computer), then the main branch, when it was last pushed, **open pull requests** (from and into which branch, who, and a link), all branches (protected ones are marked) and the latest saves.

## Good to know

* It is **read-only**. Nothing on this page changes a repository, a branch or GitHub.
* Passwords or tokens inside a repository's web address are hidden.
* The list of GitHub repositories shows up to 100, the most recently pushed first.
* Branch bars and "ahead/behind" are measured against the main branch. If a repository has no main branch yet, they are left out.
* The view reflects what is on this computer. Use **Update from GitHub** under Repositories to fetch the newest state first.
