// Run: node --test scripts/pr-leaks.test.ts
// The search terms are assembled from fragments so this file does not trip the gate it tests.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { ALLOW, addedLines, leakCheck, parseTerms, scanLine, type Allow } from './pr-leaks.ts';

const ORG = ['ar', 'ya'].join('');
const Org = ORG[0]!.toUpperCase() + ORG.slice(1);
const TYPO = ['ay', 'ra'].join('');
const OWNER = ['ja', 'ck'].join('');
const Owner = OWNER[0]!.toUpperCase() + OWNER.slice(1);
const homePath = (user: string, rest = 'notes/x.md'): string => `/${'Users'}/${user}/${rest}`;
const linuxHome = (user: string): string => `/${'home'}/${user}/work`;
const winHome = (user: string): string => `C:\\${'Users'}\\${user}\\work`;

const SCRIPT = new URL('./pr-leaks.ts', import.meta.url).pathname;
const CI_GATES = new URL('./ci-gates.ts', import.meta.url).pathname;
const PR_OPEN = new URL('./pr-open.ts', import.meta.url).pathname;

const labels = (text: string, terms = '', path = 'src/a.ts', allow: Allow[] = []): string[] => scanLine(path, text, parseTerms(terms).terms, allow);

test('org term: matches at a word start in any case, and as a camelCase part, but not inside other words', () => {
  for (const hit of [`${Org}Obsidian`, `${ORG}-scraper`, `${ORG.toUpperCase()}_TOOL`, `see ${Org}.`, `my${Org}Helper`, `the ${TYPO} repo`, `${Org[0]}${TYPO.slice(1)}-x`.replace(/^./, 'A')]) {
    assert.deepEqual(labels(hit), ['org-term'], hit);
  }
  for (const clean of ['const libraryArgs = []', 'a primary argument', 'Libraryacme widgets', 'binaryArgs']) assert.deepEqual(labels(clean), [], clean);
});

test('person name: the first name matches on its own, never inside the repo owner handle or another word', () => {
  for (const hit of [`ask ${Owner}`, `${Owner}'s setup`, `${OWNER}: do it`, `${OWNER.toUpperCase()}_RULE`, `(${OWNER})`]) assert.deepEqual(labels(hit), ['person-name'], hit);
  for (const clean of [`${OWNER}reichert/the-maestro`, `${OWNER}son`, `hi${OWNER}`, `${OWNER}pot`]) assert.deepEqual(labels(clean), [], clean);
});

test('home path: a real-looking user directory hits on every platform, a placeholder does not', () => {
  for (const hit of [homePath('alice'), linuxHome('bob'), winHome('carol'), `cd ${homePath('alice', '')}`, `"${linuxHome('dev')}"`]) assert.deepEqual(labels(hit), ['home-path'], hit);
  for (const clean of [homePath('me'), homePath('<name>'), homePath('$USER'), linuxHome('user'), winHome('username'), homePath('example'), 'src/lib/home/config.ts', '../home/x/y.ts', 'a/Users/x']) assert.deepEqual(labels(clean), [], clean);
});

test('personal root: a home-relative dev container directory hits', () => {
  const root = (base: string): string => `${base}/dev-${'env'}/skills/x`;
  assert.deepEqual(labels(root('~')), ['personal-root']);
  assert.deepEqual(labels(root('$HOME')), ['personal-root']);
  assert.deepEqual(labels(root('${HOME}')), ['personal-root']);
  assert.deepEqual(labels(`join(home, 'dev-${'env'}')`), []);
});

test('configured terms: case-insensitive whole words, spaces, hyphens, underscores and none interchangeable, comments ignored', () => {
  const raw = 'Acme Care, Zed Health\n# a comment line\n\nQuux-Co';
  for (const hit of ['Acme Care visit', 'acme-care', 'AcmeCare', 'ACME_CARE_ID', 'acme.care', 'host=acme_care.example', 'zed health', 'quux co', 'Quux.Co', '(acme care)', 'x=Acme-Care;']) assert.deepEqual(labels(hit, raw), ['configured-term'], hit);
  for (const clean of ['acme', 'a comment line', 'care for acme']) assert.deepEqual(labels(clean, raw), [], clean);
});

