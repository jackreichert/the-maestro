import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import test from 'node:test';
import {countOpenQuestions, fetchPullRequests, podiumLink, renderStatusLine, summarizePullRequests} from '../scripts/lib/statusline.mjs';
import {loadStatuslineSettings} from '../scripts/storage.mjs';

const project = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

function fixture(t) {
  const temp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'maestro-statusline-')));
  t.after(() => fs.rmSync(temp, {recursive: true, force: true}));
  const ledger = path.join(temp, 'ledger');
  const vault = path.join(temp, 'vault');
  fs.mkdirSync(ledger);
  fs.mkdirSync(vault);
  const settings = path.join(temp, 'settings.json');
  return {temp, ledger, vault, settings};
}

test('PR summary counts only drafts, requested changes, and approved mergeable PRs', () => {
  assert.deepEqual(summarizePullRequests([
    {isDraft: true, reviewDecision: null, mergeStateStatus: 'DIRTY'},
    {isDraft: false, reviewDecision: 'CHANGES_REQUESTED', mergeStateStatus: 'CLEAN'},
    {isDraft: false, reviewDecision: 'APPROVED', mergeStateStatus: 'CLEAN'},
    {isDraft: false, reviewDecision: 'APPROVED', mergeStateStatus: 'DIRTY'},
    {isDraft: false, reviewDecision: 'REVIEW_REQUIRED', mergeStateStatus: 'CLEAN'},
  ]), {drafts: 1, changesRequested: 1, approvedMergeable: 1});
});

test('open decision count excludes questions resolved by an event', () => {
  const rows = [{payload: {events: [
    {id: 'q1', kind: 'question'},
    {id: 'q2', kind: 'question'},
    {id: 'answer', kind: 'decision', resolves: ['q1']},
    {id: 'blocker', kind: 'blocker'},
  ]}}];
  assert.equal(countOpenQuestions(rows), 1);
});

test('PR lookup returns current-repo actions and a global open count', () => {
  const invocations = [];
  const stdout = JSON.stringify({data: {
    allOpen: {issueCount: 7},
    workspace: {issueCount: 2, nodes: [
      {isDraft: true, reviewDecision: null, mergeStateStatus: 'DIRTY'},
      {isDraft: false, reviewDecision: 'APPROVED', mergeStateStatus: 'CLEAN'},
    ]},
  }});
  const result = fetchPullRequests({
    cwd: process.cwd(),
  }, (command, args, options) => {
    invocations.push({command, args, options});
    if (args[0] === 'repo') return {status: 0, stdout: 'example-org/sample-repo\n'};
    return {status: 0, stdout};
  });
  assert.equal(result.sessionError, null);
  assert.equal(result.allOpenError, null);
  assert.equal(result.allOpenCount, 7);
  assert.deepEqual(result.sessionPullRequests, [
    {isDraft: true, reviewDecision: null, mergeStateStatus: 'DIRTY'},
    {isDraft: false, reviewDecision: 'APPROVED', mergeStateStatus: 'CLEAN'},
  ]);
  assert.deepEqual(invocations.map(({args}) => args[0]), ['repo', 'api']);
  const query = invocations[1];
  assert.ok(query.args.some((arg) => arg.includes('author:@me repo:example-org/sample-repo')));
  assert.equal(query.options.cwd, process.cwd());
  assert.equal(query.options.timeout, 2000);

  const failure = fetchPullRequests({}, (command, args) => (
    args[0] === 'repo'
      ? {status: 1, stdout: '', stderr: 'not printed'}
      : {status: 0, stdout: JSON.stringify({data: {allOpen: {issueCount: 4}}})}
  ));
  assert.match(failure.sessionError, /gh repo view exited 1/);
  assert.equal(failure.allOpenCount, 4);
  assert.equal(failure.allOpenError, null);
});

test('status line shows live session metrics, PR action counts, decisions, and a clickable Podium link', () => {
  const line = renderStatusLine({
    input: {cost: {total_cost_usd: 1.239}, context_window: {used_percentage: 61.6}},
    sessionPullRequests: [
      {isDraft: true, reviewDecision: null, mergeStateStatus: 'DIRTY'},
      {isDraft: false, reviewDecision: 'APPROVED', mergeStateStatus: 'CLEAN'},
    ],
    allOpenCount: 7,
    decisions: 2,
    podiumUrl: 'file:///tmp/Work%20Vault/Podium/README.md',
  });
  assert.match(line, /PRs here 1 draft, 1 approved\/mergeable/);
  assert.match(line, /My open PRs 7/);
  assert.match(line, /Session \$1\.24 est\./);
  assert.match(line, /Context 62%/);
  assert.match(line, /Decisions 2/);
  assert.match(line, /\u001b]8;;file:\/\/\/tmp\/Work%20Vault\/Podium\/README\.md\u001b\\Podium\u001b]8;;\u001b\\/);
});

test('status line names unavailable fields and omits invalid negative metrics', () => {
  const line = renderStatusLine({input: {cost: {total_cost_usd: -1}, context_window: {used_percentage: null}},
    sessionPullRequests: null, allOpenCount: null, decisions: null, podiumUrl: null});
  assert.equal(line, 'Maestro | PRs here unavailable | My open PRs unavailable | Session cost unavailable | Context unavailable | Decisions unavailable | Podium unavailable');
});

test('Podium link prefers Redux page, falls back to workspace page, and rejects symlinks', (t) => {
  const f = fixture(t);
  fs.mkdirSync(path.join(f.vault, 'Podium'));
  const page = path.join(f.vault, 'Podium', 'README.md');
  fs.writeFileSync(page, '# Podium\n');
  assert.equal(podiumLink(f.vault), new URL(`file://${page}`).href);

  fs.rmSync(page);
  const legacy = path.join(f.vault, 'Projects', 'sample', 'Status');
  fs.mkdirSync(legacy, {recursive: true});
  const legacyPage = path.join(legacy, 'The-Podium.md');
  fs.writeFileSync(legacyPage, '# Workspace Podium\n');
  assert.equal(podiumLink(f.vault, '/workspace/sample'), new URL(`file://${legacyPage}`).href);

  const external = path.join(f.temp, 'outside.md');
  fs.writeFileSync(external, 'not a podium');
  fs.rmSync(legacyPage);
  fs.symlinkSync(external, path.join(legacy, 'The-Podium.md'));
  assert.throws(() => podiumLink(f.vault, '/workspace/sample'), /Symlink/);
});

test('status-line settings permit unset persistence roots but validate configured roots', (t) => {
  const f = fixture(t);
  fs.writeFileSync(f.settings, JSON.stringify({paths: {ledger_root: f.ledger, vault_root: f.vault}}));
  const configured = loadStatuslineSettings(path.join(project, 'settings.json'), f.settings);
  assert.equal(configured.ledger, f.ledger);
  assert.equal(configured.vault, f.vault);

  fs.writeFileSync(f.settings, JSON.stringify({paths: {ledger_root: null, vault_root: null}}));
  const unset = loadStatuslineSettings(path.join(project, 'settings.json'), f.settings);
  assert.equal(unset.ledger, null);
  assert.equal(unset.vault, null);
});
