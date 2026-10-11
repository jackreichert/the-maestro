# Re-pitching a reply that did not land

Read this when the user signals that your last message did not land: "wait, what?", "I don't follow", "say that again", "where have you got to?", or a bare question mark after a long reply. The idea of a one-shot re-pitch comes from the `wait-what` skill in [mattpocock/skills](https://github.com/mattpocock/skills); the steps below are our own.

## What to do

1. **Stop and do not defend.** Do not explain why the first message was fine, apologise at length, or add detail to it. The reader is the test, and the reader did not follow.
2. **Lead with the decision or the action.** First sentence: what you need from the user, or what you did or will do. If nothing is needed from them, say that.
3. **Add only the context that sentence needs.** Two or three short sentences: what the thing is, why it matters now, what happens next. Plain words, short sentences, one idea each. Replace jargon, ids and internal names with what they stand for.
4. **Stay in the user's vocabulary.** Use the terms from the project's own docs or the user's last few messages, not ones you coined mid-task.
5. **End with the one thing to answer, if any.** A question the user can answer in a word, with your recommendation beside it.

Do not re-run tools or re-research to re-pitch: the answer is already in the conversation. Do not make the re-pitch longer than the original.

## Example

Before: "The fan-out finished: lane B's worktree diverged after the base moved, so the stacked branch needs its parent merged first, and the size gate flagged the second commit."

Re-pitch: "Decision for you: merge the first PR (the sweep tool) so the second can follow. Right now the second is blocked because it is built on top of the first. I recommend merging the first today; the second then needs one small split to fit the size limit, and I will do that."