test('configured terms: a term inside a longer word does not match, as its own word or a camelCase step it does', () => {
  const raw = 'Acme Care, Quux-Co';
  for (const clean of ['acmecarer', 'xquuxcoy', 'the acme carefully', 'acme care2', 'getacmecareid', 'Acmes Care']) assert.deepEqual(labels(clean, raw), [], clean);
  for (const hit of ['acme care', 'Acme-Care', 'acme.care', 'AcmeCare', 'ACME CARE', 'a Quux Co b', 'quux_co', 'getAcmeCareId', 'useAcmeCare()', 'AcmeCareService', 'x = acmeCare', 'fooQuuxCoBar']) assert.deepEqual(labels(hit, raw), ['configured-term'], hit);
});

test('configured terms: a ~ prefix opts one term into substring matching, and still has the minimum length', () => {
  assert.deepEqual(labels('xQuuxCoy', '~Quux-Co'), ['configured-term']);
  assert.deepEqual(labels('xQuuxCoy', 'Quux-Co'), []);
  assert.deepEqual(labels('Acme Carefully', '~Acme Care'), ['configured-term']);
  assert.match(parseTerms('~ab').error, /shorter than 3/);
});

test('configured terms: a regex character in a term is literal', () => {
  assert.deepEqual(labels('c++x here', 'c++x'), ['configured-term']);
  assert.deepEqual(labels('ccx here', 'c.x'), []);
});

test('configured terms: a term without separators finds the spaced form too', () => {
  assert.deepEqual(labels('Widget Co ships', 'widgetco'), ['configured-term']);
  assert.deepEqual(labels('widget-co', 'widgetco'), ['configured-term']);
});

test('configured terms: a term too short to mean anything is refused, not matched everywhere', () => {
  assert.match(parseTerms('Acme, ab').error, /shorter than 3/);
  assert.deepEqual(parseTerms('Acme, ab').terms, []);
  assert.equal(parseTerms('').error, '');
  assert.deepEqual(parseTerms('  \n # c\n').terms, []);
});

