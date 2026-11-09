import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawn, spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import test from 'node:test';
import {loadSettings, hash, readJson, withLock} from '../scripts/storage.mjs';
import {flush, lookup, prepare, readJournal, recover, refreshBrief, search} from '../scripts/ledger.mjs';

const project = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const cliPath = path.join(project, 'scripts/memory.mjs');

function fixture(t) {
  const temp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'maestro-memory-')));
  t.after(() => fs.rmSync(temp, {recursive: true, force: true}));
  const ledger = path.join(temp, 'ledger');
  const vault = path.join(temp, 'vault');
  fs.mkdirSync(ledger);
  fs.mkdirSync(vault);
  const settings = path.join(temp, 'settings.json');
  fs.writeFileSync(settings, JSON.stringify({paths: {ledger_root: ledger, vault_root: vault}}));
  return {...loadSettings(path.join(project, 'settings.json'), settings), temp, config: settings};
}

function input(overrides = {}) {
  return {
    session_id: 'session-1', turn_id: 'turn-1',
    topics: [{id: 'memory', name: 'Durable memory', aliases: ['continuity'], repos: ['sample'], references: []}],
    events: [{id: 'event-1', topic_id: 'memory', kind: 'finding', summary: 'The writer owns append sequencing.', sources: ['code:writer']}],
    ...overrides,
  };
}

function cli(f, command, args = [], stdin) {
  return spawnSync(process.execPath, [cliPath, command, '--settings', f.config, ...args], {
    input: stdin === undefined ? undefined : JSON.stringify(stdin), encoding: 'utf8',
  });
}

function newPage(id, surface, target, text) {
  return {id, surface, path: target, expected_sha256: null, changes: [{before: '', after: text}],
    ...(surface === 'library' ? {verified: true} : {})};
}

test('prepare, Stop and PreCompact persist three surfaces; repeated calls do not duplicate', (t) => {
  const f = fixture(t);
  const request = input({pages: [
    newPage('podium-1', 'podium', 'Podium/README.md', '# Podium\nNext: verify memory.\n'),
    newPage('library-1', 'library', 'Projects/sample/Knowledge/writer.md', '# Writer\nOne writer sequences append.\n'),
  ]});
  const prepared = cli(f, 'prepare', [], request);
  assert.equal(prepared.status, 0, prepared.stderr);
  const payload = JSON.parse(prepared.stdout);
  assert.ok(payload.id);
  assert.equal(readJournal(f.ledger).length, 0);
  for (const event of ['Stop', 'PreCompact', 'Stop']) {
    const run = cli(f, 'hook', [], {hook_event_name: event, session_id: 'session-1', stop_hook_active: true});
    assert.equal(run.status, 0, run.stderr);
    assert.match(run.stdout, /Only prepared deltas/);
    assert.ok(run.stdout.length < 10000);
    assert.doesNotMatch(run.stdout, /additionalContext|"decision"/);
    const receipt = JSON.parse(cli(f, 'flush', ['session-1']).stdout).checkpoints[0];
    assert.equal(receipt.ledger, 'applied');
    assert.equal(receipt.podium, 'applied');
    assert.equal(receipt.library, 'applied');
  }
  assert.equal(readJournal(f.ledger).length, 1);
  assert.equal(fs.readFileSync(path.join(f.vault, 'Podium/README.md'), 'utf8'), request.pages[0].changes[0].after);
});

test('hook scopes session and explicitly reports no capture, ignoring transcript paths', (t) => {
  const f = fixture(t);
  prepare(f, input());
  const run = cli(f, 'hook', [], {hook_event_name: 'Stop', session_id: 'other', transcript_path: '/not-readable'});
  assert.equal(run.status, 0);
  assert.match(run.stdout, /no-prepared-delta/);
  assert.match(run.stderr, /NOT verified/);
  assert.equal(readJournal(f.ledger).length, 0);
});

