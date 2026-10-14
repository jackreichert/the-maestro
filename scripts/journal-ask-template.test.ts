// Run: node --test scripts/journal-ask-template.test.ts
// Hermetic: a temp vault and a temp HOME; nothing is sent anywhere.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mergeTemplate, parseAskBody, parseLink, splitOption, validateAskTemplate } from './lib/journal/ask-template.ts';
import { envAskTemplate } from './lib/journal/env-asks.ts';
import { unledgeredDecisions } from './lib/continuous-roll.ts';
import { ASK_TEMPLATE } from './lib/ask-template-fixture.ts';

process.env.MAESTRO_LOCAL_CONFIG = '';
const SCRIPT = new URL('./journal.ts', import.meta.url).pathname;
const MARKS = ['--model', 'Test Model', '--used', 'skill:the-maestro'];
const SEARCHED = ['--searched', 'the README and the ledger'];

function fixture() {
  const vault = mkdtempSync(join(tmpdir(), 'ask-tpl-'));
  const home = mkdtempSync(join(tmpdir(), 'ask-tpl-home-'));
  const run = (...a: string[]) => spawnSync(process.execPath, [SCRIPT, ...a, '--vault', vault, '--project', 'test-proj'], {
    encoding: 'utf8',
    env: { ...process.env, HOME: home, MAESTRO_NOTIFY_COMMAND: '/usr/bin/true', VAULT_ROOT: '', LEDGER_ROOT: '', MAESTRO_UPDATE_CHECK: 'off', MAESTRO_STATUS_DIR: join(vault, 'status'), MAESTRO_EVENT_DIR: join(vault, 'Events') },
  });
  const ledger = join(vault, 'Projects', 'test-proj', 'Journal', 'ledger.jsonl');
  const rows = () => (existsSync(ledger) ? readFileSync(ledger, 'utf8').trim().split('\n').map((l) => JSON.parse(l) as Record<string, unknown>) : []);
  return { run, rows, vault };
}

const FULL = { question: 'Ship Friday or Monday?', blocked: 'the release waits', options: ['Friday -- risks a weekend fix', 'Monday -- a three day delay'], recommend: 'Monday, it is safer.', links: ['https://example.test/pull/7'] };

test('validateAskTemplate names every missing field at once', () => {
  const { errors, template } = validateAskTemplate({});
  assert.deepEqual(template, {});
  for (const word of ['question', 'blocked', 'options', 'recommend', 'links']) assert.ok(errors.some((e) => e.startsWith(word)), word);
  assert.equal(errors.length, 5);
});

test('validateAskTemplate wants two options that each name a cost, and links that open', () => {
  assert.match(validateAskTemplate({ ...FULL, options: ['only one -- cost'] }).errors.join(), /1 given, at least 2/);
  assert.match(validateAskTemplate({ ...FULL, options: ['A -- cost', 'B with no cost'] }).errors.join(), /option 2 .* names no cost/);
  assert.match(validateAskTemplate({ ...FULL, links: ['PR 7'] }).errors.join(), /link 1 .* cannot be opened/);
  assert.match(validateAskTemplate({ ...FULL, links: ['javascript:alert(1)'] }).errors.join(), /cannot be opened/);
  assert.match(validateAskTemplate({ ...FULL, question: 'two\nlines' }).errors.join(), /one line/);
  const ok = validateAskTemplate({ ...FULL, context: ['a fact'] });
  assert.deepEqual(ok.errors, []);
  assert.deepEqual(ok.template, { blocked: 'the release waits', context: ['a fact'], options: FULL.options, links: FULL.links });
});