test('allowlist: blanks only the allowed text for its label and path, so another hit on the line still fails', () => {
  const allow: Allow[] = [{ label: 'person-name', path: /^docs\//, text: new RegExp(`Needs ${Owner}`, 'g'), reason: 'fixture' }];
  assert.deepEqual(labels(`Needs ${Owner} (1)`, '', 'docs/a.md', allow), []);
  assert.deepEqual(labels(`Needs ${Owner} (1)`, '', 'src/a.ts', allow), ['person-name'], 'another path is not covered');
  assert.deepEqual(labels(`Needs ${Owner}, and ${Owner} reviews`, '', 'docs/a.md', allow), ['person-name'], 'a second use on the line fails');
  assert.deepEqual(labels(`Needs ${Owner} in ${homePath('alice')}`, '', 'docs/a.md', allow), ['home-path'], 'another label on the line fails');
  assert.deepEqual(labels(`Needs ${Owner}`, 'needs', 'docs/a.md', allow), ['configured-term'], 'a configured term is never allowlisted');
});

test('the shipped allowlist is narrow: every entry has a reason and a bounded path or phrase', () => {
  for (const a of ALLOW) {
    assert.ok(a.reason.length > 20, `reason: ${a.text}`);
    assert.ok(a.text.global, `a global blanking pattern: ${a.text}`);
    assert.ok(a.text.source.length > 6, `not a catch-all: ${a.text}`);
  }
  assert.deepEqual(labels(`${Owner} said so`, '', 'README.md', ALLOW), ['person-name'], 'plain prose is not allowlisted');
  assert.deepEqual(labels(`told-by-${OWNER}`, '', 'x.md', ALLOW), []);
  assert.deepEqual(labels(`Paste blocks for ${Owner} (1)`, '', 'x.md', ALLOW), []);
  assert.deepEqual(labels(`--lesson "${OWNER}: x"`, '', 'src/new-file.ts', ALLOW), ['person-name'], 'a retro lesson source is allowed only in the retro files');
  assert.deepEqual(labels(`--lesson "${OWNER}: x"`, '', 'scripts/lib/journal/agent-retro.ts', ALLOW), []);
});

test('addedLines: only added lines, with new-side numbers; deletions, context and headers are not read', () => {
  const diff = [
    'diff --git a/x.md b/x.md', '--- a/x.md', '+++ b/x.md', '@@ -3,2 +3,3 @@', '-old', '+new one', ' context', '+new two',
    'diff --git a/gone.md b/gone.md', 'deleted file mode 100644', '--- a/gone.md', '+++ /dev/null', '@@ -1 +0,0 @@', '-bye',
    'diff --git a/y.md b/y.md', '--- a/y.md', '+++ b/y.md', '@@ -0,0 +7 @@', '+++ not a header', '\\ No newline at end of file',
  ].join('\n');
  assert.deepEqual(addedLines(diff), [
    { path: 'x.md', line: 3, text: 'new one' }, { path: 'x.md', line: 5, text: 'new two' }, { path: 'y.md', line: 7, text: '++ not a header' },
  ]);
});

// ---- against real git repos ----

const git = (repo: string, ...args: string[]): void => { const r = spawnSync('git', ['-C', repo, ...args], { encoding: 'utf8' }); assert.equal(r.status, 0, r.stderr); };
const put = (repo: string, path: string, text: string): void => { mkdirSync(dirname(join(repo, path)), { recursive: true }); writeFileSync(join(repo, path), text); };

/** main holds `base`; feature adds `change`. A real origin url is set only when `slug` is given, rewritten to a local path so no fetch touches the network. */
function repoWith(base: Record<string, string>, change: Record<string, string>, slug = ''): string {
  const repo = mkdtempSync(join(tmpdir(), 'pr-leaks-'));
  git(repo, 'init', '-q', '-b', 'main');
  git(repo, 'config', 'user.email', 'test@example.com');
  git(repo, 'config', 'user.name', 'Test');
  git(repo, 'config', 'core.hooksPath', '/dev/null');
  for (const [p, t] of Object.entries({ 'README.keep': 'keep\n', ...base })) put(repo, p, t);
  git(repo, 'add', '--all');
  git(repo, 'commit', '-q', '-m', 'base');
  git(repo, 'checkout', '-q', '-b', 'feature');
  for (const [p, t] of Object.entries(change)) put(repo, p, t);
  git(repo, 'add', '--all');
  git(repo, 'commit', '-q', '-m', 'change');
  if (slug) {
    git(repo, 'remote', 'add', 'origin', `https://github.com/${slug}.git`);
    git(repo, 'config', `url.${join(repo, 'no-such-remote')}.insteadOf`, `https://github.com/${slug}.git`);
  }
  return repo;
}

const check = (repo: string, over: Partial<Parameters<typeof leakCheck>[0]> = {}) => leakCheck({ repo, base: 'main', head: 'feature', termsRaw: '', strict: false, ...over });

test('a hit fails with file:line and a label, never the matched text', () => {
  const repo = repoWith({}, { 'docs/a.md': `line one\nsee ${homePath('alice')} here\n`, 'src/b.ts': `// ${Org}\n` });
  const r = check(repo);
  assert.deepEqual(r.problems.sort(), ['docs/a.md:2 home-path', 'src/b.ts:1 org-term']);
  assert.ok(!r.problems.join(' ').toLowerCase().includes('alice'));
});

test('a clean diff passes', () => {
  const r = check(repoWith({}, { 'src/a.ts': 'export const x = 1;\n', 'docs/a.md': 'Generic words only.\n' }));
  assert.deepEqual(r.problems, []);
});

test('only added lines count: a leak that was already there and a deleted one do not fail', () => {
  const repo = repoWith({ 'old.md': `${Org} was here\n`, 'gone.md': `${Org}\n` }, { 'old.md': `${Org} was here\nand a clean line\n`, 'gone.md': 'clean now\n' });
  assert.deepEqual(check(repo).problems, []);
});

test('an allowlisted line passes while the same text elsewhere fails', () => {
  const repo = repoWith({}, { 'docs/a.md': `**Needs ${Owner}**\n`, 'docs/b.md': `${Owner} said\n` });
  assert.deepEqual(check(repo).problems, ['docs/b.md:1 person-name']);
});

test('a configured customer term fails, names the place and label, and does not echo the term', () => {
  const repo = repoWith({}, { 'src/a.ts': "const org = 'acme-care';\n", 'src/b.ts': 'ok\n' });
  const r = check(repo, { termsRaw: 'Acme Care\nZed Health' });
  assert.deepEqual(r.problems, ['src/a.ts:1 configured-term']);
  assert.ok(!r.problems.join(' ').toLowerCase().includes('acme'));
  assert.deepEqual(check(repo, { termsRaw: 'Zed Health' }).problems, []);
});

test('the PR title and body are scanned too', () => {
  const repo = repoWith({}, { 'a.txt': 'fine\n' });
  const r = check(repo, { title: `Fix for Acme Care`, body: `ok\nthanks ${Owner}\n`, termsRaw: 'Acme Care' });
  assert.deepEqual(r.problems, ['PR title:1 configured-term', 'PR body:2 person-name']);
});

test('missing terms locally: built-ins still run and the note says customer names were not checked', () => {
  const r = check(repoWith({}, { 'a.txt': 'fine\n' }));
  assert.deepEqual(r.problems, []);
  assert.match(r.notes.join(' '), /customer names were NOT checked/);
});

test('missing terms in CI: fails closed, naming the secret, unless built-ins-only is chosen explicitly and then says so', () => {
  const repo = repoWith({}, { 'a.txt': 'fine\n' });
  const prev = process.env.LEAK_GATE_BUILTIN_ONLY;
  try {
    delete process.env.LEAK_GATE_BUILTIN_ONLY;
    const closed = check(repo, { strict: true });
    assert.equal(closed.problems.length, 1);
    assert.match(closed.problems[0]!, /LEAK_TERMS is not set/);
    process.env.LEAK_GATE_BUILTIN_ONLY = '0';
    assert.equal(check(repo, { strict: true }).problems.length, 1, 'only 1 opts out');
    process.env.LEAK_GATE_BUILTIN_ONLY = '1';
    const open = check(repo, { strict: true });
    assert.deepEqual(open.problems, []);
    assert.match(open.notes.join(' '), /customer names were NOT checked/);
    assert.equal(check(repoWith({}, { 'a.txt': `${Org}\n` }), { strict: true }).problems.length, 1, 'built-ins still apply');
  } finally { if (prev === undefined) delete process.env.LEAK_GATE_BUILTIN_ONLY; else process.env.LEAK_GATE_BUILTIN_ONLY = prev; }
});

test('an unusable term list and an unreadable diff both fail instead of passing', () => {
  const repo = repoWith({}, { 'a.txt': 'fine\n' });
  assert.match(check(repo, { termsRaw: 'ab' }).problems[0]!, /shorter than 3/);
  assert.match(check(repo, { base: 'no-such-ref' }).problems[0]!, /git diff failed/);
});

test('--tree scans every tracked file at head, so existing text is visible', () => {
  const repo = repoWith({ 'old.md': `${Org}\n` }, { 'new.md': 'clean\n' });
  assert.deepEqual(check(repo, { tree: true }).problems, ['old.md:1 org-term']);
});

// ---- the two enforcement points ----

const env = (home: string, extra: Record<string, string> = {}): NodeJS.ProcessEnv => ({ PATH: process.env.PATH, HOME: home, GIT_TERMINAL_PROMPT: '0', GIT_ALLOW_PROTOCOL: 'file', MAESTRO_LOCAL_CONFIG: '', ...extra });
const tmp = (name: string): string => mkdtempSync(join(tmpdir(), `pr-leaks-${name}-`));
const BODY = ['## Context', 'Why this change exists.', '## Reviewer guide', 'Start with the new file.', '## Risk and blast radius', 'Risk: low - fixture only.', '## Rollback / flag', 'Revert the commit.', '## How to verify locally', '```bash', 'node --test scripts/pr-leaks.test.ts', '```', ''].join('\n');
const bodyFile = (text = BODY): string => { const p = join(tmp('body'), 'body.md'); writeFileSync(p, text); return p; };
const configFile = (lines: string): string => { const p = join(tmp('cfg'), 'config.md'); writeFileSync(p, `\`\`\`maestro-config\n${lines}\n\`\`\`\n`); return p; };

const gates = (repo: string, extra: Record<string, string> = {}) =>
  spawnSync(process.execPath, [CI_GATES, '--repo', repo, '--base', 'main', '--head', 'feature', '--title', 'Add a file', '--body-file', bodyFile()], { encoding: 'utf8', env: env(tmp('home'), extra), timeout: 30_000 });

test('ci-gates: a hit fails the job with file:line on stderr and leaks: FAIL on stdout, and a clean diff passes', () => {
  const dirty = gates(repoWith({}, { 'src/a.ts': `// ${Org}\n` }), { LEAK_TERMS: 'Acme Care' });
  assert.equal(dirty.status, 1, dirty.stdout + dirty.stderr);
  assert.match(dirty.stdout, /^leaks: FAIL$/m);
  assert.match(dirty.stderr, /leaks: src\/a\.ts:1 org-term/);
  const clean = gates(repoWith({}, { 'src/a.ts': 'export const a = 1;\n' }), { LEAK_TERMS: 'Acme Care' });
  assert.equal(clean.status, 0, clean.stdout + clean.stderr);
  assert.match(clean.stdout, /^leaks: PASS$/m);
});

test('ci-gates: a configured customer term in LEAK_TERMS fails, and the log never carries it', () => {
  const r = gates(repoWith({}, { 'src/a.ts': "const c = 'Acme Care';\n" }), { LEAK_TERMS: 'Acme Care' });
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stderr, /leaks: src\/a\.ts:1 configured-term/);
  assert.ok(!(r.stdout + r.stderr).toLowerCase().includes('acme'));
});

test('ci-gates: LEAK_TERMS unset fails loudly; built-ins-only must be chosen and is announced', () => {
  const repo = repoWith({}, { 'src/a.ts': 'export const a = 1;\n' });
  const unset = gates(repo);
  assert.equal(unset.status, 1, unset.stdout + unset.stderr);
  assert.match(unset.stdout, /^leaks: FAIL$/m);
  assert.match(unset.stderr, /LEAK_TERMS is not set/);
  const chosen = gates(repo, { LEAK_GATE_BUILTIN_ONLY: '1' });
  assert.equal(chosen.status, 0, chosen.stdout + chosen.stderr);
  assert.match(chosen.stderr, /customer names were NOT checked/);
});

test('pr-open: refuses a hit in this skill repo before gh runs, and says where', () => {
  const repo = repoWith({}, { 'src/a.ts': `// ${Org}\n` }, `${['jackreichert', 'the-maestro'].join('/')}`);
  const r = spawnSync(process.execPath, [PR_OPEN, '--repo', repo, '--base', 'main', '--head', 'feature', '--title', 'T', '--body-file', bodyFile(), '--dry-run'], { encoding: 'utf8', env: env(repo), timeout: 30_000 });
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stderr, /pr-open: leaks: src\/a\.ts:1 org-term/);
  assert.match(r.stderr, /refused, the PR adds text that must not be in a public skill/);
  assert.doesNotMatch(r.stdout, /pr create/);
});

