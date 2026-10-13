// Run: node --test scripts/review-note.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gate, newNote, noteProblems, repoName, reviewsDir } from './review-note.ts';

const SCRIPT = new URL('./review-note.ts', import.meta.url).pathname;
const GLOBS = ['example/*'];
const git = (repo: string, ...args: string[]): string => {
  const r = spawnSync('git', ['-C', repo, ...args], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout.trim();
};

/** A repo with an example/widgets origin (fetch url) whose pushes go to a local bare repo, plus an empty vault. */
function fixture(): { repo: string; vault: string; bare: string } {
  const root = mkdtempSync(join(tmpdir(), 'rnote-'));
  const repo = join(root, 'checkout');
  const bare = join(root, 'remote.git');
  const vault = join(root, 'vault');
  mkdirSync(repo); mkdirSync(vault);
  git(root, 'init', '-q', '--bare', bare);
  git(repo, 'init', '-q', '-b', 'feat/x');
  git(repo, 'config', 'user.email', 'test@example.com');
  git(repo, 'config', 'user.name', 'Test');
  git(repo, 'config', 'core.hooksPath', '/dev/null');
  git(repo, 'remote', 'add', 'origin', 'https://github.com/example/widgets.git');
  git(repo, 'remote', 'set-url', '--push', 'origin', bare);
  commit(repo, 'a');
  return { repo, vault, bare };
}
const commit = (repo: string, name: string): void => { writeFileSync(join(repo, name), `${name}\n`); git(repo, 'add', name); git(repo, 'commit', '-q', '-m', name); };
const noteText = (sha: string, naming = '- scripts/list-teams.ts: renamed `counts` to `playersPerTeam`'): string => `---\ntype: review\nhead: ${sha}\n---\n\n## Naming pass\n${naming}\n\n## Findings\nnone\n`;
/** Write a note into the vault under the convention's file name. */
function writeNote(f: { repo: string; vault: string }, sha: string, text = noteText(sha), name = `2026-10-13-x-review-${sha.slice(0, 7)}.md`): string {
  const dir = reviewsDir(f.vault, f.repo);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, name);
  writeFileSync(path, text);
  return path;
}
const cli = (args: string[], cfg = 'review_note_repos: example/*') => {
  const conf = join(mkdtempSync(join(tmpdir(), 'rnote-cfg-')), 'config.md');
  writeFileSync(conf, `\`\`\`maestro-config\n${cfg}\n\`\`\`\n`);
  return spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8', env: { ...process.env, MAESTRO_LOCAL_CONFIG: conf } });
};

test('the vault folder is named for the origin repo, not the checkout directory', () => {
  const f = fixture();
  assert.equal(repoName(f.repo), 'widgets');
  assert.ok(reviewsDir(f.vault, f.repo).endsWith('/Projects/widgets/Reviews'));
});

test('noteProblems: needs the full head sha and a Naming pass with real content', () => {
  const sha = 'a'.repeat(40);
  assert.deepEqual(noteProblems(noteText(sha), sha), []);
  assert.match(noteProblems(noteText('b'.repeat(40)), sha).join(), /head is b+, not a+/);
  assert.match(noteProblems('no frontmatter\n## Naming pass\nok\n', sha).join(), /head is missing/);
  assert.match(noteProblems(`---\nhead: ${sha}\n---\n## Findings\nx\n`, sha).join(), /no "## Naming pass" section/);
  for (const empty of ['', 'TBD', 'n/a', '- none', '<every touched file>', '<!-- later -->']) {
    assert.match(noteProblems(noteText(sha, empty), sha).join(), /empty or still a placeholder/, JSON.stringify(empty));
  }
  assert.deepEqual(noteProblems(`---\nhead: ${sha}\n---\n## Naming pass\nchecked a.ts\n## Findings\n`, sha), [], 'a later heading ends the section');
});

test('gate: off outside the listed repos, and with an empty list', () => {
  const f = fixture();
  assert.equal(gate(f.repo, '', f.vault, []).applies, false);
  assert.equal(gate(f.repo, '', f.vault, ['other/*']).ok, true);
});

test('gate: no note refuses; a valid note for exactly the head passes; a new commit voids it', () => {
  const f = fixture();
  const none = gate(f.repo, '', f.vault, GLOBS, '');
  assert.equal(none.ok, false);
  assert.match(none.problems.join(), /no note named \*-review-[0-9a-f]{7}\.md/);
  const sha = git(f.repo, 'rev-parse', 'HEAD');
  const path = writeNote(f, sha);
  const ok = gate(f.repo, '', f.vault, GLOBS, '');
  assert.equal(ok.ok, true);
  assert.equal(ok.note, path);
  commit(f.repo, 'b');
  assert.equal(gate(f.repo, '', f.vault, GLOBS, '').ok, false, 'the review was of the old head');
});

