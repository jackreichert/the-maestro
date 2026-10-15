# Playbook: the cold-start agent eval (for a cheap runner and a separate grader)

The gate (`scripts/drills/real-state-gate.ts`) proves the facts are on the page. This eval proves a fresh model can read the page and act on it. It needs two agents that share no context: an answerer who sees only the start context, and a grader who did not write it and never sees the answerer's reasoning. Run it on demand, and after any change to the hook, the cold-start page or the CURRENT render.

## 1. Build the context and the truth

```bash
node scripts/drills/real-state-gate.ts --project <project> --emit-context "$(mktemp -d)/context.md"
```

The gate must say `real-state gate: ok` first; if it does not, stop and report its `MISSING` lines. The context file is a copy of what the SessionStart hook prints for `startup` and holds real ledger text: keep it in the temporary directory and delete it afterwards. Nothing leaves the machine except through the agents you start.

## 2. The answerer (Haiku, fresh, no tools beyond reading that file)

Give it only the context file and these eight questions, and ask for short answers with ledger ids:

1. What are today's priorities?
2. What is in flight, and where (stream, worktree or branch when shown)?
3. For one in-flight id you pick, what is the next step to continue it? (Where the context points at `journal.ts recover <id>`, say what you would run.)
4. Which asks are open and waiting on the user?
5. What did the last session decide?
6. How do you run the-maestro's tests?
7. What is blocked, and on what?
8. What shipped yesterday?

## 3. The grader (a different fresh agent)

Give it the eight questions, the answerer's answers, and the ground truth read straight from the ledger (`journal.ts status`, `journal.ts priorities show`, `journal.ts standing list`, and the library page for how to run the tests). It never sees the context file. Score each answer 1 (correct and specific, ids included), 0.5 (right area, vague) or 0 (wrong or absent). A question whose fact is not yet on the page (decisions, recover) scores 0 and is named: that is the gap, not an error in the eval.

Pass is 7 of 8 (a proposal; the number is not yet settled).

## 4. Record

Write one review note under `Projects/<project>/Reviews/` with the date, the score, the per-question result and which fact was missing for each 0. Ids and counts, no free text from the ledger. A score below 7 files a ticket for the missing fact; do not patch the context by hand.