test('pr-open: a clean diff opens, noting built-ins only when no leak_terms are configured; a configured term refuses', () => {
  const slug = ['jackreichert', 'the-maestro'].join('/');
  const repo = repoWith({}, { 'src/a.ts': "const c = 'Zed Health';\n" }, slug);
  const clean = spawnSync(process.execPath, [PR_OPEN, '--repo', repo, '--base', 'main', '--head', 'feature', '--title', 'T', '--body-file', bodyFile(), '--dry-run'], { encoding: 'utf8', env: env(repo), timeout: 30_000 });
  assert.equal(clean.status, 0, clean.stdout + clean.stderr);
  assert.match(clean.stderr, /customer names were NOT checked/);
  const cfg = configFile('leak_terms: Acme Care, Zed Health');
  const refused = spawnSync(process.execPath, [PR_OPEN, '--repo', repo, '--base', 'main', '--head', 'feature', '--title', 'T', '--body-file', bodyFile(), '--dry-run'], { encoding: 'utf8', env: env(repo, { MAESTRO_LOCAL_CONFIG: cfg }), timeout: 30_000 });
  assert.equal(refused.status, 1, refused.stdout + refused.stderr);
  assert.match(refused.stderr, /pr-open: leaks: src\/a\.ts:1 configured-term/);
  assert.ok(!(refused.stdout + refused.stderr).toLowerCase().includes('zed'));
});

