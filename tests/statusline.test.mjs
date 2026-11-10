import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import {fetchPullRequests, openQuestionCount, podiumLink, renderStatusLine} from '../scripts/lib/statusline.mjs';
import {loadStatuslineSettings} from '../scripts/storage.mjs';
import {flush, prepare} from '../scripts/ledger.mjs';
import {fixture, project} from './helpers.mjs';

function prCount(totalCount) {
  return {data: {viewer: {pullRequests: {totalCount}}}};
}

test('footer uses the current index without rereading journals, and revalidates changed journals', (t) => {
  const f = fixture(t);
  prepare(f, {
    session_id: 'sample-session', turn_id: 'sample-turn',
    topics: [{id: 'sample', name: 'Sample', aliases: [], repos: [], references: []}],
    events: [
      {id: 'question', topic_id: 'sample', kind: 'question', summary: 'One writer?', sources: []},
      {id: 'question-10', topic_id: 'sample', kind: 'question', summary: 'Which writer?', sources: []},
      {topic_id: 'sample', kind: 'blocker', summary: 'Waiting for an owner.', sources: []},
    ],
  });
  flush(f, 'sample-session');
  const read = fs.readFileSync;
  let journalReads = 0;
  t.mock.method(fs, 'readFileSync', (file, ...args) => {
    if (typeof file === 'string' && file.endsWith('.jsonl')) journalReads += 1;
    return read(file, ...args);
  });
  assert.equal(openQuestionCount(f.ledger), 2);
  assert.equal(openQuestionCount(f.ledger), 2);
  assert.equal(journalReads, 0);

  prepare(f, {session_id: 'sample-session', turn_id: 'next-turn',
    events: [{topic_id: 'sample', kind: 'decision', summary: 'One writer.', sources: [], resolves: ['question']}]});
  flush(f, 'sample-session');
  assert.equal(openQuestionCount(f.ledger), 1);
  prepare(f, {session_id: 'sample-session', turn_id: 'last-turn',
    events: [{topic_id: 'sample', kind: 'decision', summary: 'Use the shared writer.', sources: [], resolves: ['question-10']}]});
  flush(f, 'sample-session', {fault(point) {if (point === 'before-index') throw new Error('Index interrupted');}});
  assert.equal(openQuestionCount(f.ledger), 0);
  const journal = path.join(f.ledger, 'Events', fs.readdirSync(path.join(f.ledger, 'Events'))[0]);
  fs.appendFileSync(journal, '{torn');
  assert.throws(() => openQuestionCount(f.ledger), /Incomplete journal/);
});

