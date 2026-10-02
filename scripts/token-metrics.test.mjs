// Run: node --test scripts/token-metrics.test.mjs
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pick, compare, uncompact, compact, emptyDirWarning, sessionLine, mixCell, parseMix, toRow } from './token-metrics.mjs';

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

test('pick reads compaction as two metadata flags and never the summary text', () => {
    const boundary = pick({ type: 'system', subtype: 'compact_boundary', compactMetadata: { trigger: 'auto', summary: SENTINEL }, content: SENTINEL });
    const summary = pick({ type: 'user', isCompactSummary: true, message: { role: 'user', content: SENTINEL } });
    assert.deepEqual([boundary.compact, summary.compact], [true, true]);
    assert.equal(pick(user('x', { kind: 'human' })).compact, false);
    assert.equal(pick({ type: 'system', subtype: 'other' }).compact, false);
    assert.equal(pick({ type: 'user', isCompactSummary: SENTINEL }).compact, false, 'only a boolean true counts');
    assert.doesNotMatch(JSON.stringify([boundary, summary]), /SENTINEL/);
    // The allowlist is the whole output shape: a new field here is a new thing the script reads.
    assert.deepEqual(Object.keys(boundary).sort(), ['compact', 'handback', 'id', 'model', 'originKind', 'role', 'subtype', 'ts', 'type', 'usage']);
});

test('model mix covers orchestrator and subagent turns by family; units price the token kinds', () => {
    const { day } = JSON.parse(run('--date', '2026-09-25', '--json').out);
    assert.deepEqual(Object.keys(day.mix).sort(), ['haiku', 'opus', 'sonnet']);
    assert.equal(day.mix.opus.read, 5000 + 6100 + 6310);
    assert.equal(day.mix.haiku.read, 900);
    assert.equal(day.mix.sonnet.read, 900);
    // m1: fresh 10 + 1.25*1000 + 0.1*5000 + 5*100
    assert.equal(day.mix.haiku.units, 5 + 1.25 * 100 + 0.1 * 900 + 5 * 20);
    assert.equal(mixCell(day.mix, 'read'), 'opus 17.4k · haiku 900 · sonnet 900');
});

test('mix cells round-trip through the table', () => {
    const mix = { opus: { read: 1_200_000, units: 3e6 }, haiku: { read: 0, units: 500 }, sonnet: { read: 40_000, units: 9e4 } };
    assert.equal(mixCell(mix, 'read'), 'opus 1.2M · sonnet 40.0k');
    assert.deepEqual(parseMix(mixCell(mix, 'units')), { opus: 3e6, sonnet: 90000, haiku: 500 });
    assert.deepEqual(parseMix('-'), {});
    assert.deepEqual(parseMix(undefined), {});
});

test('compaction restarts the since-compact count; the day keeps the longest run', () => {
    const day = '2026-09-26T10:00:0';
    const turn = (n) => assistant(`c${n}`, `${day}${n % 10}Z`, [1, 1, 100, 1]);
    writeFileSync(join(projects, 'sess0002.jsonl'), jsonl([
        ...[1, 2, 3, 4].flatMap(turn),
        { type: 'system', subtype: 'compact_boundary', timestamp: `${day}5Z` },
        { type: 'user', isCompactSummary: true, timestamp: `${day}5Z`, message: { role: 'user', content: SENTINEL } },
        ...[5, 6].flatMap(turn),
    ]));
    const r = JSON.parse(run('--date', '2026-09-26', '--json').out);
    assert.equal(r.day.turns, 6);
    assert.equal(r.day.sinceCompact, 4);
    assert.equal(r.sessions[0].sinceCompact, 4);
    // no marker at all: the count is the whole session
    assert.equal(JSON.parse(run('--date', '2026-09-25', '--json').out).day.sinceCompact, 3);
});

