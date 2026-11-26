# Retries and recovery

Agents sometimes fail for reasons that have nothing to do with the work: the network drops, a service is busy, a usage limit is reached, a login expires, or a run simply goes quiet. Apiary handles this in a fixed order, so you are only bothered when it really matters.

1. **Try again.** A short hiccup (network error, "overloaded") or a run that has shown no sign of life for 20 minutes is stopped and retried, up to two times, with a short pause.
2. **Hand it to the other AI.** If Claude has hit its usage limit or lost its sign-in, **Codex takes over that step** (and the other way round), as long as the other one is set up on the Connections page. The agent keeps its own AI afterwards. The switch is written in the chat.
3. **Ask you, in plain words.** If nothing worked you get a request on the Approvals page saying what happened, what Apiary tried, and what usually helps (a limit resets, sign in again). Choose **Try again** or **Give up**. Giving up stops the step and tells the lead why.

The new AI is told to read a short [handover note](continuity.md) first, so it carries on instead of starting over.

Nothing is silently dropped, and a stuck step never blocks the team forever.

## Settings

`maxRetries` (0 to 5, default 2) sets how often step 1 is repeated. The quiet-time limit can be changed with the `APIARY_STUCK_MS` environment variable.