test('gate: a note whose file name matches but whose frontmatter names another sha does not count', () => {
  const f = fixture();
  const sha = git(f.repo, 'rev-parse', 'HEAD');
  writeNote(f, sha, noteText('c'.repeat(40)));
  const r = gate(f.repo, '', f.vault, GLOBS, '');
  assert.equal(r.ok, false);
  assert.match(r.problems.join(), /frontmatter head is c+/);
});

test('gate: an unconfigured vault refuses rather than passing', () => {
  const f = fixture();
  assert.equal(gate(f.repo, '', '', GLOBS, '').ok, false);
});

test('new: writes a stub for the head that does not pass until the Naming pass is filled in', () => {
  const f = fixture();
  const sha = git(f.repo, 'rev-parse', 'HEAD');
  const path = newNote(f.repo, '', f.vault, 'my feature', '2026-10-13');
  assert.ok(path.endsWith(`2026-10-13-my-feature-review-${sha.slice(0, 7)}.md`));
  assert.equal(gate(f.repo, '', f.vault, GLOBS, '').ok, false, 'a stub is not a review');
  assert.throws(() => newNote(f.repo, '', f.vault, 'my feature', '2026-10-13'), /already exists/);
  writeFileSync(path, noteText(sha));
  assert.equal(gate(f.repo, '', f.vault, GLOBS, '').ok, true);
});

test('cli push: refuses and pushes nothing without a note, pushes once the note names the head', () => {
  const f = fixture();
  const refused = cli(['push', '--repo', f.repo, '--vault', f.vault]);
  assert.equal(refused.status, 1, refused.stderr);
  assert.match(refused.stderr, /the push needs a valid vault Reviews note/);
  assert.equal(spawnSync('git', ['-C', f.bare, 'branch', '--list', 'feat/x'], { encoding: 'utf8' }).stdout.trim(), '', 'nothing reached the remote');
  writeNote(f, git(f.repo, 'rev-parse', 'HEAD'));
  const pushed = cli(['push', '--repo', f.repo, '--vault', f.vault]);
  assert.equal(pushed.status, 0, pushed.stderr);
  assert.match(git(f.bare, 'branch', '--list', 'feat/x'), /feat\/x/);
});

test('cli push: a repo outside the gate pushes with no note, and the gate cannot be set from the environment', () => {
  const f = fixture();
  assert.equal(cli(['push', '--repo', f.repo, '--vault', f.vault], 'review_note_repos: other/*').status, 0);
  const env = spawnSync(process.execPath, [SCRIPT, 'check', '--repo', f.repo, '--vault', f.vault], { encoding: 'utf8', env: { ...process.env, MAESTRO_LOCAL_CONFIG: '', MAESTRO_REVIEW_NOTE_REPOS: 'example/*' } });
  assert.equal(env.status, 0, 'env alone does not turn the gate on');
  assert.match(env.stdout, /does not apply/);
});

test('cli: bad usage exits 2 and check on a refused head exits 1', () => {
  assert.equal(cli(['check']).status, 2);
  const f = fixture();
  const r = cli(['check', '--repo', f.repo, '--vault', f.vault]);
  assert.equal(r.status, 1);
});

test('reviewer checklist: when one is configured the note also needs a filled Reviewer checklist section; a stub does not pass', () => {
  const f = fixture();
  const sha = git(f.repo, 'rev-parse', 'HEAD');
  const list = '/overlay/reviewer-checklist.md';
  assert.match(noteProblems(noteText(sha), sha, list).join(), /no "## Reviewer checklist" section/);
  assert.deepEqual(noteProblems(`${noteText(sha)}\n## Reviewer checklist\n- naming: pass\n- migrations: n/a, no schema change\n`, sha, list), []);
  assert.match(noteProblems(`${noteText(sha)}\n## Reviewer checklist\n<!-- read ${list} first -->\n<each item>\n`, sha, list).join(), /Reviewer checklist" section is empty/);
  writeNote(f, sha);
  assert.equal(gate(f.repo, '', f.vault, GLOBS, '').ok, true, 'no checklist configured, no section needed');
  assert.equal(gate(f.repo, '', f.vault, GLOBS, list).ok, false, 'checklist configured, section missing');
  const stub = newNote(f.repo, '', f.vault, 'second', '2026-10-14', list);
  assert.match(readFileSync(stub, 'utf8'), /read \/overlay\/reviewer-checklist\.md first/);
  assert.equal(gate(f.repo, '', f.vault, GLOBS, list).ok, false);
});
