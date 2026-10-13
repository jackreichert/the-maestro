// Run: node --test scripts/ci-gates.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

const GATES = new URL('./ci-gates.ts', import.meta.url).pathname;
const PR_SIZE = new URL('./pr-size.ts', import.meta.url).pathname;
const PR_OPEN = new URL('./pr-open.ts', import.meta.url).pathname;

const git = (repo: string, ...args: string[]): void => {
  const r = spawnSync('git', ['-C', repo, ...args], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
};
const lines = (n: number): string => Array.from({ length: n }, (_, i) => `x${i}`).join('\n') + '\n';
const put = (repo: string, path: string, text: string): void => { mkdirSync(dirname(join(repo, path)), { recursive: true }); writeFileSync(join(repo, path), text); };

/** A feature branch on top of main. No origin unless the test adds one. Hooks are off. */
function repoWith(files: Record<string, string>): string {
  const repo = mkdtempSync(join(tmpdir(), 'ci-gates-'));
  git(repo, 'init', '-q', '-b', 'main');
  git(repo, 'config', 'user.email', 'test@example.com');
  git(repo, 'config', 'user.name', 'Test');
  git(repo, 'config', 'core.hooksPath', '/dev/null');
  put(repo, 'README.keep', 'keep\n');
  git(repo, 'add', '--all');
  git(repo, 'commit', '-q', '-m', 'base');
  git(repo, 'checkout', '-q', '-b', 'feature');
  for (const [p, t] of Object.entries(files)) put(repo, p, t);
  git(repo, 'add', '--all');
  git(repo, 'commit', '-q', '-m', 'change');
  return repo;
}

const home = (): string => mkdtempSync(join(tmpdir(), 'ci-gates-home-'));
const configFile = (body: string): string => {
  const path = join(mkdtempSync(join(tmpdir(), 'ci-gates-cfg-')), 'config.md');
  writeFileSync(path, `\`\`\`maestro-config\n${body}\n\`\`\`\n`);
  return path;
};
const bodyFile = (text: string): string => {
  const path = join(mkdtempSync(join(tmpdir(), 'ci-gates-body-')), 'body.md');
  writeFileSync(path, text);
  return path;
};

/** A body that passes the default rules for a PR that is not stacked and stays at or under the diagram threshold. */
const SMALL_BODY = [
  '## Context', 'Why this change exists.',
  '## Reviewer guide', 'Start with the new module.',
  '## Risk and blast radius', 'Risk: low - fixture only.',
  '## Rollback / flag', 'Revert the commit.',
  '## How to verify locally', '```bash', 'node --test scripts/ci-gates.test.ts', '```', '',
].join('\n');

/** Same body, plus the lines a wider diff needs so a size failure is not masked by a body failure. */
const WIDE_BODY = [
  SMALL_BODY,
  'Diagram: n/a, no new flow to draw.',
  '## Reviewer guide', '- Review order: `src/f0.py`',
  '',
].join('\n');

const envFor = (dir: string, extra: Record<string, string> = {}): NodeJS.ProcessEnv => ({
  PATH: process.env.PATH, HOME: dir, GIT_TERMINAL_PROMPT: '0', GIT_ALLOW_PROTOCOL: 'file', ...extra,
});

const run = (script: string, args: string[], env: NodeJS.ProcessEnv) => spawnSync(process.execPath, [script, ...args], { encoding: 'utf8', env, timeout: 20_000 });

test('an env override that loosens the diagram limit in pr-open does not loosen it here', () => {
  const repo = repoWith({ 'src/f0.py': lines(1), 'src/f1.py': lines(1), 'src/f2.py': lines(1), 'src/f3.py': lines(1) });
  const body = bodyFile(`${SMALL_BODY}\n## Reviewer guide\n- Review order: \`src/f0.py\`\n`);
  const env = envFor(home(), { MAESTRO_PR_DIAGRAM_MIN_FILES: '100' });
  const opened = run(PR_OPEN, ['--repo', repo, '--base', 'main', '--head', 'feature', '--title', 'Add four modules', '--body-file', body, '--dry-run'], env);
  assert.equal(opened.status, 0, `a normal process honours the override:\n${opened.stderr}`);
  const gated = run(GATES, ['--repo', repo, '--base', 'main', '--head', 'feature', '--title', 'Add four modules', '--body-file', body], env);
  assert.equal(gated.status, 1, gated.stdout + gated.stderr);
  assert.match(gated.stderr, /ignored environment overrides:.*MAESTRO_PR_DIAGRAM_MIN_FILES/);
  assert.match(gated.stderr, /Diagram: n\/a/);
  assert.match(gated.stdout, /body:\s+FAIL/);
});

test('pointing MAESTRO_LOCAL_CONFIG at a higher file limit passes pr-size and still fails here', () => {
  const files: Record<string, string> = {};
  for (let i = 0; i < 6; i++) files[`src/f${i}.py`] = lines(1);
  const repo = repoWith(files);
  const body = bodyFile(WIDE_BODY);
  const env = envFor(home(), { MAESTRO_LOCAL_CONFIG: configFile('pr_max_code_files: 20\npr_max_code_lines: 400') });
  const sized = run(PR_SIZE, ['--repo', repo, '--base', 'main', '--head', 'feature'], env);
  assert.equal(sized.status, 0, `a normal process honours the file the env var names:\n${sized.stderr}${sized.stdout}`);
  const gated = run(GATES, ['--repo', repo, '--base', 'main', '--head', 'feature', '--title', 'Add six modules', '--body-file', body], env);
  assert.equal(gated.status, 1, gated.stdout + gated.stderr);
  assert.match(gated.stderr, /ignored environment overrides:.*MAESTRO_LOCAL_CONFIG/);
  assert.match(gated.stderr, /6 code files \(max 5\)/);
  assert.match(gated.stdout, /size:.*FAIL/);
});

test('waive_size_gate_owners in the default user config still waives; the same list via an env path does not', () => {
  const repo = repoWith({ 'src/big.py': lines(500) });
  git(repo, 'remote', 'add', 'origin', 'https://github.com/example-owner/widgets.git');
  const body = bodyFile(SMALL_BODY);
  const loose = configFile('waive_size_gate_owners: example-owner');
  const viaEnv = envFor(home(), { MAESTRO_LOCAL_CONFIG: loose });
  const opened = run(PR_OPEN, ['--repo', repo, '--base', 'main', '--head', 'feature', '--title', 'A wide module', '--body-file', body, '--dry-run'], viaEnv);
  assert.equal(opened.status, 0, `a normal process waives from the env-named file:\n${opened.stderr}`);
  assert.match(opened.stdout, /size limits waived for example-owner\/widgets/);
  const refused = run(GATES, ['--repo', repo, '--base', 'main', '--head', 'feature', '--title', 'A wide module', '--body-file', body], viaEnv);
  assert.equal(refused.status, 1, refused.stdout + refused.stderr);
  assert.match(refused.stderr, /over budget: 500 code lines/);
  assert.doesNotMatch(`${refused.stdout}${refused.stderr}`, /size limits waived/);

  const dir = home();
  mkdirSync(join(dir, '.config', 'the-maestro'), { recursive: true });
  writeFileSync(join(dir, '.config', 'the-maestro', 'config.md'), '```maestro-config\nwaive_size_gate_owners: example-owner\n```\n');
  const kept = run(GATES, ['--repo', repo, '--base', 'main', '--head', 'feature', '--title', 'A wide module', '--body-file', body], envFor(dir));
  assert.equal(kept.status, 0, kept.stdout + kept.stderr);
  assert.match(kept.stdout, /size limits waived for example-owner\/widgets \(waive_size_gate_owners\)/);
});

test('the user-config waiver does not lift a mix of code and mechanical files', () => {
  const repo = repoWith({ 'src/a.py': lines(3), 'uv.lock': lines(20) });
  git(repo, 'remote', 'add', 'origin', 'https://github.com/example-owner/widgets.git');
  const dir = home();
  mkdirSync(join(dir, '.config', 'the-maestro'), { recursive: true });
  writeFileSync(join(dir, '.config', 'the-maestro', 'config.md'), '```maestro-config\nwaive_size_gate_owners: example-owner\n```\n');
  const gated = run(GATES, ['--repo', repo, '--base', 'main', '--title', 'Lock and code', '--body-file', bodyFile(SMALL_BODY)], envFor(dir));
  assert.equal(gated.status, 1, gated.stdout + gated.stderr);
  assert.match(gated.stderr, /mechanical changes go in their own PR/);
});

test('a within-budget diff with a complete body passes, and no flag skips a gate', () => {
  const repo = repoWith({ 'src/a.py': lines(4) });
  const ok = run(GATES, ['--repo', repo, '--base', 'main', '--title', 'A small module', '--body-file', bodyFile(SMALL_BODY)], envFor(home()));
  assert.equal(ok.status, 0, ok.stdout + ok.stderr);
  assert.match(ok.stdout, /size:.*PASS/);
  assert.match(ok.stdout, /body:\s+PASS/);
  assert.match(ok.stdout, /smells:\s+PASS/);
  const skipped = run(GATES, ['--repo', repo, '--base', 'main', '--title', 'A small module', '--body-file', bodyFile(SMALL_BODY), '--waive-size-gate'], envFor(home()));
  assert.equal(skipped.status, 2);
  assert.match(skipped.stderr, /unknown argument --waive-size-gate/);
});
