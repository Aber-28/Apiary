# GitHub repository map

A page that shows **where you are** in a repository, at a glance. Open **Connections, GitHub, GitHub repository map**.

## Pick a repository

The drop-down at the top has two groups:

* **On this computer:** repositories Apiary knows about. These are the ones agents read from (see [Repositories](repositories.md)) and the ones your projects work in.
* **On your GitHub account:** every repository your connected GitHub login can see, even if it is not on this computer. Connect GitHub first under Connections.

## For a repository on this computer

* **You are here:** the branch you are on, the main branch, whether anything is waiting to be saved, how many saves are waiting to be sent to GitHub or fetched from it, the latest save, and where the folder is.
* **Checkouts on this computer:** each agent works in its own copy, so your own files are never touched. They are listed here with the agent they belong to.
* **Map:** the first picture. The main branch is a line of its latest saves, labelled with version tags where there are some. A green **You are here** marker shows where your checkout is. Branches that have **not been merged into main yet** hang off the line on dashed curves, from the save they started at, with a note saying how many saves ahead they are and whether they exist only on this computer. Branches already merged are listed in one line underneath.
* **Detailed history** (collapsed): the full drawing for people who want every save.  a drawing of the latest saves, newest at the top, in coloured lanes. A line leaving a save sideways is a **branch splitting off** (an arrow shows where it goes). A line joining a **ringed** save is a **merge**, marked with a "merge" tag. Branch and tag names sit beside the save they point to. Up to 60 saves and 10 lanes are drawn.

## Git actions

For a repository on this computer you can run Git from the page, and watch every line of output as it happens in a panel under the title.

**Where the buttons are:** only on the circles. The circle marked **You are here** carries the actions for your working copy: Status, Fetch, Pull, Push, Save changes (asks for a short message), Set changes aside, Bring them back, and Tag. If the branch you are on is not drawn on the map, an **Actions for where you are** button appears above it.

**Click the map:** each circle on the map is a button, and a small menu opens right under the circle you click, with options that match what makes sense for that circle right now. For a **version** on the main line: look at it, start a branch from it, tag it, see what changed in it, or merge it into the branch you are on (the latest one offers **Pull** only if GitHub has news and **Push** only if you have saves to send). For a **branch**: go to it, merge it, branch from it, push or pull it when you are on it, or delete it when it is already merged. While you have unsaved changes, switching and merging are not offered, and the page says why.

Under each circle only the version number is shown. **Hover** over a circle (without clicking) to see the full note, when it was saved and its save id.

The older description follows. Click a branch to **go to it**, **merge it into** the branch you are on, or **start a new branch from it**. Click the main line for the same options, plus Pull and Push when you are on it. Branches already merged show as small chips under the map; click one to **delete** it.

**Safety:**
* Push, Merge, Save changes, Bring back and Delete ask you to confirm first.
* **Pull** only does a simple catch-up. If the branches have drifted apart, nothing is changed and Apiary tells you.
* If a merge hits a clash, Apiary **undoes the merge** straight away and tells you, so nothing is left half-done.
* Delete only removes branches that are already merged, so unmerged work is never lost.
* Only one action runs on a repository at a time.
* Not included on purpose: force-push, hard reset, rebase, and deleting branches on GitHub. Use a terminal for those.
* Every action is recorded in the activity log. Pushes use your GitHub connection when you have one.

## For a repository on GitHub

**You can work on GitHub directly from the circles, without copying anything.** Click a version and you can start a **new branch** from it, **tag** it, or **see what changed** (opens GitHub). Click a branch that is not merged yet and you can **merge it into main**, **open a pull request**, start a new branch from it, or compare it on GitHub. Click a branch name under "Already merged" to **delete** it. These changes happen on GitHub itself and show up on the map straight away.

Safety: merging and deleting ask you first. If a merge would clash, GitHub refuses and nothing changes. Only branches that are already merged can be deleted, and the main branch never. Pull, push and saving your own changes only make sense for a copy on this computer, so those need **Copy to this computer**.

The same **Map** as above (without a "You are here" marker, because the repository is not on this computer), then when it was last pushed and **open pull requests** (from and into which branch, who, and a link). Press **Copy to this computer** to get the Git buttons: Apiary copies the repository (it also appears under Repositories) and the page switches to it.

## Good to know

* For repositories on this computer, nothing changes until **you** press a Git button (see below). The page never changes anything by itself. For repositories only on GitHub the page is read-only.
* Passwords or tokens inside a repository's web address are hidden.
* The list of GitHub repositories shows up to 100, the most recently pushed first.
* Branch bars and "ahead/behind" are measured against the main branch. If a repository has no main branch yet, they are left out.
* The view reflects what is on this computer. Use **Update from GitHub** under Repositories to fetch the newest state first.
