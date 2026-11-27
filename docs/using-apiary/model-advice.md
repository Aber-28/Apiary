# Choosing the right model

## Pick a model on any agent
Open an agent and use the **Model** dropdown in its header. The list is filled in for the AI that agent uses: models from the provider's API for Claude, and for Codex the models found on your computer plus a few common ones. Choose **Other…** to type any model name. Changing the model starts that agent with a fresh conversation.


Hard work deserves the most capable model. Routine work does not need it, and a faster model saves usage.

- When an agent suggests a hire it says how hard the work is. Apiary suggests a model (most capable, balanced, or fast and cheap) with a reason. Pick another on the approval card if you like.
- Open **Edit profile** on any agent to see the advice for its role and switch with one click.

Rough guide: security, legal and money work gets the most capable model; research, routine operations and summaries get the fast one; everything else gets the balanced one.


## Suggestions while agents work

Apiary watches how each agent is doing, and nudges in **both directions**:

* **Needs a stronger model.** If an agent has trouble with several recent jobs (its work is sent back by a reviewer, you deny its proposals, or its runs fail), Apiary suggests the next more capable model. If it is already on the most capable one, it suggests trying **the other AI** (Claude or Codex) instead, picking up from the [handover note](continuity.md).
* **Could use a cheaper model.** If an agent has done 10 jobs in a row smoothly on a very capable model that its kind of work does not need, Apiary suggests a cheaper one to save usage. If the work gets harder later, it will suggest going back up.

Each suggestion is a normal request under **Approvals**, with one click to accept. Nothing changes unless you approve. At most one suggestion per agent per day, and if you say no, that agent is left alone for a week. After any change the agent's record starts fresh, so it is judged on the new model.

### Automatic mode (off by default)

Under **Settings, Appearance, Model suggestions** you can let Apiary make these changes **without asking**. When you turn it on you are shown a clear warning and must confirm:

* Apiary may use a **more capable model without asking**, which uses **more tokens**.
* It may also move an agent to a **cheaper** model when the work is easy, so there is **no guarantee an agent keeps using the same model**.

Every automatic change is written in the agent's chat (including that it can use more or fewer tokens) and recorded in the Audit log. You can turn it off at any time.
