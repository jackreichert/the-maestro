// Run: node --test scripts/journal.test.mjs
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const SCRIPT = new URL('./journal.mjs', import.meta.url).pathname;
const MARK = ['--model', 'Test Model', '--used', 'skill:the-maestro,tool:journal.mjs'];
let vault;

function run(...args) {
    const r = spawnSync(process.execPath, [SCRIPT, ...args, '--vault', vault, '--project', 'test-proj'], {
        encoding: 'utf8',
        env: { ...process.env, VAULT_ROOT: '' },
    });
    return { code: r.status, out: r.stdout, err: r.stderr };
}
const ledger = () => readFileSync(join(vault, 'Projects', 'test-proj', 'Journal', 'ledger.jsonl'), 'utf8')
    .split('\n').filter(Boolean).map((l) => JSON.parse(l));
const idOf = (out) => out.trim().split(/\s+/)[1];

beforeEach(() => { vault = mkdtempSync(join(tmpdir(), 'journal-test-')); });

test('start without --model fails and writes nothing', () => {
    const r = run('start', 'unmarked work', '--used', 'tool:journal.mjs');
    assert.equal(r.code, 1);
    assert.match(r.err, /--model/);
    assert.throws(() => ledger());
});

test('start with model and used shows the marks in status', () => {
    assert.equal(run('start', 'marked work', ...MARK).code, 0);
    const s = run('status');
    assert.equal(s.code, 0);
    assert.match(s.out, /marked work .*model: Test Model · used: skill:the-maestro, tool:journal\.mjs/);
});

test('standup hides the usage suffix', () => {
    const id = idOf(run('start', 'team item', ...MARK).out);
    run('done', id, ...MARK);
    const s = run('standup');
    assert.match(s.out, /- team item/);
    assert.doesNotMatch(s.out, /model:/);
});

test('stamp-missing marks an unmarked entry as unrecorded, once', () => {
    const id = idOf(run('start', 'legacy work', '--allow-unmarked').out);
    const first = run('stamp-missing');
    assert.match(first.out, /stamped 1 entry/);
    const stamp = ledger().find((e) => e.annotates === id);
    assert.deepEqual([stamp.model, stamp.used, stamp.tokens], ['unrecorded', ['unrecorded'], 'unmeasured']);
    assert.match(run('status').out, /legacy work .*model: unrecorded · used: unrecorded · tokens: unmeasured/);
    assert.match(run('stamp-missing').out, /stamped 0 entries/);
});

test('fold does not duplicate a stamped item', () => {
    const id = idOf(run('start', 'only once', '--allow-unmarked').out);
    run('stamp', id, ...MARK);
    run('stamp-missing');
    const s = JSON.parse(run('status', '--json').out);
    assert.equal(s.inflight.length, 1);
    assert.equal(s.inflight[0].model, 'Test Model');
});

test('roll appends a marked row without needing --model', () => {
    const id = idOf(run('start', 'finished', ...MARK).out);
    run('done', id, ...MARK);
    const r = run('roll');
    assert.equal(r.code, 0, r.err);
    const rolled = ledger().find((e) => e.kind === 'rolled');
    assert.deepEqual([rolled.model, rolled.used, rolled.tokens], ['n/a', ['tool:journal.mjs'], 'n/a']);
});