test('small agents (<10 turns) and Opus subagents are counted per subagent', () => {
    const day = '2026-09-27T10:00:0';
    writeFileSync(join(projects, 'sess0003.jsonl'), jsonl([user(`${day}0Z`, { kind: 'human' }), ...assistant('o1', `${day}1Z`, [1, 1, 10, 1])]));
    const sub = (name, n, model) => writeFileSync(join(projects, 'sess0003', 'subagents', `agent-${name}.jsonl`),
        jsonl(Array.from({ length: n }, (_, i) => assistant(`${name}${i}`, `${day}${i % 10}Z`, [1, 1, 100, 10], model)[0])));
    mkdirSync(join(projects, 'sess0003', 'subagents'), { recursive: true });
    sub('small', 9, 'claude-sonnet-5');
    sub('edge', 10, 'claude-haiku-4-5');
    sub('opus', 3, 'claude-opus-5-5');
    const { day: d } = JSON.parse(run('--date', '2026-09-27', '--json').out);
    assert.deepEqual([d.subagents, d.subSmall, d.subOpus], [3, 2, 1]);
    assert.deepEqual(d.subByModel.opus, 3 * (1 + 1 + 100 + 10));
    const row = toRow(d);
    assert.deepEqual(row.slice(17), ['1', '2', '1', '336'], 'since compact, small agents, Opus subagents, Opus sub tokens');
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

test('emptyDirWarning names a missing or empty projects dir and stays quiet for one with sessions', () => {
    assert.match(emptyDirWarning(join(projects, 'nope')), /no sessions in .*nope \(directory does not exist\).*projects_dir/);
    const empty = mkdtempSync(join(tmpdir(), 'tm-empty-'));
    assert.match(emptyDirWarning(empty), /no sessions in /);
    assert.equal(emptyDirWarning(projects), '');
});

test('CLI: warns on stderr when the projects dir has no sessions, instead of crashing', () => {
    const empty = mkdtempSync(join(tmpdir(), 'tm-empty-'));
    const r = spawnSync(process.execPath, [SCRIPT, '--json', '--projects-dir', empty], { encoding: 'utf8', env: { ...process.env, VAULT_ROOT: '', TZ: 'UTC' } });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stderr, /no sessions in/);
});

test('sessionLine reports the newest session against the thresholds', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tm-sess-'));
    assert.match(sessionLine(dir), /^\*\*Session:\*\* unavailable/);
    const u = (read) => ({ input_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: read, output_tokens: 1 });
    const line = (id, read) => JSON.stringify({ type: 'assistant', timestamp: '2026-10-02T10:00:00Z', message: { id, role: 'assistant', model: 'claude-opus-5-5', usage: u(read) } });
    writeFileSync(join(dir, 's2.jsonl'), `${line('a', 100000)}\n${line('a', 100000)}\n${line('b', 300000)}\n`);
    assert.equal(sessionLine(dir, 4, 350000), '**Session:** 2 turns (50% of 4 roll) · 200k read/turn');
    assert.equal(sessionLine(dir, 2, 350000), '**Session:** 2 turns (100% of 2 roll) · 200k read/turn · roll now');
    assert.equal(sessionLine(dir, 4, 200000), '**Session:** 2 turns (50% of 4 roll) · 200k read/turn · roll now');
});

test('sessionLine degrades to unavailable instead of throwing when the directory cannot be read', () => {
    const file = join(mkdtempSync(join(tmpdir(), 'tm-file-')), 'not-a-dir');
    writeFileSync(file, '');
    assert.match(sessionLine(file), /^\*\*Session:\*\* unavailable \(.* reading /);
});

test('sessionLine truncates so the rendered numbers never claim a threshold the roll decision has not reached', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tm-trunc-'));
    const line = (id, read) => JSON.stringify({ type: 'assistant', timestamp: '2026-10-02T10:00:00Z', message: { id, role: 'assistant', model: 'claude-opus-5-5', usage: { input_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: read, output_tokens: 1 } } });
    writeFileSync(join(dir, 's.jsonl'), `${line('a', 349500)}\n`);
    assert.equal(sessionLine(dir, 1000, 350000), '**Session:** 1 turns (0% of 1000 roll) · 349k read/turn');
    writeFileSync(join(dir, 's.jsonl'), `${Array.from({ length: 399 }, (_, i) => line(`m${i}`, 1)).join('\n')}\n`);
    assert.match(sessionLine(dir, 400, 350000), /\(99% of 400 roll\)(?! · roll now)/);
});
