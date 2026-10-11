// Run: node --test scripts/flow-report.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const SCRIPT = new URL('./flow-report.ts', import.meta.url).pathname;
const env = { ...process.env, MAESTRO_LOCAL_CONFIG: '', LEDGER_ROOT: '', VAULT_ROOT: '' };

function ledgerWith(rows: object[]): string {
    const vault = mkdtempSync(join(tmpdir(), 'flow-'));
    mkdirSync(join(vault, 'Projects', 'demo', 'Journal'), { recursive: true });
    writeFileSync(join(vault, 'Projects', 'demo', 'Journal', 'ledger.jsonl'), rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
    return vault;
}
const run = (...args: string[]) => { const r = spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8', env }); return { code: r.status, out: r.stdout, err: r.stderr }; };

const rows = [
    { id: 'aaaa', ts: '2026-10-06T10:00:00Z', date: '2026-10-06', kind: 'wip', stream: 's', text: 'first' },
    { id: 'bbbb', ts: '2026-10-06T12:00:00Z', date: '2026-10-06', kind: 'done', closes: 'aaaa', text: 'done' },
    { id: 'cccc', ts: '2026-10-05T12:00:00Z', date: '2026-10-05', kind: 'wip', stream: 's', text: 'still open' },
];

test('prints the report from a ledger and writes nothing', () => {
    const vault = ledgerWith(rows);
    const r = run('--vault', vault, '--project', 'demo', '--now', '2026-10-07T12:00:00Z');
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /throughput {2}1 done/);
    assert.match(r.out, /cccc {2}still open/);
});

test('--json prints the structured report', () => {
    const r = run('--vault', ledgerWith(rows), '--project', 'demo', '--now', '2026-10-07T12:00:00Z', '--json');
    const j = JSON.parse(r.out);
    assert.equal(j.done, 1);
    assert.equal(j.open[0].id, 'cccc');
});

test('refuses a missing root and a bad --days', () => {
    assert.equal(run('--project', 'demo').code, 2);
    assert.equal(run('--vault', ledgerWith(rows), '--project', 'demo', '--days', '0').code, 2);
});

test('refuses a negative --oldest', () => {
    assert.equal(run('--vault', ledgerWith(rows), '--project', 'demo', '--oldest', '-3').code, 2);
});

test('prints ledger stage dwell from a temp ledger and does not invent a waiter', () => {
    const stuck = [
        { id: 'qqqq', ts: '2026-10-06T12:00:00Z', date: '2026-10-06', kind: 'wip', queued: true, stream: 's', text: 'sitting queued' },
        { id: 'bbbb', ts: '2026-09-20T12:00:00Z', date: '2026-09-20', kind: 'blocked', stream: 's', text: 'held', gate: 'ticket:FAKE-1' },
        { id: 'aaaa', ts: '2026-10-07T00:00:00Z', date: '2026-10-07', kind: 'question', stream: 's', text: 'which way?' },
    ];
    const vault = ledgerWith(stuck);
    const r = run('--vault', vault, '--project', 'demo', '--now', '2026-10-07T12:00:00Z', '--days', '14');
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /longest dwell {2}blocked {2}17d/);
    assert.match(r.out, /ticket: FAKE-1/);
    assert.match(r.out, /unrecorded {2}which way\?/);
    assert.equal(r.out.includes(vault), false);
    assert.equal(r.out.includes('/Users/'), false);
    const j = JSON.parse(run('--vault', vault, '--project', 'demo', '--now', '2026-10-07T12:00:00Z', '--days', '7', '--json').out);
    assert.equal(j.dwell.longest, 'blocked');
    assert.equal(j.dwell.longestDays, 17);
    assert.equal(j.dwell.stages.find((s: { stage: string }) => s.stage === 'blocked').dwellDays, 7);
    assert.deepEqual(j.dwell.stages.map((s: { stage: string }) => s.stage), ['queued', 'in flight', 'blocked', 'awaiting a person']);
    assert.equal(j.dwell.waiting.find((w: { id: string }) => w.id === 'aaaa').waitsOn, 'unrecorded');
});

test('run quality counts send-backs on completed items and briefed runs with no report, and says rework is not recorded', () => {
    const present = join(mkdtempSync(join(tmpdir(), 'flow-rep-')), 'report-aaaa.md');
    writeFileSync(present, 'done\n');
    const missing = join(tmpdir(), 'flow-rep-none', 'report-cccc.md');
    const withRuns = [
        ...rows,
        { id: 'q1', ts: '2026-10-06T10:30:00Z', date: '2026-10-06', kind: 'queue', queues: 'aaaa', text: 'sent back' },
        { id: 'q2', ts: '2026-10-06T11:00:00Z', date: '2026-10-06', kind: 'queue', queues: 'aaaa', text: 'sent back again' },
        { id: 'b1', ts: '2026-10-06T09:00:00Z', date: '2026-10-06', kind: 'brief', briefs: 'aaaa', report: present, text: 'brief aaaa' },
        { id: 'b2', ts: '2026-10-05T13:00:00Z', date: '2026-10-05', kind: 'brief', briefs: 'cccc', report: missing, text: 'brief cccc' },
    ];
    const r = run('--vault', ledgerWith(withRuns), '--project', 'demo', '--now', '2026-10-07T12:00:00Z', '--json');
    const j = JSON.parse(r.out);
    assert.deepEqual(j.runs, { completed: 1, retried: 1, retries: 2, retriesPerRun: 2, briefed: 2, silent: 1, silentIds: ['cccc'] });
    const text = run('--vault', ledgerWith(withRuns), '--project', 'demo', '--now', '2026-10-07T12:00:00Z').out;
    assert.match(text, /retries {6}2 send-backs over 1 completed/);
    assert.match(text, /silent runs {2}1 of 2 briefed wrote no report: cccc/);
    assert.match(text, /rework {7}not recorded/);
});