test('invalid hook input and settings exit nonzero, without printing input contents', (t) => {
  const f = fixture(t);
  const bad = cli(f, 'hook', [], {hook_event_name: 'Other', session_id: '../escape'});
  assert.equal(bad.status, 1);
  assert.doesNotMatch(bad.stderr, /escape/);
  fs.writeFileSync(f.config, JSON.stringify({paths: {vault_root: f.vault, ledger_root: f.ledger}, surprise: true}));
  assert.throws(() => loadSettings(path.join(project, 'settings.json'), f.config), /Unknown field/);
  fs.writeFileSync(f.config, '{broken');
  assert.equal(cli(f, 'rebuild').status, 1);
});

test('PR line budget defaults to 1000 and configured limits cannot exceed it', (t) => {
  const f = fixture(t);
  assert.equal(f.settings.pr_budget.max_changed_code_lines, 1000);

  const settings = {paths: {ledger_root: path.join(f.temp, 'ledger'), vault_root: path.join(f.temp, 'vault')}};
  for (const limit of [500, 1000]) {
    fs.writeFileSync(f.config, JSON.stringify({...settings, pr_budget: {max_changed_code_lines: limit}}));
    assert.equal(loadSettings(path.join(project, 'settings.json'), f.config).settings.pr_budget.max_changed_code_lines, limit);
  }

  fs.writeFileSync(f.config, JSON.stringify({...settings, pr_budget: {max_changed_code_lines: 1001}}));
  assert.throws(() => loadSettings(path.join(project, 'settings.json'), f.config), /Invalid PR budget/);
});

test('hash conflict is rejected; exact prepared payload is idempotent', (t) => {
  const f = fixture(t);
  const payload = prepare(f, input());
  assert.deepEqual(prepare(f, payload), payload);
  assert.throws(() => prepare(f, {...payload, turn_id: 'changed'}), /different payload/);
  flush(f, 'session-1');
  assert.throws(() => prepare(f, input({events: [{...input().events[0], summary: 'Changed'}]})), /existing event ID/);
});

test('unknown/cross-topic relationships and conflicting answers fail before persistence', (t) => {
  const f = fixture(t);
  const q = {...input().events[0], id: 'question-1', kind: 'question', summary: 'Use one writer?'};
  prepare(f, input({events: [q]}));
  flush(f, 'session-1');
  const answer = {...q, id: 'answer-1', kind: 'decision', summary: 'Use one writer.', resolves: [q.id]};
  prepare(f, input({turn_id: 'turn-2', events: [answer]}));
  flush(f, 'session-1');
  assert.throws(() => prepare(f, input({events: [{...answer, id: 'answer-2'}]})), /Already resolved/);
  assert.throws(() => prepare(f, input({events: [{...answer, id: 'answer-3', resolves: ['unknown']}]})), /earlier event/);
});

test('unsafe and unverified input is rejected without echoing values', (t) => {
  const f = fixture(t);
  for (const target of ['../outside.md', 'Projects/sample/Knowledge/../oops.md', 'Projects/sample/Knowledge/.env.md', 'Podium/ssm-test.json']) {
    assert.throws(() => prepare(f, input({pages: [newPage('bad', 'library', target, 'Safe text')]})));
  }
  const page = newPage('bad', 'library', 'Projects/sample/Knowledge/test.md', 'Safe text');
  delete page.verified;
  assert.throws(() => prepare(f, input({pages: [page]})), /verified/);
  for (const summary of ['password=not-a-real-value', '123-45-6789', 'user@example.test', 'Read .env.local']) {
    assert.throws(() => prepare(f, input({events: [{...input().events[0], summary}]})), /redact input/);
  }
});

