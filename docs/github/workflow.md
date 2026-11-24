# Branches, worktrees and pull requests

## The idea

In a git project, **every agent works in its own checkout on its own branch**. Several agents can edit code at the same time without stepping on each other, and **your own working copy is never touched**.

```
your repo (untouched)
└─ worktrees/<project>/
   ├─ lead                  branch apiary/<project>/lead
   ├─ <researcher-id>       branch apiary/<project>/<researcher-id>
   └─ <writer-id>           branch apiary/<project>/<writer-id>
```

## What Apiary does for you

1. **Start:** creates the lead's branch from the branch you chose.
2. **Delegate:** commits the lead's work, then branches each sub-agent from it.
3. **After each turn:** commits the agent's changes automatically.
4. **Report back:** merges each sub-agent's branch into its parent. If there is a conflict, the merge is **aborted and reported** to the parent agent. Nothing is left half-merged and the branch is kept.
5. **Delete project:** removes the checkouts. **Branches are kept**, so no work is lost.

## Open a pull request

When the lead is idle, press **Open pull request** in the project header. Apiary pushes the lead branch and opens a PR into the base branch using your GitHub connection. A **View pull request** button replaces it afterwards.

Nothing is pushed anywhere until you do this.

## Using a local repository

Choose **Local folder** and enter the path of a git repository. The same branch-per-agent flow applies. A repository without an `origin` remote works for everything except opening a pull request.

## Housekeeping

```bash
git branch --list 'apiary/*'       # see agent branches
git branch -D apiary/...           # delete one
git worktree prune                 # tidy leftovers
```
