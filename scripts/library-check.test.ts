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
  assert.match(r.stdout, /secrets {2}secret:key-value shape/);
  assert.ok(!r.stdout.includes(secret) && !r.stderr.includes(secret));
});

test('a fact with no dated evidence, a bad kind and a missing field are each reported', () => {
  const root = vault({ [PAGE]: frontmatter({ kind: 'essay', 'verify-how': '' }) + BODY.replace(' (verified 2026-10-08, src/sync.ts:40)', '') });
  const messages = problems(root).map((f) => `${f.rule}: ${f.message}`).join('\n');
  assert.match(messages, /vocabulary: kind is not one of/);
  assert.match(messages, /frontmatter: missing required field "verify-how"/);
  assert.match(messages, /facts: a fact .* must end/);
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
  assert.equal(run(vault(), '--repo', 'no-such-repo').status, 2);
  assert.equal(run(vault(), `Projects/${REPO}/Knowledge`).status, 2);
  const empty = mkdtempSync(join(tmpdir(), 'nopages-'));
  mkdirSync(join(empty, 'Projects', REPO), { recursive: true });
  assert.equal(run(empty).status, 2);
});

test('named pages are checked instead of discovery, with --json output', () => {
  const root = vault({ [`Projects/${REPO}/Knowledge/loose.md`]: '# loose\n' });
  const r = run(root, '--json', PAGE);
  assert.equal(r.status, 0);
  assert.deepEqual(JSON.parse(r.stdout), [{ path: PAGE, findings: [] }]);
});

test('a duplicated Facts heading does not hide an undated fact', () => {
  const body = BODY.replace(' (verified 2026-10-08, src/sync.ts:40)', '') + '\n## Facts\n\n- A second section (verified 2026-10-08, notes).\n';
  assert.ok(problems(vault({ [PAGE]: frontmatter() + body })).some((f) => /a fact .* must end/.test(f.message)));
});

test('a secret-shaped value in a checked field is never echoed in a message or the json output', () => {
  const token = `${'ghp'}_${'a'.repeat(36)}`;
  const root = vault({ [PAGE]: frontmatter({ 'verified-at': token, kind: token, status: token, 'depends-on': `[${token}]`, components: `[${token}]` }) + BODY });
  const r = run(root, '--json');
  assert.equal(r.status, 1);
  assert.ok(!r.stdout.includes(token) && !r.stderr.includes(token));
  assert.ok(!run(root).stdout.includes(token));
});

test('paths and links cannot reach outside the vault', () => {
  const root = vault();
  const outside = mkdtempSync(join(tmpdir(), 'outside-'));
  writeFileSync(join(outside, 'o.md'), frontmatter() + BODY);
  assert.equal(run(root, join('..', outside.split('/').pop() as string, 'o.md')).status, 2);
  assert.equal(run(root, '--repo', '../..').status, 2);
  assert.ok(problems(vault({ [PAGE]: frontmatter({ 'depends-on': '[[../../x]]' }) + BODY })).some((f) => /depends-on .* does not resolve/.test(f.message)));
});

test('a body wikilink to no note fails the real CLI, naming the line; aliases, anchors, paths and code spans are handled', () => {
  const link = (l: string) => vault({ [PAGE]: `${frontmatter()}${BODY}\n## Links\n\n${l}\n`, [`Projects/${REPO}/DECISIONS.md`]: '# d\n', [`Projects/${REPO}/Research/orchard.md`]: '# r\n' });
  const bad = run(link('See [[nowhere-at-all]].'));
  assert.equal(bad.status, 1);
  assert.match(bad.stdout, /orchard-sync\.md:\d+ {2}links {2}link "nowhere-at-all" does not resolve/);
  for (const ok of ['[[DECISIONS]]', '[[DECISIONS#Heading|the log]]', '[[DECISIONS|the log]]', `[[Projects/${REPO}/Research/orchard]]`, `[[Projects/${REPO}/Research/orchard.md#x]]`, '[[#a heading on this page]]', '`[[nowhere-in-code]]`', '```\n[[nowhere-in-fence]]\n```']) {
    assert.equal(run(link(ok)).status, 0, ok);
  }
  for (const nope of ['[[nowhere#Heading|alias]]', '[[../../escape]]', `[[Projects/${REPO}/Research/missing]]`, '![[picture.png]]']) {
    assert.equal(run(link(nope)).status, 1, nope);
  }
});

test('every non-blank line under Facts needs evidence: numbered items, prose, nested bullets and a table row fail the real CLI; headings and blank lines do not', () => {
  const withFacts = (extra: string) => vault({ [PAGE]: `${frontmatter()}${BODY}${extra}` });
  for (const bad of ['1. numbered fact with no evidence\n', 'A prose sentence stating a fact.\n', '  - nested bullet, no evidence\n', '| a | table row |\n']) {
    const r = run(withFacts(bad));
    assert.equal(r.status, 1, bad);
    assert.match(r.stdout, /facts {2}a fact .* must end/, bad);
  }
  const ok = run(withFacts('\n### A sub-heading\n\n1. A numbered fact (verified 2026-10-08, src/sync.ts:41).\nProse fact (verified 2026-10-08, src/sync.ts:42).\n'));
  assert.equal(ok.status, 0, ok.stdout);
  assert.ok(problems(vault({ [PAGE]: `${frontmatter()}# T\n\nRead when: x.\n\n## Facts\n\n` })).some((f) => /no fact/.test(f.message)));
});

test('a bare token with no key word fails the real CLI as high-entropy and is never printed; a sha, a uuid and a vault path in the same spot pass', () => {
  const token = 'aB3dE5gH7jK9mN2pQ4sT6vW8xZ1cF3hJ';
  const withFact = (evidence: string) => vault({ [PAGE]: `${frontmatter()}${BODY}- A claim (verified 2026-10-08, ${evidence}).\n` });
  const bad = run(withFact(token));
  assert.equal(bad.status, 1);
  assert.match(bad.stdout, /secrets {2}secret:high-entropy shape/);
  assert.ok(!bad.stdout.includes(token) && !bad.stderr.includes(token));
  for (const ok of ['488b6fe0a1b2c3d4e5f60718293a4b5c6d7e8f90', '3f2b8c1e-5d4a-4b7e-9c10-a1b2c3d4e5f6', `Projects/${REPO}/Research/orchard-sync-nightly-schedule-and-retries`, 'src/sync.ts:40-52']) {
    assert.equal(run(withFact(ok)).status, 0, ok);
  }
});