test('symlink escape and symlink roots are rejected; unrelated target is untouched', (t) => {
  const f = fixture(t);
  const outside = path.join(f.temp, 'outside');
  fs.mkdirSync(outside);
  prepare(f, input({pages: [newPage('page-1', 'podium', 'Podium/README.md', 'Safe')]}));
  fs.symlinkSync(outside, path.join(f.vault, 'Podium'));
  const receipt = flush(f, 'session-1').checkpoints[0];
  assert.equal(receipt.podium, 'failed');
  assert.equal(fs.readdirSync(outside).length, 0);
  fs.symlinkSync(f.ledger, path.join(f.temp, 'linked-ledger'));
  fs.writeFileSync(f.config, JSON.stringify({paths: {vault_root: f.vault, ledger_root: path.join(f.temp, 'linked-ledger')}}));
  assert.throws(() => loadSettings(path.join(project, 'settings.json'), f.config), /symlink/);
});

test('partial page failure preserves ledger and independent library update; revision conflict preserves edits', (t) => {
  const f = fixture(t);
  fs.mkdirSync(path.join(f.vault, 'Podium'));
  fs.writeFileSync(path.join(f.vault, 'Podium/README.md'), 'User edits');
  prepare(f, input({pages: [
    newPage('page-1', 'podium', 'Podium/README.md', 'Agent edits'),
    newPage('page-2', 'library', 'Projects/sample/Knowledge/test.md', 'Verified explanation'),
  ]}));
  const receipt = flush(f, 'session-1').checkpoints[0];
  assert.equal(receipt.ledger, 'applied');
  assert.equal(receipt.podium, 'failed');
  assert.equal(receipt.library, 'applied');
  assert.equal(fs.readFileSync(path.join(f.vault, 'Podium/README.md'), 'utf8'), 'User edits');
  assert.equal(readJournal(f.ledger).length, 1);
});

test('crash after append deduplicates before page updates on retry', (t) => {
  const f = fixture(t);
  prepare(f, input({pages: [newPage('page-1', 'podium', 'Podium/README.md', 'Ready')]}));
  assert.throws(() => flush(f, 'session-1', {fault(point) {if (point === 'after-append') throw new Error('Simulated crash');}}), /Simulated/);
  assert.equal(readJournal(f.ledger).length, 1);
  assert.equal(fs.existsSync(path.join(f.vault, 'Podium/README.md')), false);
  assert.equal(flush(f, 'session-1').checkpoints[0].podium, 'applied');
  assert.equal(readJournal(f.ledger).length, 1);
});

test('lost page receipt recovers from saved result hash and preserves later edits', (t) => {
  const f = fixture(t);
  prepare(f, input({pages: [newPage('page-1', 'podium', 'Podium/README.md', 'Ready')]}));
  const failed = flush(f, 'session-1', {fault(point) {if (point === 'after-page') throw new Error('Simulated receipt loss');}});
  assert.equal(failed.checkpoints[0].podium, 'failed');
  assert.equal(flush(f, 'session-1').checkpoints[0].podium, 'applied');
  fs.writeFileSync(path.join(f.vault, 'Podium/README.md'), 'Later user edit');
  flush(f, 'session-1');
  assert.equal(fs.readFileSync(path.join(f.vault, 'Podium/README.md'), 'utf8'), 'Later user edit');
});

test('question remains on page until answer append; failed removal is retryable', (t) => {
  const f = fixture(t);
  const question = {...input().events[0], id: 'question-1', kind: 'question', summary: 'Use one writer?'};
  const page = '# Podium\nquestion-1: Use one writer?\nOther priority stays.\n';
  prepare(f, input({events: [question], pages: [newPage('question-page', 'podium', 'Podium/README.md', page)]}));
  flush(f, 'session-1');
  const answer = {...question, id: 'answer-1', kind: 'decision', summary: 'Use one writer.', resolves: ['question-1']};
  prepare(f, input({turn_id: 'turn-2', events: [answer], pages: [{
    id: 'remove-question', surface: 'podium', path: 'Podium/README.md', expected_sha256: hash(page),
    changes: [{before: 'question-1: Use one writer?\n', after: ''}], resolves: ['question-1'],
  }]}));
  const receipt = flush(f, 'session-1', {fault(point, item) {
    if (point === 'before-page' && item.id === 'remove-question') throw new Error('Simulated blocked removal');
  }});
  assert.equal(receipt.checkpoints.at(-1).podium, 'failed');
  assert.ok(fs.readFileSync(path.join(f.vault, 'Podium/README.md'), 'utf8').includes('question-1'));
  flush(f, 'session-1');
  const text = fs.readFileSync(path.join(f.vault, 'Podium/README.md'), 'utf8');
  assert.ok(!text.includes('question-1'));
  assert.ok(text.includes('Other priority stays'));
  assert.equal(readJournal(f.ledger).length, 2);
});

