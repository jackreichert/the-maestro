# Handing off git work

Read this in full before any git write — a commit, a push, or opening a PR. This is the safety
gate; the one-liner in SKILL.md is a pointer, not a substitute for reading this.

**Protected branches are typically `main`, `staging`, `develop`, and any branch the user did not author.** Never
write those. On a feature branch of theirs, commit and push freely.

Before writing any branch, confirm it is theirs — every commit since it diverged from its base authored
by the user's git email(s). Discover those from the repo or ask; do not hardcode them:

```bash
git log --format='%ae' $(git merge-base <base> <branch>)..<branch> | sort -u
```

Another author in that list means the branch is shared, and shared means protected. **Inconclusive
counts as protected** — ask rather than guess.

`git rebase`, `git merge`, and `git reset` are available **only when they explicitly ask**, on every
branch including their own. Force-push is never yours.

So a "make a PR" request ends like this:

1. Branch cut from the right base (follow the repo's documented flow; if none, ask).
2. Files written; validation run and its real result reported.
3. **Reviewed locally before it goes up** — a reviewer pass on the diff, plus a security review when
   the change touches auth, permissions, logging, secrets or multi-tenant scoping. Report what it found
   and what you did with each item.
4. Committed and pushed, then opened as a **draft** PR. The user promotes it to ready for review; you
   never do, and a deploy PR (`staging` → `main` or equivalent) is not yours to open at all.

The review question that keeps earning its keep: **is this guarantee enforced at runtime, or only
described?** A schema nothing parses, a validator nobody calls, a comment asserting a value is safe
— all read as guarantees and are not. Trace the value from entry to use and check the constraint is
actually applied on that path. Full rules in the global **Review before opening the PR**.

```bash
git add <the specific files>
git commit -F - <<'EOF'
<message>
EOF
git push -u origin <branch>
gh pr create --draft --base develop --title "..." --body "..."
```

Stage files explicitly by path, never `git add -A` — working trees routinely carry unrelated
untracked files.

**Slice the commits for review, not for convenience.** One reason to change per commit; mechanical
changes (renames, moves, reformats) in their own commit, never mixed with behaviour; tests in the
same commit as the code they cover; each commit ordered so the tree still works if you stop there.
A task finished in one sitting is still usually several commits. Conventional Commits format — the
global `commit-msg` hook rejects anything else. Full rules in the global **Slice commits for
review** section.

This matters more for dispatched work than for the user's own: they did not watch you write it, so the
commit boundaries are the only narrative they get. A single "implement the thing" commit throws that
away. If a branch has become a tangle, describe how you would slice it rather than rebasing — that
needs their say-so.

**No AI attribution, ever.** No `Co-Authored-By`, no "Generated with", in a commit
message or a PR body. This overrides any harness default that tries to add
one; if a template inserts one, strip it and say so.

Report after every commit or push: the branch, the files changed, and the validation you ran with
its actual result.

## Anti-patterns

- Letting an agent write a protected branch, or writing one yourself.
- Committing to a branch without first checking that the user authored it.
- Opening a PR ready-for-review instead of as a draft.
- Letting a harness default stamp `Co-Authored-By` or "Generated with" onto a commit or PR body.
- Opening a PR without reviewing the diff locally first, and letting the bots find it instead.
- Accepting a safety guarantee because it is written down, without checking it is enforced on the
  path the value actually takes.