test('parseLink and splitOption read the forms the docs show', () => {
  assert.deepEqual(parseLink('https://example.test/p/1'), { label: 'https://example.test/p/1', url: 'https://example.test/p/1' });
  assert.deepEqual(parseLink('[PR 7](https://example.test/pull/7)'), { label: 'PR 7', url: 'https://example.test/pull/7' });
  assert.deepEqual(parseLink('the note: obsidian://open?vault=Fictional&file=Plan'), { label: 'the note', url: 'obsidian://open?vault=Fictional&file=Plan' });
  assert.equal(parseLink('http://insecure.test'), null);
  assert.deepEqual(splitOption('Merge now -- risks a red main'), { option: 'Merge now', cost: 'risks a red main' });
  assert.deepEqual(splitOption('Merge now'), { option: 'Merge now', cost: null });
});

test('a body file parses its headings into the same fields, and flags win over the file', () => {
  const md = ['# Question', 'Ship Friday or Monday?', '', '## What is blocked', 'The release.', '', '## Context', '- a fact', '- another', '  continued', '', '## Options', '1. Friday -- risk', '2. Monday -- delay', '',
    '## Recommendation', 'Monday, safer.', '', '## Links', '- [PR](https://example.test/pull/7)', '', '## What I checked', 'the README', '', '## Door', 'two-way', '', '## Extra', 'x'].join('\n');
  const b = parseAskBody(md);
  assert.equal(b.question, 'Ship Friday or Monday?');
  assert.equal(b.blocked, 'The release.');
  assert.deepEqual(b.context, ['a fact', 'another continued']);
  assert.deepEqual(b.options, ['Friday -- risk', 'Monday -- delay']);
  assert.equal(b.recommend, 'Monday, safer.');
  assert.deepEqual(b.links, ['[PR](https://example.test/pull/7)']);
  assert.equal(b.searched, 'the README');
  assert.equal(b.door, 'two-way');
  assert.deepEqual(b.unknown, ['Extra']);
  assert.equal(mergeTemplate({ blocked: 'from flag' }, b).blocked, 'from flag');
  assert.deepEqual(mergeTemplate({ options: [] }, b).options, b.options, 'an empty flag list does not hide the file');
});

test('ask with no template refuses with every missing field named, and writes nothing', () => {
  const f = fixture();
  const r = f.run('ask', 'which way?', ...SEARCHED, ...MARKS);
  assert.equal(r.status, 1);
  for (const word of ['blocked', 'options', 'recommend', 'links']) assert.match(r.stderr, new RegExp(`- ${word}`), word);
  assert.match(r.stderr, /nothing written/);
  assert.deepEqual(f.rows(), []);
  const partial = f.run('ask', 'which way?', '--blocked', 'x', '--option', 'A -- cost', ...SEARCHED, ...MARKS);
  assert.equal(partial.status, 1);
  assert.match(partial.stderr, /options: 1 given/);
  assert.doesNotMatch(partial.stderr, /- blocked/);
  assert.deepEqual(f.rows(), []);
});

test('each missing required field alone refuses the ask', () => {
  const f = fixture();
  const flags: Record<string, string[]> = {
    blocked: ['--blocked', 'x'], option: ['--option', 'A -- a', '--option', 'B -- b'], recommend: ['--recommend', 'A'], link: ['--link', 'https://example.test/1'],
  };
  for (const omit of Object.keys(flags)) {
    const given = Object.entries(flags).filter(([k]) => k !== omit).flatMap(([, v]) => v);
    const r = f.run('ask', 'which way?', ...given, ...SEARCHED, ...MARKS);
    assert.equal(r.status, 1, omit);
  }
  assert.deepEqual(f.rows(), []);
  assert.equal(f.run('ask', ...Object.values(flags).flat(), ...SEARCHED, ...MARKS).status, 1, 'no question at all');
});

