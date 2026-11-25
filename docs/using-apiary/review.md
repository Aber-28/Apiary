# Review of finished work

When a teammate finishes a delegated task, Apiary can ask **another teammate to check it** before the work counts as done.

## How it works

1. The worker finishes and reports back.
2. A reviewer (a different agent, preferably another role) gets its own task with an ID, linked to the original. It answers **PASS** or **CHANGES NEEDED** with notes.
3. On *changes needed*, the notes go back to the worker, who fixes the work. The reviewer checks once more.
4. If the second round still fails, the task is **blocked** and the lead gets a report starting with "FAILED REVIEW", with the reviewer's notes in plain words.

The review rounds are written into the task history, so you can see who asked for what.

## Turning it off

It is on by default. Switch it off on the **Delegation rules** page ("Review finished work") or with `reviewWork: false` in `PUT /api/settings`. Work is then accepted as soon as it is reported.