test('index failure is separate and retried; recovery includes a correction newer than brief', (t) => {
  const f = fixture(t);
  prepare(f, input());
  const receipt = flush(f, 'session-1', {fault(point) {if (point === 'before-index') throw new Error('Index unavailable');}});
  assert.equal(receipt.checkpoints[0].ledger, 'applied');
  assert.equal(receipt.checkpoints[0].index, 'failed');
  flush(f, 'session-1');
  assert.equal(search(f, 'continuity')[0].topic_id, 'memory');
  assert.equal(recover(f, 'memory').coverage, 'missing-or-modified-brief');
  refreshBrief(f, 'memory');
  prepare(f, input({turn_id: 'turn-2', events: [{id: 'correction-1', topic_id: 'memory', kind: 'correction',
    summary: 'The writer also protects vault updates.', details: 'Earlier scope was incomplete.', sources: ['code:vault'], supersedes: ['event-1']}]}));
  flush(f, 'session-1');
  const recovered = recover(f, 'memory');
  assert.equal(recovered.coverage, 'verified-brief');
  assert.deepEqual(recovered.uncovered.map((event) => event.id), ['correction-1']);
  fs.writeFileSync(path.join(f.ledger, 'Topics/memory/brief.md'), 'User changed summary');
  assert.equal(recover(f, 'memory').uncovered.length, 2);
});

test('torn or corrupt journal rows block writes instead of being skipped', (t) => {
  const f = fixture(t);
  prepare(f, input());
  flush(f, 'session-1');
  const file = path.join(f.ledger, 'Events', fs.readdirSync(path.join(f.ledger, 'Events'))[0]);
  const initial = fs.readFileSync(file, 'utf8');
  fs.appendFileSync(file, '{torn');
  assert.throws(() => readJournal(f.ledger), /Incomplete journal/);
  fs.writeFileSync(file, `${initial}{bad}\n`);
  assert.throws(() => readJournal(f.ledger), /Corrupt journal/);
});

test('held locks fail fast; independent process writers produce unique global sequences', async (t) => {
  const f = fixture(t);
  assert.throws(() => withLock(f.ledger, () => flush(f, 'session-1')), /Writer lock held/);
  const sessions = ['session-1', 'session-2', 'session-3'];
  for (const [index, session] of sessions.entries()) {
    prepare(f, input({session_id: session, events: [{...input().events[0], id: `event-${index + 1}`}]}));
  }
  const executions = sessions.map((session) => new Promise((resolve) => {
    const child = spawn(process.execPath, [cliPath, 'flush', '--settings', f.config, session], {stdio: ['ignore', 'ignore', 'pipe']});
    child.on('close', (code) => resolve({session, code}));
  }));
  for (const result of await Promise.all(executions)) {
    if (result.code !== 0) assert.equal(cli(f, 'flush', [result.session]).status, 0);
  }
  assert.deepEqual(readJournal(f.ledger).map((row) => row.seq), [1, 2, 3]);
});

