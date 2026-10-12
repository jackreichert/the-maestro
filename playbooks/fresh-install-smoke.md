# Playbook: fresh-install smoke (for a cheap runner)

You are the runner. You run one script and copy its PASS and FAIL lines into your report. You do not fix anything, and you do not retry a failed step to make it pass.

## What it proves

A stranger who follows the README Quick start gets a working install. The script runs every bash block under "## Quick start" verbatim, in a throwaway `HOME` with a throwaway vault, then runs `npm ci`, `npm run typecheck` and `npm test` inside the clone the Quick start made. Only two things are rewritten: the clone source (this checkout's committed HEAD, so uncommitted edits are not tested) and the vault path placeholder. Nothing is read from or written to your real `HOME`, vault or ledger.

## Run it

```bash
cd <the checkout>
timeout 900 node scripts/fresh-install-smoke.ts
```

- `--remote` clones the real GitHub URL instead of this checkout (use it after a push to prove the public copy).
- `--keep` leaves the temp directory in place and prints its path.
- `SMOKE_TEST_TIMEOUT_S` caps the test step (default 600 seconds). On a busy machine the full suite can need longer; raise it rather than reading a timeout as a failure.

## Read the result

Each step prints `PASS <name> (<seconds>)` or `FAIL <name> (exit N)` with the last 25 lines of its output. Exit 0 means every step passed, 1 means a step failed (the first failure stops the run), 2 means bad usage.

| Step | A failure means |
|---|---|
| quick start | The README commands no longer work as written. |
| journal folder created | The README says something the code does not do. |
| npm ci | The lockfile and `package.json` disagree, or the registry is unreachable. |
| typecheck | The tree does not typecheck from a clean install. |
| test | A test fails or hangs from a clean `HOME` (no GitHub login, no config). A test that needs `gh` or a config file is a bug in the test. |

Report the failing step and its tail. Do not edit the README or tests to make it pass.
