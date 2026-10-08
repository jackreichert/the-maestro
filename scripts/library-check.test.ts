// Run: node --test scripts/library-check.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { checkVault, discover, parseOptions } from './library-check.ts';

const SCRIPT = new URL('./library-check.ts', import.meta.url).pathname;
const REPO = 'avonlea-api';
const PAGE = `Projects/${REPO}/Knowledge/orchard-sync.md`;

const frontmatter = (over: Record<string, string> = {}): string => {
  const f: Record<string, string> = {
    type: 'library', kind: 'how-it-works', repo: REPO, stream: 'Avonlea', components: '[orchard-sync]', status: 'current',
    'verified-at': '2026-10-08@abc1234', 'verify-how': '"read src/sync.ts:40"', 'composed-by': 'composer', ...over,
  };
  return `---\n${Object.entries(f).filter(([, v]) => v !== '').map(([k, v]) => `${k}: ${v}`).join('\n')}\n---\n`;
};
const BODY = '# Orchard sync\n\nRead when: you change how orchards are synced.\n\n## Facts\n\n- The sync runs nightly at 02:00 (verified 2026-10-08, src/sync.ts:40).\n';

function vault(files: Record<string, string> = {}): string {
  const root = mkdtempSync(join(tmpdir(), 'library-'));
  const all = { [`Projects/${REPO}/INDEX.md`]: `---\ntype: library-index\nrepo: ${REPO}\ncomponents: [orchard-sync, harvest-export]\n---\n`, [PAGE]: frontmatter() + BODY, ...files };
  for (const [p, t] of Object.entries(all)) { mkdirSync(dirname(join(root, p)), { recursive: true }); writeFileSync(join(root, p), t); }
  return root;
}
const run = (root: string, ...args: string[]) => spawnSync(process.execPath, [SCRIPT, '--vault', root, ...args], { encoding: 'utf8' });
const problems = (root: string, path = PAGE) => checkVault(root, [path])[0]?.findings ?? [];

test('a well-formed page passes and the command exits 0', () => {
  const root = vault();
  const r = run(root);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /1 page checked, 0 failing/);
});

test('an unknown component fails the exit code and names the component', () => {
  const root = vault({ [PAGE]: frontmatter({ components: '[orchard-sync, orchardsync]' }) + BODY });
  const r = run(root);
  assert.equal(r.status, 1);
  assert.match(r.stdout, /components {2}unknown component "orchardsync"/);
});

test('a secret shape fails the exit code, names the line and never prints the value', () => {
  const secret = `${'hunter2'}${'hunter2'}`;
  const root = vault({ [PAGE]: `${frontmatter()}${BODY}- The login is ${'password'}: ${secret} (verified 2026-10-08, notes).\n` });
  const r = run(root);
  assert.equal(r.status, 1);
  assert.match(r.stdout, /secrets {2}secret:named-value shape/);
  assert.ok(!r.stdout.includes(secret) && !r.stderr.includes(secret));
});

test('a fact with no dated evidence, a bad kind and a missing field are each reported', () => {
  const root = vault({ [PAGE]: frontmatter({ kind: 'essay', 'verify-how': '' }) + BODY.replace(' (verified 2026-10-08, src/sync.ts:40)', '') });
  const messages = problems(root).map((f) => `${f.rule}: ${f.message}`).join('\n');
  assert.match(messages, /vocabulary: kind "essay"/);
  assert.match(messages, /frontmatter: missing required field "verify-how"/);
  assert.match(messages, /facts: a fact must end/);
});

test('a page with no frontmatter, or no Read when line, fails', () => {
  assert.match(problems(vault({ [PAGE]: BODY }))[0]?.message ?? '', /no frontmatter/);
  assert.ok(problems(vault({ [PAGE]: frontmatter() + BODY.replace('Read when:', 'Use when:') })).some((f) => /Read when/.test(f.message)));
});

