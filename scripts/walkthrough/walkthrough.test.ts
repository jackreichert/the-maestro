// Run: node --test scripts/walkthrough/walkthrough.test.ts
// Runs the zsh template against fake step lists in a temp dir. Every value here is obviously fake.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const SCRIPT = new URL('./walkthrough.zsh', import.meta.url).pathname;
const FAKE_SECRET = 'fake-secret-value-123';

function run(steps: string, input: string, env: Record<string, string> = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'walk-'));
  const file = join(dir, 'steps.zsh');
  writeFileSync(file, steps);
  const r = spawnSync('zsh', [SCRIPT, file], { input, encoding: 'utf8', env: { PATH: process.env.PATH ?? '', ...env }, timeout: 20000 });
  return { code: r.status, out: r.stdout + r.stderr };
}

const ENTER = '\n';

const FULL = `
WALK_TITLE="Fake rollout"
WALK_STEPS=(login plan1 apply1)
login_TITLE="Sign in"
login_NEEDS=(FAKE_TOKEN)
login_say() { print -- "  Sign in to the console."; }
login_check() { print -- "${FAKE_SECRET}"; return 0; }
plan1_TITLE="Plan"
plan1_KIND=plan
plan1_say() { print -- "  Run the plan."; }
plan1_check() { print -- "noise"; print -- "PLAN add=2 change=1 destroy=0 replace=0"; }
apply1_TITLE="Apply"
apply1_KIND=apply
apply1_say() { print -- "  Apply it."; }
apply1_check() { return 0; }
`;

test('happy path passes every step, shows plan counts, prints no check output or secret value', () => {
  const r = run(FULL, ENTER.repeat(3), { FAKE_TOKEN: FAKE_SECRET });
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /Step 1 of 3: Sign in/);
  assert.match(r.out, /needs FAKE_TOKEN: set/);
  assert.match(r.out, /Plan counts: add=2 change=1 destroy=0 replace=0/);
  assert.match(r.out, /All 3 steps passed\./);
  assert.equal((r.out.match(/PASS/g) ?? []).length, 3);
  assert.ok(!r.out.includes(FAKE_SECRET), 'a secret value or check output leaked');
});

test('a missing required variable stops the run, names it, and runs no later step', () => {
  const r = run(FULL, ENTER.repeat(3));
  assert.equal(r.code, 1);
  assert.match(r.out, /needs FAKE_TOKEN: MISSING/);
  assert.match(r.out, /Stopped at step 1 of 3/);
  assert.ok(!r.out.includes('Step 2 of 3'));
});

test('a failing check stops at that step with FAIL and no check output', () => {
  const steps = `
WALK_STEPS=(one two)
one_say() { print -- "  Do one."; }
one_check() { print -- "${FAKE_SECRET}"; return 3; }
two_say() { print -- "  Do two."; }
two_check() { return 0; }
`;
  const r = run(steps, ENTER.repeat(2));
  assert.equal(r.code, 1);
  assert.match(r.out, /FAIL: check did not pass/);
  assert.match(r.out, /Stopped at step 1 of 2/);
  assert.ok(!r.out.includes('Step 2 of 2'));
  assert.ok(!r.out.includes(FAKE_SECRET));
});

test('an apply step with no passed plan step before it is refused before anything is asked', () => {
  const steps = `
WALK_STEPS=(go)
go_KIND=apply
go_say() { print -- "  Apply."; }
go_check() { touch "$PWD/should-not-run"; return 0; }
`;
  const r = run(steps, ENTER);
  assert.equal(r.code, 1);
  assert.match(r.out, /apply step needs a passed plan step/);
  assert.ok(!r.out.includes('Press Enter'));
});

test('a plan that destroys or replaces stops the run before the apply step', () => {
  for (const counts of ['add=0 change=0 destroy=1 replace=0', 'add=0 change=0 destroy=0 replace=2']) {
    const steps = `
WALK_STEPS=(p a)
p_KIND=plan
p_say() { print -- "  Plan."; }
p_check() { print -- "PLAN ${counts}"; }
a_KIND=apply
a_say() { print -- "  Apply."; }
a_check() { return 0; }
`;
    const r = run(steps, ENTER.repeat(2));
    assert.equal(r.code, 1, r.out);
    assert.match(r.out, /destroys or replaces resources/);
    assert.ok(!r.out.includes('Step 2 of 2'));
  }
});

test('a plan step that prints no valid PLAN line fails', () => {
  const steps = `
WALK_STEPS=(p)
p_KIND=plan
p_say() { print -- "  Plan."; }
p_check() { print -- "PLAN add=two change=0 destroy=0 replace=0"; }
`;
  const r = run(steps, ENTER);
  assert.equal(r.code, 1);
  assert.match(r.out, /no valid PLAN/);
});

test('a plan only covers the next apply: a second apply is refused', () => {
  const steps = `
WALK_STEPS=(p a b)
p_KIND=plan
p_say() { print -- "  Plan."; }
p_check() { print -- "PLAN add=1 change=0 destroy=0 replace=0"; }
a_KIND=apply
a_say() { print -- "  Apply one."; }
a_check() { return 0; }
b_KIND=apply
b_say() { print -- "  Apply two."; }
b_check() { return 0; }
`;
  const r = run(steps, ENTER.repeat(3));
  assert.equal(r.code, 1);
  assert.match(r.out, /Stopped at step 3 of 3/);
});

test('q and end of input both stop the run with exit 1', () => {
  assert.equal(run(FULL, 'q\n', { FAKE_TOKEN: 'x' }).code, 1);
  const eof = run(FULL, '', { FAKE_TOKEN: 'x' });
  assert.equal(eof.code, 1);
  assert.match(eof.out, /Input ended/);
});

test('bad usage and a malformed steps file exit 2', () => {
  assert.equal(spawnSync('zsh', [SCRIPT], { encoding: 'utf8' }).status, 2);
  assert.equal(spawnSync('zsh', [SCRIPT, '/nonexistent/steps.zsh'], { encoding: 'utf8' }).status, 2);
  const r = run('WALK_STEPS=(orphan)\n', '');
  assert.equal(r.code, 2);
  assert.match(r.out, /no orphan_say function/);
});