test('replacement patches apply dollar characters literally and reject ambiguous matches', (t) => {
  const f = fixture(t);
  fs.mkdirSync(path.join(f.vault, 'Podium'));
  fs.writeFileSync(path.join(f.vault, 'Podium/README.md'), 'Old');
  prepare(f, input({pages: [{id: 'page-1', surface: 'podium', path: 'Podium/README.md',
    expected_sha256: hash('Old'), changes: [{before: 'Old', after: 'Literal $& $1 $$'}]}]}));
  assert.equal(flush(f, 'session-1').checkpoints[0].podium, 'applied');
  assert.equal(fs.readFileSync(path.join(f.vault, 'Podium/README.md'), 'utf8'), 'Literal $& $1 $$');
  fs.writeFileSync(path.join(f.vault, 'Podium/README.md'), 'Old Old');
  prepare(f, input({events: [], pages: [{id: 'page-2', surface: 'podium', path: 'Podium/README.md',
    expected_sha256: hash('Old Old'), changes: [{before: 'Old', after: 'New'}]}]}));
  assert.equal(flush(f, 'session-1').checkpoints.at(-1).podium, 'failed');
});

test('corrected checkpoint supersedes stale operation without rewriting either envelope', (t) => {
  const f = fixture(t);
  fs.mkdirSync(path.join(f.vault, 'Podium'));
  fs.writeFileSync(path.join(f.vault, 'Podium/README.md'), 'User edit');
  prepare(f, input({pages: [newPage('stale', 'podium', 'Podium/README.md', 'Agent edit')]}));
  assert.equal(flush(f, 'session-1').checkpoints[0].podium, 'failed');
  prepare(f, input({turn_id: 'turn-2', events: [], pages: [{
    id: 'fixed', supersedes: 'stale', surface: 'podium', path: 'Podium/README.md',
    expected_sha256: hash('User edit'), changes: [{before: 'User edit', after: 'User edit\nVerified next action'}],
  }]}));
  const result = flush(f, 'session-1');
  assert.equal(result.checkpoints[0].podium, 'superseded');
  assert.equal(result.checkpoints[1].podium, 'applied');
  assert.equal(result.checkpoints[0].errors.length, 0);
  assert.equal(cli(f, 'flush', ['session-1']).status, 0);
  assert.equal(readJournal(f.ledger).length, 2);
});

test('question removal cannot omit resolution; overflow leftovers report failure until removed', (t) => {
  const f = fixture(t);
  const question = {...input().events[0], id: 'question-1', kind: 'question', summary: 'One writer?'};
  const text = 'question-1: One writer?\n';
  prepare(f, input({events: [question], pages: [
    newPage('landing', 'podium', 'Podium/README.md', text),
    newPage('overflow', 'podium', 'Podium/Streams/memory.md', text),
  ]}));
  flush(f, 'session-1');
  prepare(f, input({turn_id: 'turn-2', events: [], pages: [{
    id: 'unsafe-removal', surface: 'podium', path: 'Podium/README.md',
    expected_sha256: hash(text), changes: [{before: text, after: 'Next action'}],
  }]}));
  assert.equal(flush(f, 'session-1').checkpoints.at(-1).podium, 'failed');
  prepare(f, input({turn_id: 'turn-3', events: [{...question, id: 'answer-1', kind: 'decision', summary: 'One writer.', resolves: ['question-1']}],
    pages: [{id: 'safe-removal', supersedes: 'unsafe-removal', surface: 'podium', path: 'Podium/README.md',
      expected_sha256: hash(text), changes: [{before: text, after: 'Next action'}], resolves: ['question-1']}]}));
  const incomplete = flush(f, 'session-1').checkpoints.at(-1);
  assert.equal(incomplete.question_removals['question-1'], 'failed');
  prepare(f, input({turn_id: 'turn-4', events: [], pages: [{
    id: 'overflow-removal', surface: 'podium', path: 'Podium/Streams/memory.md',
    expected_sha256: hash(text), changes: [{before: text, after: 'Next action'}], resolves: ['question-1'],
  }]}));
  assert.ok(flush(f, 'session-1').checkpoints.every((receipt) => receipt.errors.length === 0));
  assert.equal(cli(f, 'flush', ['session-1']).status, 0);
});