test('repo must match the project folder and exist', () => {
  assert.ok(problems(vault({ [PAGE]: frontmatter({ repo: 'orchard-web' }) + BODY })).some((f) => f.rule === 'repo' && /not a project/.test(f.message)));
  const root = vault({ [`Projects/orchard-web/Knowledge/x.md`]: frontmatter({ repo: REPO }) + BODY });
  assert.ok(problems(root, 'Projects/orchard-web/Knowledge/x.md').some((f) => f.rule === 'repo' && /does not match/.test(f.message)));
});

test('a repo with no component list cannot pass a component check', () => {
  const root = vault({ [`Projects/${REPO}/INDEX.md`]: '# index\n' });
  assert.ok(problems(root).some((f) => /no components list/.test(f.message)));
});

test('superseded needs superseded-by, and links must resolve by path or by page name', () => {
  const other = `Projects/${REPO}/Knowledge/harvest-export.md`;
  assert.ok(problems(vault({ [PAGE]: frontmatter({ status: 'superseded' }) + BODY })).some((f) => /superseded-by is empty/.test(f.message)));
  const good = vault({ [other]: frontmatter({ components: '[harvest-export]' }) + BODY, [PAGE]: frontmatter({ status: 'superseded', 'superseded-by': '[[harvest-export]]', 'depends-on': `[${other.replace(/\.md$/, '')}]` }) + BODY });
  assert.deepEqual(problems(good), []);
  const bad = vault({ [PAGE]: frontmatter({ 'depends-on': '[no-such-page]' }) + BODY });
  assert.ok(problems(bad).some((f) => /depends-on "no-such-page" does not resolve/.test(f.message)));
});

test('a page over the line budget, or with more History than Facts, is flagged', () => {
  const long = vault({ [PAGE]: frontmatter() + BODY + '\n'.repeat(150) });
  assert.ok(problems(long).some((f) => f.rule === 'size' && /lines/.test(f.message)));
  const diary = vault({ [PAGE]: `${frontmatter()}${BODY}\n## History\n\n- one (2026-10-01)\n- two (2026-10-02)\n` });
  assert.ok(problems(diary).some((f) => /History is longer/.test(f.message)));
});

test('the scanner is a seam: a replacement scanner is used instead of the built-in patterns', () => {
  const root = vault();
  const reports = checkVault(root, [PAGE], () => [{ rule: 'secret:custom', line: 1 }]);
  assert.deepEqual(reports[0]?.findings.map((f) => f.message), ['secret:custom shape (the match is not printed)']);
});

test('discovery reads Knowledge in full and only type: library files in Runbooks, one subfolder deep', () => {
  const root = vault({
    [`Projects/${REPO}/Knowledge/flows/harvest.md`]: frontmatter({ components: '[harvest-export]' }) + BODY,
    [`Projects/${REPO}/Knowledge/flows/deep/x.md`]: 'not read',
    [`Projects/${REPO}/Runbooks/restart.md`]: frontmatter({ kind: 'runbook' }) + BODY,
    [`Projects/${REPO}/Runbooks/old-notes.md`]: '# an old runbook note with no frontmatter\n',
  });
  assert.deepEqual(discover(root).sort(), [`Projects/${REPO}/Knowledge/flows/harvest.md`, PAGE, `Projects/${REPO}/Runbooks/restart.md`].sort());
});

test('a Knowledge page with no frontmatter fails the run instead of being skipped', () => {
  const root = vault({ [`Projects/${REPO}/Knowledge/loose.md`]: '# loose notes\n' });
  assert.equal(run(root).status, 1);
});

test('usage and read errors exit 2, never a pass', () => {
  assert.equal(run(vault(), '--bogus').status, 2);
  assert.equal(run(mkdtempSync(join(tmpdir(), 'empty-'))).status, 2);
  assert.equal(run(vault(), `Projects/${REPO}/Knowledge/missing.md`).status, 2);
  assert.equal(typeof parseOptions(['--vault']), 'string');
});

test('named pages are checked instead of discovery, with --json output', () => {
  const root = vault({ [`Projects/${REPO}/Knowledge/loose.md`]: '# loose\n' });
  const r = run(root, '--json', PAGE);
  assert.equal(r.status, 0);
  assert.deepEqual(JSON.parse(r.stdout), [{ path: PAGE, findings: [] }]);
});
