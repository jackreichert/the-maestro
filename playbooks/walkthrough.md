# Playbook: a generated walkthrough for steps only the user can do

The idea of a generated, interactive walk-through for manual procedures comes from the `wizard` skill in [mattpocock/skills](https://github.com/mattpocock/skills). This version is our own, shaped for zsh and for our rules on secrets and applies. A cheap runner can generate one; the user runs it.

## When to use it, and when not

Nearest existing mechanism: a paste block (`journal.ts ask --paste <file>`). A paste block is right when the user's job is to run a few commands. Use it first.

A walkthrough adds something only when the procedure has **three or more steps that depend on each other and mix actions the user takes by hand** (a console click, creating a credential, approving a change) **with commands**, and when stopping at the first failure matters. It runs each check for them, shows pass or fail, never moves on past a failure, and enforces plan before apply. If a block of commands would do, write the block. Never use a walkthrough for steps an agent can do itself.

## Template

[scripts/walkthrough/walkthrough.zsh](../scripts/walkthrough/walkthrough.zsh) is the same for every walkthrough: do not edit it. You write only a steps file for it, then the user runs:

```bash
zsh scripts/walkthrough/walkthrough.zsh <steps-file>
```

What it does for each step: prints "Step N of M" and your instructions, waits for Enter (`q` quits), checks that the step's required variables are set (names only, "set" or "MISSING", never a value), runs the step's check, and prints PASS or FAIL. It stops at the first failure with exit 1. It never prints a check command's output, so a check cannot leak a secret by accident. Exit 2 means a bad steps file.

## Writing the steps file

The steps file is zsh, sourced by the template. Per step id `X`:

| Name | Purpose |
|---|---|
| `WALK_TITLE`, `WALK_STEPS=(id ...)` | Title and ordered step ids. |
| `X_TITLE` | Short heading. |
| `X_say()` | A function that prints what to do: the URL, where to click, which variable name to fill. |
| `X_check()` | A function that returns 0 when the step worked. Command variables are functions, never strings. |
| `X_NEEDS=(NAME ...)` | Optional. Environment variable names that must be set; checked by name only. The walkthrough is its own process, so a variable the user exports in their shell after launching it is never seen: list only variables already exported before launch, and say so in the first step. |
| `X_KIND` | `action` (default), `plan` or `apply`. |

Rules for the file:

- **Credentials created during the walkthrough** go in a durable place the check can see (the CLI's own login state, a credential file), and the check asks the CLI (as `login_check` does below), not `X_NEEDS`.
- **Names only for secrets.** Say which variable to set, never a value. Look a credential up by name with `env-where NAME`; do not open the file it names.
- **Plan before apply, with counts.** A `plan` step's check must print one line `PLAN add=N change=N destroy=N replace=N`. The template shows the counts, and stops the run if destroy or replace is above zero. An `apply` step is refused unless the step directly before it was a plan that passed: any other step in between, even a hand step, voids the plan, and one plan covers one apply.
- **Print with `print -r --`**, never plain `print --`, in `X_say`. Without `-r`, zsh expands `\n` and `\t`, so a `sed` or `printf` command shown for pasting reaches the user changed. The template does the same for titles.
- **Zsh paste rules** for anything the user will copy from `X_say`: no inline `#` comments on a command line, command variables as functions, and one line per command.
- **One focused task per step**, so the instructions fit on one screen.
- Do not run the walkthrough yourself: it waits on a human. Check the file with `zsh -n <steps-file>` and trace that every value a later step needs is produced by an earlier one.

## Example

A fictional cutover with one hand step and one infrastructure apply:

```zsh
WALK_TITLE="Move the reports job to the new queue"
WALK_STEPS=(login plan apply smoke)

login_TITLE="Sign in to the cloud console"
login_say() {
  print -r -- "  Open the console and run: cloud-cli login"
}
login_check() { cloud-cli whoami }

plan_TITLE="Plan the queue change"
plan_KIND=plan
plan_say() { print -r -- "  The check runs the plan for you. Press Enter to start it." }
plan_check() { ./scripts/plan-queue.sh }

apply_TITLE="Apply the queue change"
apply_KIND=apply
apply_say() { print -r -- "  Counts above are from the plan you just passed. Press Enter to apply." }
apply_check() { ./scripts/apply-queue.sh }

smoke_TITLE="Confirm one job runs"
smoke_say() { print -r -- "  Trigger one test job from the console." }
smoke_check() { ./scripts/check-job.sh }
```

The template is covered by [scripts/walkthrough/walkthrough.test.ts](../scripts/walkthrough/walkthrough.test.ts), which runs it against fake step lists.
