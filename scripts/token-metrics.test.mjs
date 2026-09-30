// Run: node --test scripts/token-metrics.test.mjs
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pick, compare, uncompact, compact } from './token-metrics.mjs';

// Hermetic: never read the user's config file (see local-config.mjs).
process.env.MAESTRO_LOCAL_CONFIG = '';

const SCRIPT = new URL('./token-metrics.mjs', import.meta.url).pathname;
const SENTINEL = 'SENTINEL_CONTENT_fake_id_123';
let projects;
let vault;

function run(...args) {
    const r = spawnSync(process.execPath, [SCRIPT, ...args, '--projects-dir', projects, '--vault', vault, '--project', 'test-proj'], {
        encoding: 'utf8',
        env: { ...process.env, VAULT_ROOT: '', TZ: 'UTC' },
    });
    return { code: r.status, out: r.stdout, err: r.stderr };
}
const tablePath = () => join(vault, 'Projects', 'test-proj', 'Research', 'token-metrics.md');

// One API response, written the way Claude Code writes it: one line per content block.
function assistant(id, ts, usage, model = 'claude-opus-5-5', blocks = 2) {
    const u = { input_tokens: usage[0], cache_creation_input_tokens: usage[1], cache_read_input_tokens: usage[2], output_tokens: usage[3] };
    return Array.from({ length: blocks }, () => ({
        type: 'assistant', timestamp: ts, message: { id, role: 'assistant', model, usage: u, content: [{ type: 'text', text: SENTINEL }] },
    }));
}
const user = (ts, origin) => ({ type: 'user', timestamp: ts, origin, message: { role: 'user', content: SENTINEL } });
const jsonl = (recs) => `${recs.map((r) => JSON.stringify(r)).join('\n')}\n`;

beforeEach(() => {
    projects = mkdtempSync(join(tmpdir(), 'tm-proj-'));
    vault = mkdtempSync(join(tmpdir(), 'tm-vault-'));
    const day = '2026-09-25T10:00:0';
    writeFileSync(join(projects, 'sess0001.jsonl'), jsonl([
        user(`${day}0Z`, { kind: 'human' }),
        ...assistant('m1', `${day}1Z`, [10, 1000, 5000, 100]),
        user(`${day}2Z`, { kind: 'task-notification' }),
        ...assistant('m2', `${day}3Z`, [10, 200, 6100, 50]),
        user(`${day}4Z`, { kind: 'peer', handback: true, body: SENTINEL }),
        ...assistant('m3', `${day}5Z`, [10, 1300, 6310, 70]),
    ]));
    mkdirSync(join(projects, 'sess0001', 'subagents'), { recursive: true });
    writeFileSync(join(projects, 'sess0001', 'subagents', 'agent-a1.jsonl'), jsonl([
        ...assistant('s1', `${day}1Z`, [5, 100, 900, 20], 'claude-haiku-4-5'),
        user(`${day}2Z`, { kind: 'task-notification' }),
        ...assistant('s2', `${day}3Z`, [5, 100, 900, 20], 'claude-sonnet-5'),
    ]));
    writeFileSync(join(projects, 'sess0001', 'subagents', 'agent-a1.meta.json'), JSON.stringify({ agentType: 'Explore', description: SENTINEL }));
});

test('pick keeps usage and metadata and drops content', () => {
    const rec = pick(assistant('m1', '2026-09-25T10:00:00Z', [1, 2, 3, 4])[0]);
    assert.deepEqual(rec.usage, { fresh: 1, write: 2, read: 3, out: 4 });
    assert.equal(rec.model, 'claude-opus-5-5');
    assert.doesNotMatch(JSON.stringify(rec), /SENTINEL/);
    assert.doesNotMatch(JSON.stringify(pick(user('x', { kind: 'peer', handback: true, body: SENTINEL }))), /SENTINEL/);
});

test('turns dedupe by message id; wake-ups and prompts come from origin metadata', () => {
    const r = run('--date', '2026-09-25', '--json');
    assert.equal(r.code, 0, r.err);
    const { day } = JSON.parse(r.out);
    assert.equal(day.turns, 3);
    assert.equal(day.read, 5000 + 6100 + 6310);
    assert.equal(day.out, 220);
    assert.deepEqual([day.prompts, day.wakesNotif, day.wakesHandback], [1, 1, 1]);
    assert.deepEqual([day.subagents, day.subTurns, day.subWakes], [1, 2, 1]);
    assert.deepEqual(day.subByModel, { haiku: 1025, sonnet: 1025 });
    // second subagent turn: same context as the first, minus the first turn's 20 output tokens -> 0 growth
    assert.deepEqual([day.subGrowth, day.subGrowthN], [0, 1]);
});

test('report size is context growth after a handback minus the prior output', () => {
    const { day } = JSON.parse(run('--date', '2026-09-25', '--json').out);
    // ctx before = 10+200+6100 = 6310, prior output 50; ctx after = 10+1300+6310 = 7620
    assert.equal(day.reportCount, 1);
    assert.equal(day.reportTokens, 7620 - 6310 - 50);
});

test('no content reaches any output', () => {
    for (const args of [['--json'], ['--write', '--compare'], ['--curve']]) {
        const r = run('--date', '2026-09-25', ...args);
        assert.doesNotMatch(r.out + r.err, /SENTINEL/);
    }
    assert.doesNotMatch(readFileSync(tablePath(), 'utf8'), /SENTINEL/);
});

test('write is idempotent: rerunning a day replaces its row and keeps the rest', () => {
    mkdirSync(join(vault, 'Projects', 'test-proj', 'Research'), { recursive: true });
    writeFileSync(tablePath(), '# kept heading\n\nnotes Jack wrote\n\n| Date | x |\n|---|---|\n| 2026-09-20 | 1 | 2 | 3 | 4 | 5 (1/4) | 1k | 1k | 1M | 0 | 100k | 1 | 1 | - | 1k | 1k |\n');
    run('--date', '2026-09-25', '--write');
    run('--date', '2026-09-25', '--write');
    const text = readFileSync(tablePath(), 'utf8');
    assert.equal(text.match(/^\| 2026-09-25 \|/gm).length, 1);
    assert.match(text, /^\| 2026-09-20 \|/m);
    assert.match(text, /notes Jack wrote/);
    assert.match(text, /\| 2026-09-25 \| 1 \| 3 \| 1 \| 2 \(1\/1\) \|/);
});

test('compare flags a >20% regression against the 7-day median', () => {
    const row = (d, turns) => [d, '1', String(turns), '1', '0 (0/0)', '1k', '1k', '1M', '0', '100k', '0', '0', '-', '1k', '1k'];
    const rows = new Map([['2026-09-22', row('2026-09-22', 100)], ['2026-09-23', row('2026-09-23', 100)], ['2026-09-25', row('2026-09-25', 130)]]);
    const turns = compare('2026-09-25', rows, '2026-09-23').find((c) => c.name === 'Turns');
    assert.equal(turns.median7, 100);
    assert.equal(turns.baseline, 100);
    assert.equal(turns.regression, true);
});

test('compact and uncompact round-trip within rounding', () => {
    for (const n of [0, 950, 12_345, 7_654_321, 2_345_678_901]) {
        const back = uncompact(compact(n));
        assert.ok(Math.abs(back - n) / Math.max(n, 1) < 0.01, `${n} -> ${compact(n)} -> ${back}`);
    }
});
