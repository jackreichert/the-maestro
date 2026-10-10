# Grill mode: interview the user through a plan, one frontier at a time

Grill mode is an on-demand way to settle a plan or design whose decisions depend on one another. The assistant interviews the user in rounds until both sides hold the same picture, and takes no action on the plan until the user confirms it. The shape is adapted from the grilling skill in [mattpocock/skills](https://github.com/mattpocock/skills/blob/main/skills/productivity/grilling/SKILL.md); the wording here is our own.

## When it runs

- The user says "grill me" (or "grill this plan").
- The orchestrator proposes it, in one line, when a decision forks into dependent choices: a design with several linked calls, where answering one changes which of the others are worth asking. The user accepts or ignores it.

Nothing else triggers it. Bolero mode and the dispatch-unless-blocked default stay in force for all other work: the orchestrator keeps sending agents on anything that is not blocked by a user-only decision, and it takes its own recommendation on small calls.

## Why the existing mechanisms are not enough

The nearest mechanisms are an `ask` with `--recommend` ([ledger.md](ledger.md)) and bolero's "take the recommendation and log it". Both treat a question as standalone. An `ask` is one row on the board; the orchestrator does not know which other questions its answer unlocks or kills, so a design with six linked calls turns into six unrelated asks, most of them premature, or into a guess at the answers. Bolero's default resolves decisions silently, which is wrong when the user wants to shape the plan before anything is built. Grill mode adds the one thing missing: ordering the questions by dependency and putting a whole ready set in front of the user at once.

## The method

1. **Sketch the design tree.** List the decisions the plan needs. Draw an edge from A to B when B cannot be asked sensibly until A is answered. Keep it in the working notes, not in the reply.
2. **Find the frontier.** The frontier is every open decision whose prerequisites are all settled. Questions behind an unanswered one wait.
3. **Sort facts from decisions.** A fact is something that can be looked up (what the code does today, what the environment holds, what a config says). The assistant looks facts up itself and never asks the user; an environment question goes to a Haiku or Explore sub-agent, and the round does not wait for it: the rest of the frontier goes out, and the looked-up fact lands in the next round (or, if it changes a question already asked, as a short correction). A decision is a choice among options that only the user can make; those go in the round.
4. **Ask the whole frontier in one numbered round.** Each question has a bold title, a short body (with options when they help) and a recommended answer, worded so that replying "yes" accepts it. The user can answer "yes to all", "yes except 2, which is ...", or reorder.
5. **Recompute.** Each answer settles a node, which may put new decisions on the frontier and may make others moot (drop those and say so). Run the next round.
6. **Finish.** Stop when the frontier is empty and nothing was silently assumed. Read the shared understanding back as a short summary (decisions, plus the facts it rests on) and wait. Do not act on the plan, start agents on it, or file work from it until the user confirms.

Keep a round to what is ready. Padding it with questions from further down the tree is the failure this mode exists to avoid.

## Recording the answers

- Each answered question becomes a ledger decision note: `journal.ts log --kind decision "<what was decided and why>"`, naming the alternative that was rejected. Write them after the round, one per decision, not one for the batch.
- A call that is a one-way door and still unanswered at the end of a round goes through the normal Podium ask path (`ask` with `--recommend`, `--door`, `--default` for a two-way door only, and the context in the body, see [ledger.md](ledger.md)), so it survives the session. A decision the user answered in the round is recorded, not asked again.
- Facts the round established that a later session would have to re-derive go in with `journal.ts learned`.

## Example round

Fictional plan: add a retry queue to a hypothetical `widget-sync` service. The first round asks the three decisions with no prerequisites; a fourth (the dead-letter policy) waits on question 1, and "which queue library is installed" is a fact, so a sub-agent looks it up instead.

> **Round 1 of the retry-queue plan.** Three decisions are ready. I am checking the installed queue library myself and will fold it into round 2.
>
> 1. **Where retries live.** In-process timers are simplest but lose pending retries on restart; a persisted queue survives restarts and needs storage. I recommend a persisted queue. Yes?
> 2. **What counts as retryable.** Network timeouts and 5xx only, or also 429 with its retry-after header. I recommend timeouts, 5xx and 429. Yes?
> 3. **Retry ceiling.** A fixed count (5 attempts) or a total time budget (1 hour). I recommend the time budget, because a count hides how long a caller waits. Yes?
>
> Held back until 1 is answered: dead-letter handling (depends on where retries live), and the metrics to emit (depends on 2 and 3).

User: "yes, yes, 5 attempts is fine actually". The orchestrator records three decision notes (the third records the fixed count as chosen and the recommended time budget as rejected), recomputes the frontier, and round 2 asks dead-letter handling and metrics, plus the library fact if it changes an option. When round 3 comes back empty it reads the plan back and waits for "go".