test('a complete ask is written with its template on the row', () => {
  const f = fixture();
  const r = f.run('ask', 'Ship Friday or Monday?', '--blocked', 'the release waits', '--context', 'CI is green', '--context', 'two reviewers away', '--option', 'Friday -- risks a weekend fix',
    '--option', 'Monday -- a three day delay', '--recommend', 'Monday, it is safer.', '--link', 'https://example.test/pull/7', ...SEARCHED, ...MARKS);
  assert.equal(r.status, 0, r.stderr);
  const row = f.rows().at(-1)!;
  assert.equal(row.kind, 'question');
  assert.equal(row.text, 'Ship Friday or Monday?');
  assert.equal(row.blocked, 'the release waits');
  assert.deepEqual(row.context, ['CI is green', 'two reviewers away']);
  assert.deepEqual(row.options, ['Friday -- risks a weekend fix', 'Monday -- a three day delay']);
  assert.deepEqual(row.links, ['https://example.test/pull/7']);
  assert.equal(row.recommend, 'Monday, it is safer.');
});

test('--body-file supplies the template, and a flag overrides its section', () => {
  const f = fixture();
  const file = join(f.vault, 'ask.md');
  writeFileSync(file, ['## Question', 'Ship Friday or Monday?', '## What is blocked', 'The release.', '## Options', '- Friday -- risk', '- Monday -- delay', '## Recommendation', 'Monday.', '## Links', '- https://example.test/pull/7', '## What I checked', 'the README'].join('\n'));
  const r = f.run('ask', '--body-file', file, '--blocked', 'from the flag', ...MARKS);
  assert.equal(r.status, 0, r.stderr);
  const row = f.rows().at(-1)!;
  assert.equal(row.text, 'Ship Friday or Monday?');
  assert.equal(row.blocked, 'from the flag');
  assert.equal(row.searched, 'the README');
  assert.deepEqual(row.options, ['Friday -- risk', 'Monday -- delay']);
  const missing = f.run('ask', '--body-file', join(f.vault, 'nope.md'), ...MARKS);
  assert.equal(missing.status, 1);
  writeFileSync(file, '## Question\nQ?\n## Surprise\nx\n');
  assert.match(f.run('ask', '--body-file', file, ...SEARCHED, ...MARKS).stderr, /headings ask does not know: Surprise/);
});

test('a run-this ask and an acted two-way default need no template; the template flags go only on ask', () => {
  const f = fixture();
  const block = join(f.vault, 'block.sh');
  writeFileSync(block, 'echo hi\n');
  assert.equal(f.run('ask', 'run this', '--paste', block, ...SEARCHED, ...MARKS).status, 0);
  const acted = f.run('ask', 'which window?', '--door', 'two-way', '--default', 'the night one', '--recommend', 'night', ...SEARCHED, ...MARKS);
  assert.equal(acted.status, 0, acted.stderr);
  assert.match(acted.stdout, /^acted /);
  const stray = f.run('note', 'hello', '--blocked', 'x', ...MARKS);
  assert.equal(stray.status, 1);
  assert.match(stray.stderr, /only go on `ask`/);
});

test('the roll-raised env-store ask passes the same validator', () => {
  const ask = { repo: 'fake-repo', worktree: '/tmp/fake-wt', files: ['.env.local'], project: 'fake-proj', destination: '/tmp/store/fake-proj' };
  const { errors } = validateAskTemplate(envAskTemplate(ask, 'Move them now.'));
  assert.deepEqual(errors, []);
});

test('the shared fixture flags are themselves a valid template', () => {
  const f = fixture();
  assert.equal(f.run('ask', 'fixture q?', ...ASK_TEMPLATE, ...SEARCHED, ...MARKS).status, 0);
});

test('a full batch of the decision scan (20 long messages) is accepted, not refused for length', () => {
  const msgs = Array.from({ length: 20 }, (_, n) => ({ ts: `2026-10-13T10:${String(n).padStart(2, '0')}:00Z`, text: `from now on rule number ${n} applies ${'x'.repeat(200)}` }));
  const q = unledgeredDecisions(msgs, []).raise[0] ?? '';
  assert.ok(q.length > 3000, `the batch is long (${q.length})`);
  const f = fixture();
  const r = f.run('ask', q, ...ASK_TEMPLATE, ...SEARCHED, ...MARKS);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(f.rows().length, 1);
});