test('pr-open: another repo is not gated unless leak_gate_repos names it', () => {
  const repo = repoWith({}, { 'src/a.ts': `// ${Org}\n` }, 'example/other-tool');
  const args = [PR_OPEN, '--repo', repo, '--base', 'main', '--head', 'feature', '--title', 'T', '--body-file', bodyFile(), '--dry-run'];
  const off = spawnSync(process.execPath, args, { encoding: 'utf8', env: env(repo), timeout: 30_000 });
  assert.equal(off.status, 0, off.stdout + off.stderr);
  const on = spawnSync(process.execPath, args, { encoding: 'utf8', env: env(repo, { MAESTRO_LOCAL_CONFIG: configFile('leak_gate_repos: example/*') }), timeout: 30_000 });
  assert.equal(on.status, 1, on.stdout + on.stderr);
});

test('the CLI scans a tree and exits non-zero on a hit', () => {
  const repo = repoWith({ 'old.md': `${Org}\n` }, { 'new.md': 'clean\n' });
  const r = spawnSync(process.execPath, [SCRIPT, '--repo', repo, '--tree', '--base', 'x'], { encoding: 'utf8', env: env(repo) });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /old\.md:1 org-term/);
  assert.equal(spawnSync(process.execPath, [SCRIPT], { encoding: 'utf8' }).status, 2);
});

