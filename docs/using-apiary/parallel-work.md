# Parallel work

When a lead hands tasks to several teammates at the same time, they all work **at once**, and they cannot step on each other.

## How it stays safe

- In a git project every teammate has **their own checkout and branch**, so nobody edits the same files on disk.
- When a teammate finishes, their branch is merged into the lead's branch through a **queue: one merge at a time, in the order they finish**. Two merges never run together.
- If a merge **clashes** with work already merged (for example two people changed the same file), nothing is half-merged. The teammate who caused the clash is asked to bring the lead's latest work into their checkout, fix the clash so both pieces of work are kept, and the merge is tried again.
- The conflict, who fixed it and the outcome are written in the task history. If it still cannot be merged, the branch is kept and the lead is told which files clash.

If you have to approve merges, you still see each one before it happens.