test('topic projections refuse manual metadata edits and index recovery stays explicit', (t) => {
  const f = fixture(t);
  prepare(f, input());
  flush(f, 'session-1');
  const metadataPath = path.join(f.ledger, 'Topics/memory/topic.json');
  fs.writeFileSync(metadataPath, '{"id":"memory","name":"Manual user edit"}\n');
  const run = cli(f, 'rebuild');
  assert.equal(run.status, 1);
  assert.match(run.stderr, /edited outside journal/);
  assert.ok(fs.readFileSync(metadataPath, 'utf8').includes('Manual user edit'));
});

test('invalid dates, oversized UTF-8 checkpoints, settings symlinks and overlapping roots fail', (t) => {
  const f = fixture(t);
  assert.throws(() => prepare(f, input({timestamp: '2026-02-30T00:00:00.000Z'})), /timestamp/);
  assert.throws(() => prepare(f, input({events: [{...input().events[0], summary: '\u00e9'.repeat(140000)}]})), /256 KiB/);
  const linked = path.join(f.temp, 'linked-settings.json');
  fs.symlinkSync(f.config, linked);
  assert.throws(() => loadSettings(path.join(project, 'settings.json'), linked), /Settings unavailable/);
  fs.writeFileSync(f.config, JSON.stringify({paths: {ledger_root: f.ledger, vault_root: f.ledger}}));
  assert.throws(() => loadSettings(path.join(project, 'settings.json'), f.config), /non-overlapping/);
});

test('append failure blocks dependent pages and a retry applies them', (t) => {
  const f = fixture(t);
  prepare(f, input({pages: [newPage('page-1', 'podium', 'Podium/README.md', 'Ready')]}));
  assert.throws(() => flush(f, 'session-1', {fault(point) {if (point === 'before-append') throw new Error('Append denied');}}), /Append denied/);
  assert.equal(readJournal(f.ledger).length, 0);
  assert.equal(fs.existsSync(path.join(f.vault, 'Podium/README.md')), false);
  assert.equal(flush(f, 'session-1').checkpoints[0].podium, 'applied');
});

test('hook failure stays nonblocking with plain bounded output and never ingests assistant text', (t) => {
  const f = fixture(t);
  fs.mkdirSync(path.join(f.vault, 'Podium'));
  fs.writeFileSync(path.join(f.vault, 'Podium/README.md'), 'User edit');
  prepare(f, input({pages: [newPage('page-1', 'podium', 'Podium/README.md', 'Ready')]}));
  const run = cli(f, 'hook', [], {hook_event_name: 'Stop', session_id: 'session-1',
    last_assistant_message: 'Unrelated synthetic transcript marker'});
  assert.equal(run.status, 1);
  assert.match(run.stdout, /1 incomplete/);
  assert.doesNotMatch(JSON.stringify(readJournal(f.ledger)), /transcript marker/);
  assert.doesNotMatch(run.stdout, /additionalContext|"decision"/);
});

test('UTF-8, journal identities and SQLite sidecars are guarded', (t) => {
  const f = fixture(t);
  fs.mkdirSync(path.join(f.vault, 'Podium'));
  fs.writeFileSync(path.join(f.vault, 'Podium/README.md'), Buffer.from([0xff]));
  prepare(f, input({pages: [newPage('page-1', 'podium', 'Podium/README.md', 'Ready')]}));
  assert.equal(flush(f, 'session-1').checkpoints[0].podium, 'failed');
  assert.deepEqual(fs.readFileSync(path.join(f.vault, 'Podium/README.md')), Buffer.from([0xff]));
  const file = path.join(f.ledger, 'Events', fs.readdirSync(path.join(f.ledger, 'Events'))[0]);
  const row = readJournal(f.ledger)[0];
  fs.appendFileSync(file, `${JSON.stringify(row)}\n`);
  assert.throws(() => readJournal(f.ledger), /Duplicate checkpoint/);
  fs.writeFileSync(file, `${JSON.stringify(row)}\n`);
  const outside = path.join(f.temp, 'synthetic-outside');
  fs.writeFileSync(outside, 'Do not change');
  fs.symlinkSync(outside, path.join(f.ledger, 'Index/ledger.sqlite-journal'));
  assert.throws(() => search(f, 'continuity'), /Symlink/);
  assert.equal(fs.readFileSync(outside, 'utf8'), 'Do not change');
});