test('portable: the scanner imports only node built-ins, so a sibling repo can copy it with this test', () => {
  const imports = [...readFileSync(SCRIPT, 'utf8').matchAll(/^import .* from '([^']+)'/gm)].map((m) => m[1]);
  assert.ok(imports.length > 0 && imports.every((i) => i!.startsWith('node:')), imports.join(', '));
});

test('the CLI reads terms from --terms-file and LEAK_TERMS, and --strict fails closed without either', () => {
  const repo = repoWith({}, { 'src/a.ts': "const c = 'Acme Care';\n" });
  const run = (extra: string[], e: Record<string, string> = {}) => spawnSync(process.execPath, [SCRIPT, '--repo', repo, '--base', 'main', '--head', 'feature', ...extra], { encoding: 'utf8', env: env(repo, e) });
  const file = join(tmp('terms'), 'terms.txt');
  writeFileSync(file, 'Acme Care\n');
  assert.equal(run(['--terms-file', file]).status, 1);
  assert.equal(run([], { LEAK_TERMS: 'Acme Care' }).status, 1);
  assert.equal(run([]).status, 0, 'loose mode with no terms passes with a note');
  const strict = run(['--strict']);
  assert.equal(strict.status, 1);
  assert.match(strict.stderr, /LEAK_TERMS is not set/);
  assert.equal(run(['--terms-file', '/nonexistent/x']).status, 2);
});

test('a file git calls binary (a NUL byte, or UTF-16) is still scanned', () => {
  const repo = repoWith({}, { 'a.txt': 'x\n' });
  git(repo, 'checkout', '-q', 'main');
  git(repo, 'checkout', '-q', '-b', 'bin');
  writeFileSync(join(repo, 'nul.txt'), Buffer.concat([Buffer.from('Acme Care\n'), Buffer.from([0])]));
  writeFileSync(join(repo, 'wide.txt'), Buffer.from('\ufeffAcme Care\n', 'utf16le'));
  git(repo, 'add', '--all');
  git(repo, 'commit', '-q', '-m', 'bin');
  const r = check(repo, { head: 'bin', termsRaw: 'Acme Care' });
  assert.deepEqual(r.problems.sort(), ['nul.txt:1 configured-term', 'wide.txt:1 configured-term']);
});

test('a path is published too: a new file or a rename whose path carries a name hits at line 0', () => {
  const repo = repoWith({ 'old.md': 'clean\n' }, { 'dir/acme-care notes.md': 'clean\n' });
  git(repo, 'mv', 'old.md', `${Org}-notes.md`);
  git(repo, 'commit', '-q', '-m', 'rename');
  const r = check(repo, { termsRaw: 'Acme Care' });
  assert.deepEqual(r.problems.sort(), [`${Org}-notes.md:0 org-term`, 'dir/acme-care notes.md:0 configured-term']);
});

test('paths: deleting a file whose name carries a term passes, and a quoted file name carrying a term fails', () => {
  const repo = repoWith({ 'old acme care.md': 'clean\n' }, { 'x.md': 'x\n' });
  git(repo, 'checkout', '-q', 'main');
  git(repo, 'checkout', '-q', '-b', 'del');
  git(repo, 'rm', '-q', 'old acme care.md');
  put(repo, 'say "acme care".md', 'clean\n');
  put(repo, 'fine.md', 'clean\n');
  git(repo, 'add', '--all');
  git(repo, 'commit', '-q', '-m', 'del and add');
  assert.deepEqual(check(repo, { head: 'del', termsRaw: 'Acme Care' }).problems, ['say "acme care".md:0 configured-term']);
  git(repo, 'checkout', '-q', 'main');
  git(repo, 'checkout', '-q', '-b', 'only-del');
  git(repo, 'rm', '-q', 'old acme care.md');
  git(repo, 'commit', '-q', '-m', 'only delete');
  assert.deepEqual(check(repo, { head: 'only-del', termsRaw: 'Acme Care' }).problems, []);
});