test('PR lookup counts all authored open PRs without repository discovery or result limits', () => {
  const invocations = [];
  const stdout = JSON.stringify(prCount(1501));
  const result = fetchPullRequests({
    cwd: process.cwd(),
  }, (command, args, options) => {
    invocations.push({command, args, options});
    return {status: 0, stdout};
  });
  assert.deepEqual(result, {allOpenCount: 1501, error: null});
  assert.equal(invocations.length, 1);
  const [query] = invocations;
  assert.equal(query.command, 'gh');
  assert.deepEqual(query.args.slice(0, 3), ['api', 'graphql', '-f']);
  assert.match(query.args[3], /viewer\s*\{\s*pullRequests\(states: OPEN\) \{ totalCount \}/);
  assert.doesNotMatch(query.args[3], /search|nodes|first:|isDraft|reviewDecision|mergeStateStatus/);
  assert.equal(query.options.cwd, process.cwd());
  assert.equal(query.options.timeout, 10000);
});

test('PR lookup distinguishes zero open PRs from GitHub errors and invalid counts', () => {
  const empty = fetchPullRequests({}, () => ({status: 0, stdout: JSON.stringify(prCount(0))}));
  assert.deepEqual(empty, {allOpenCount: 0, error: null});
  for (const result of [
    {status: 1, stdout: '', stderr: 'not printed'},
    {status: null, error: {code: 'ETIMEDOUT'}},
    {status: 0, stdout: '{invalid'},
    {status: 0, stdout: '[]'},
    {status: 0, stdout: JSON.stringify(prCount(-1))},
    {status: 0, stdout: JSON.stringify(prCount(1.5))},
    {status: 0, stdout: JSON.stringify(prCount('41'))},
    {status: 0, stdout: JSON.stringify(prCount(null))},
    {status: 0, stdout: JSON.stringify({data: {viewer: null}})},
    {status: 0, stdout: JSON.stringify({...prCount(41), errors: [{message: 'Denied'}]})},
  ]) {
    const failure = fetchPullRequests({}, () => result);
    assert.equal(failure.allOpenCount, null);
    assert.ok(failure.error);
  }
});

test('status line shows only the open PR count and preserves session metrics and Podium link', () => {
  const line = renderStatusLine({
    input: {cost: {total_cost_usd: 1.239}, context_window: {used_percentage: 61.6}},
    allOpenCount: 41,
    decisions: 2,
    memory: 'Memory saved',
    podiumUrl: 'obsidian://open?path=%2Ftmp%2FWork%20Vault%2FPodium%2FREADME.md',
  });
  assert.ok(line.startsWith('\u{1F3BC} Maestro | \u001b]8;;obsidian://open?path=%2Ftmp%2FWork%20Vault%2FPodium%2FREADME.md\u001b\\Podium\u001b]8;;\u001b\\ | '));
  assert.match(line, /Open PRs 41 \|/);
  assert.doesNotMatch(line, /PRs here|github\.com|My open PRs|Open PRs 41:/);
  assert.match(line, /Session \$1\.24 est\./);
  assert.match(line, /Context 62%/);
  assert.match(line, /Decisions 2/);
  assert.match(line, /Memory saved/);
  assert.match(line, /\u001b]8;;obsidian:\/\/open\?path=%2Ftmp%2FWork%20Vault%2FPodium%2FREADME\.md\u001b\\Podium\u001b]8;;\u001b\\/);
  assert.match(renderStatusLine({input: {}, allOpenCount: 0}), /Open PRs 0 \|/);
});

test('status line names unavailable fields and omits invalid negative metrics', () => {
  const line = renderStatusLine({input: {cost: {total_cost_usd: -1}, context_window: {used_percentage: null}},
    allOpenCount: null, decisions: null, podiumUrl: null});
  assert.equal(line, '\u{1F3BC} Maestro | Podium unavailable | Open PRs unavailable | Session cost unavailable | Context unavailable | Decisions unavailable | Memory unavailable');
});

test('Podium link prefers canonical page, falls back to workspace page, and rejects symlinks', (t) => {
  const f = fixture(t);
  fs.mkdirSync(path.join(f.vault, 'Podium'));
  const page = path.join(f.vault, 'Podium', 'README.md');
  fs.writeFileSync(page, '# Podium\n');
  assert.equal(podiumLink(f.vault), `obsidian://open?path=${encodeURIComponent(page)}`);

  fs.rmSync(page);
  const legacy = path.join(f.vault, 'Projects', 'sample', 'Status');
  fs.mkdirSync(legacy, {recursive: true});
  const legacyPage = path.join(legacy, 'The-Podium.md');
  fs.writeFileSync(legacyPage, '# Workspace Podium\n');
  assert.equal(podiumLink(f.vault, '/workspace/sample'), `obsidian://open?path=${encodeURIComponent(legacyPage)}`);

  const external = path.join(f.temp, 'outside.md');
  fs.writeFileSync(external, 'not a podium');
  fs.rmSync(legacyPage);
  fs.symlinkSync(external, path.join(legacy, 'The-Podium.md'));
  assert.throws(() => podiumLink(f.vault, '/workspace/sample'), /Symlink/);
});

test('status-line settings permit unset persistence roots but validate configured roots', (t) => {
  const f = fixture(t);
  const configured = loadStatuslineSettings(path.join(project, 'settings.json'), f.config);
  assert.equal(configured.ledger, f.ledger);
  assert.equal(configured.vault, f.vault);

  fs.writeFileSync(f.config, JSON.stringify({paths: {ledger_root: null, vault_root: null}}));
  const unset = loadStatuslineSettings(path.join(project, 'settings.json'), f.config);
  assert.equal(unset.ledger, null);
  assert.equal(unset.vault, null);
});