test('process crash leaves a lock that is never automatically stolen', async (t) => {
  const f = fixture(t);
  const moduleUrl = new URL('../scripts/storage.mjs', import.meta.url).href;
  const script = `import {withLock} from ${JSON.stringify(moduleUrl)}; withLock(${JSON.stringify(f.ledger)}, () => process.kill(process.pid, 'SIGKILL'));`;
  const ended = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', script], {stdio: 'ignore'});
    child.once('error', reject);
    child.once('close', (code, signal) => resolve({code, signal}));
  });
  assert.equal(ended.signal, 'SIGKILL');
  assert.ok(fs.existsSync(path.join(f.ledger, '.writer.lock/owner.json')));
  assert.throws(() => flush(f, 'session-1'), /Writer lock held/);
});

test('question IDs are exact tokens, not prefixes of other questions', (t) => {
  const f = fixture(t);
  const q = {...input().events[0], id: 'question-1', kind: 'question', summary: 'One writer?'};
  const page = 'question-1: One writer?\nquestion-10: Other decision?\n';
  prepare(f, input({events: [q, {...q, id: 'question-10'}], pages: [newPage('page-1', 'podium', 'Podium/README.md', page)]}));
  flush(f, 'session-1');
  prepare(f, input({turn_id: 'turn-2', events: [{...q, id: 'answer-1', kind: 'decision', summary: 'One writer.', resolves: ['question-1']}],
    pages: [{id: 'page-2', surface: 'podium', path: 'Podium/README.md', expected_sha256: hash(page),
      changes: [{before: 'question-1: One writer?\n', after: ''}], resolves: ['question-1']}]}));
  assert.equal(flush(f, 'session-1').checkpoints.at(-1).podium, 'applied');
});

test('copied receipt cannot acknowledge a different envelope', (t) => {
  const f = fixture(t);
  const first = prepare(f, input());
  flush(f, 'session-1');
  const second = prepare(f, input({turn_id: 'turn-2', events: [{...input().events[0], id: 'event-2'}]}));
  const receiptDirectory = path.join(f.ledger, 'Pending/session-1');
  fs.copyFileSync(path.join(receiptDirectory, `${first.id}.state.json`), path.join(receiptDirectory, `${second.id}.state.json`));
  assert.throws(() => flush(f, 'session-1'), /different checkpoint payload/);
  assert.equal(readJournal(f.ledger).length, 1);
});

test('pasted question hash retrieves exact evidence and existing resolution through the CLI', (t) => {
  const f = fixture(t);
  const q = {...input().events[0], id: 'question-1', kind: 'question', summary: 'One writer?'};
  prepare(f, input({events: [q], id: 'checkpoint-question'}));
  flush(f, 'session-1');
  assert.equal(lookup(f, 'question-1').event.kind, 'question');
  prepare(f, input({turn_id: 'turn-2', events: [{...q, id: 'answer-1', kind: 'decision', summary: 'One writer.', resolves: ['question-1']}]}));
  flush(f, 'session-1');
  const run = cli(f, 'lookup', ['question-1']);
  assert.equal(run.status, 0, run.stderr);
  assert.equal(JSON.parse(run.stdout).related[0].id, 'answer-1');
  assert.equal(cli(f, 'lookup', ['missing']).status, 1);
});
