// Run: node --test scripts/token-metrics.test.mjs
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pick, compare, uncompact, compact, emptyDirWarning, sessionLine, mixCell, parseMix, toRow, shares, kindsOf, kindsCell, parseKinds, dollars, priceFamilies, pricedShares, sonnetWhatIf } from './token-metrics.mjs';
import { parseModelPrices } from './local-config.ts';

// Hermetic: never read the user's config file (see local-config.ts).
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
    assert.deepEqual(rec.usage, { fresh: 1, write: 2, write5m: 0, write1h: 0, read: 3, out: 4 });
    assert.equal(rec.model, 'claude-opus-5-5');
    assert.doesNotMatch(JSON.stringify(rec), /SENTINEL/);
    assert.doesNotMatch(JSON.stringify(pick(user('x', { kind: 'peer', handback: true, body: SENTINEL }))), /SENTINEL/);
});

test('pick reads the 5m/1h cache-write split as two numbers and nothing else of cache_creation', () => {
    const line = assistant('m1', '2026-09-25T10:00:00Z', [1, 100, 3, 4])[0];
    line.message.usage.cache_creation = { ephemeral_5m_input_tokens: 60, ephemeral_1h_input_tokens: 40, note: SENTINEL, ephemeral_9h_input_tokens: 7 };
    const rec = pick(line);
    assert.deepEqual(rec.usage, { fresh: 1, write: 100, write5m: 60, write1h: 40, read: 3, out: 4 });
    assert.doesNotMatch(JSON.stringify(rec), /SENTINEL/);
    line.message.usage.cache_creation = SENTINEL;
    assert.deepEqual(pick(line).usage, { fresh: 1, write: 100, write5m: 0, write1h: 0, read: 3, out: 4 });
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

test('model mix covers orchestrator and subagent turns by family; tokens are kept by price kind per side', () => {
    const { day } = JSON.parse(run('--date', '2026-09-25', '--json').out);
    assert.deepEqual(Object.keys(day.mix).sort(), ['haiku', 'opus', 'sonnet']);
    assert.equal(day.mix.opus.read, 5000 + 6100 + 6310);
    assert.equal(day.mix.haiku.read, 900);
    assert.equal(day.mix.sonnet.read, 900);
    assert.equal(mixCell(day.mix, 'read'), 'opus 17410 · haiku 900 · sonnet 900');
    assert.deepEqual(Object.keys(day.orch), ['opus'], 'the orchestrator ran on opus only');
    assert.deepEqual(day.orch.opus, { fresh: 30, w5: 2500, w1: 0, read: 17410, out: 220 }, 'no split in usage: every write is 5m');
    assert.deepEqual(Object.keys(day.sub).sort(), ['haiku', 'sonnet']);
    assert.deepEqual(day.sub.haiku, { fresh: 5, w5: 100, w1: 0, read: 900, out: 20 });
});

test('kinds cells round-trip through the table and old unit cells read as empty', () => {
    const by = { opus: { fresh: 1, w5: 2, w1: 3, read: 4, out: 5 }, haiku: { fresh: 0, w5: 0, w1: 0, read: 0, out: 0 }, sonnet: { fresh: 9, w5: 0, w1: 0, read: 100, out: 1 } };
    assert.equal(kindsCell(by), 'sonnet 9/0/0/100/1 · opus 1/2/3/4/5');
    assert.deepEqual(parseKinds(kindsCell(by)), { sonnet: by.sonnet, opus: by.opus });
    assert.deepEqual(parseKinds('-'), {});
    assert.deepEqual(parseKinds('opus 3000000 · sonnet 90000'), {}, 'a pre-dollars units cell is not misread');
});

test('mix cells round-trip through the table', () => {
    const mix = { opus: { read: 1_200_000 }, haiku: { read: 0 }, sonnet: { read: 40_000 } };
    assert.equal(mixCell(mix, 'read'), 'opus 1200000 · sonnet 40000');
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
    assert.deepEqual(row.slice(17, 21), ['1', '2', '1', '336'], 'since compact, small agents, Opus subagents, Opus sub tokens');
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

// A table row as toRow writes it: 22 cells, with the cost columns filled from the arguments.
const costRow = (d, { prompts = 10, wakes = 4, read = '1M', mixRead = 'opus 400k · sonnet 400k · haiku 200k', mixOrch = 'opus 0/0/0/1000000/0 · sonnet 0/0/0/1000000/0', mixSub = 'haiku 0/0/0/1000000/0', since = 100, subs = 10, small = 2, opusSubs = 1 } = {}) =>
    [d, '1', '100', String(prompts), `${wakes} (${wakes}/0)`, '1k', '1k', '1M', '0', read, String(subs), '1', '-', '1k', '1k', mixRead, mixOrch, String(since), String(small), String(opusSubs), '5.0M', mixSub];
const byName = (list, name) => list.find((c) => c.name === name);

test('compare scores each cost metric against its target: PASS, MISS, or - without one', () => {
    const rows = new Map([['2026-09-22', costRow('2026-09-22')], ['2026-09-23', costRow('2026-09-23')],
        ['2026-09-25', costRow('2026-09-25', { mixRead: 'opus 500k · sonnet 450k · haiku 50k', wakes: 4, since: 200, read: '300k' })]]);
    const c = compare('2026-09-25', rows, '2026-09-23', { prices: null });
    const s = (n) => byName(c, n).status;
    assert.deepEqual([s('Opus share (read)'), s('Haiku share (read)'), s('Wakes/prompt'), s('Max turns/compact'), s('Read/turn')], ['MISS', 'MISS', 'PASS', 'MISS', 'MISS']);
    assert.equal(byName(c, 'Opus share (read)').today, 0.5);
    assert.ok(Math.abs(byName(c, 'Opus share (read)').median7 - 0.4) < 0.01);
    assert.equal(byName(c, 'Haiku share (read)').regression, true, 'a falling haiku share is the regression');
    assert.equal(s('Sonnet share (read)'), '-');
    assert.equal(s('Small-agent rate'), '-');
    assert.equal(byName(c, 'Small-agent rate').today, 0.2);
    assert.equal(byName(c, 'Opus subagents').today, 1);
    assert.equal(byName(c, 'Max turns/compact').median7, 100);
});

test('targets come from the targets option; a pass flips to a miss when the limit moves', () => {
    const rows = new Map([['2026-09-25', costRow('2026-09-25')]]);
    const at = (t) => byName(compare('2026-09-25', rows, '2026-09-24', { prices: null, targets: t }), 'Opus share (read)').status;
    assert.equal(at({ opus_share_max: 40 }), 'PASS');
    assert.equal(at({ opus_share_max: 30 }), 'MISS');
    assert.equal(at({}), '-', 'no target configured, no verdict');
});

const PRICES_TEXT = 'opus: input=4, cache_write_5m=5, cache_write_1h=8, cache_read=0.2, output=20; sonnet: input=2, cache_write_5m=2.5, cache_write_1h=4, cache_read=0.2, output=10; haiku: input=1, cache_write_5m=1.25, cache_write_1h=2, cache_read=0.1, output=5';
const PRICES = parseModelPrices(PRICES_TEXT);
const near = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) < eps, `${a} != ${b}`);

test('dollars price each kind per MTok: Opus cache reads cost 0.05x input, Sonnet 0.1x', () => {
    const million = { fresh: 0, w5: 0, w1: 0, read: 1e6, out: 0 };
    near(dollars(million, PRICES.opus).read, 0.2);
    near(dollars(million, PRICES.opus).read / PRICES.opus.input, 0.05);
    near(dollars(million, PRICES.sonnet).read / PRICES.sonnet.input, 0.1);
    near(dollars(million, PRICES.haiku).read / PRICES.haiku.input, 0.1);
    const d = dollars({ fresh: 1e6, w5: 1e6, w1: 1e6, read: 1e6, out: 1e6 }, PRICES.opus);
    assert.deepEqual([d.input, d.write, d.read, d.output], [4, 13, 0.2, 20], 'write is 5m 5 + 1h 8');
    near(d.total, 37.2);
});

test('a write with no usage split prices as 5m; a split prices 5m and 1h separately', () => {
    const turn = { fresh: 0, write: 1e6, write5m: 0, write1h: 0, read: 0, out: 0 };
    near(dollars(kindsOf(turn), PRICES.opus).write, 5);
    near(dollars(kindsOf({ ...turn, write5m: 600000, write1h: 400000 }), PRICES.opus).write, 0.6 * 5 + 0.4 * 8);
});

// Opus and Sonnet totals from a real /cost screen (one session, no 5m/1h split): Opus 176.4M read, 5.0M write, 816.5k output,
// 237.2k input = $85.41 billed; Sonnet 179.3M read, 7.6M write, 1.1M output, 587.9k input = $73.84 billed. The estimate runs about
// 9% low because the billed figure includes 1h writes, which cost more than the 5m price used when usage carries no split.
const REAL = {
    opus: { fresh: 237_200, w5: 5_000_000, w1: 0, read: 176_400_000, out: 816_500 },
    sonnet: { fresh: 587_900, w5: 7_600_000, w1: 0, read: 179_300_000, out: 1_100_000 },
};

test('real session totals price within 10% of the billed figures, the gap being 1h writes', () => {
    const d = priceFamilies(REAL, PRICES);
    near(d.opus.read, 35.28);
    near(d.opus.total, 77.5588, 1e-6);
    near(d.sonnet.total, 67.0358, 1e-6);
    assert.ok(Math.abs(d.opus.total / 85.41 - 1) < 0.1);
    assert.ok(Math.abs(d.sonnet.total / 73.84 - 1) < 0.1);
    // Moving about 2.6M of Opus writes and 4.5M of Sonnet writes to the 1h price closes the gap to within 20 cents.
    const split = priceFamilies({ opus: { ...REAL.opus, w5: 2_400_000, w1: 2_600_000 }, sonnet: { ...REAL.sonnet, w5: 3_100_000, w1: 4_500_000 } }, PRICES);
    assert.ok(Math.abs(split.opus.total - 85.41) < 0.2 && Math.abs(split.sonnet.total - 73.84) < 0.2, `${split.opus.total} ${split.sonnet.total}`);
});

test('what-if reprices the same tokens at Sonnet prices, Sonnet itself unchanged, unpriced families left out', () => {
    const w = sonnetWhatIf({ opus: REAL.opus }, PRICES);
    near(w.actual, 77.5588, 1e-6);
    // read 35.28 (same), write 5.0M x 2.5, output 0.8165M x 10, input 0.2372M x 2
    near(w.onSonnet, 35.28 + 12.5 + 8.165 + 0.4744, 1e-6);
    const s = sonnetWhatIf({ sonnet: REAL.sonnet }, PRICES);
    near(s.onSonnet, s.actual);
    const k = { fresh: 1e6, w5: 0, w1: 0, read: 0, out: 0 };
    assert.deepEqual(sonnetWhatIf({ opus: k, haiku: k, fable: k }, PRICES), { actual: 4 + 1, onSonnet: 2 + 2 });
});

test('priced shares are shares of dollars, other families count by the other row, and none left is NaN', () => {
    const k = { fresh: 0, w5: 0, w1: 0, read: 1e6, out: 0 };
    const sh = pricedShares(priceFamilies({ opus: k, sonnet: k, haiku: k }, PRICES));
    near(sh.opus, 0.2 / 0.5);
    near(sh.haiku, 0.1 / 0.5);
    assert.ok(Number.isNaN(pricedShares({}).opus));
    assert.deepEqual(Object.keys(priceFamilies({ fable: k }, PRICES)), [], 'no other row: left out of the dollars');
    const withOther = { ...PRICES, other: PRICES.opus };
    near(pricedShares(priceFamilies({ opus: k, fable: k }, withOther)).opus, 0.5);
});

test('priced metrics weight dollars, exist only with prices, and the Opus target defaults to 50%', () => {
    const rows = new Map([['2026-09-25', costRow('2026-09-25', {
        mixOrch: 'opus 0/0/0/1000000/0 · sonnet 0/0/0/1000000/0', mixSub: 'haiku 0/0/0/1000000/0' })]]);
    assert.equal(byName(compare('2026-09-25', rows, '2026-09-24', { prices: null }), 'Opus share (priced)'), undefined);
    const c = compare('2026-09-25', rows, '2026-09-24', { prices: PRICES, targets: { opus_priced_share_max: 50 } });
    near(byName(c, 'Opus share (priced)').today, 0.2 / 0.5);
    near(byName(c, 'Haiku share (priced)').today, 0.1 / 0.5);
    assert.equal(byName(c, 'Opus share (priced)').status, 'PASS');
    assert.equal(byName(c, 'Haiku share (priced)').status, '-', 'no Haiku priced target');
    near(byName(c, 'Est. $ orchestrator').today, 0.4);
    near(byName(c, 'Est. $ subagents').today, 0.1);
    assert.equal(byName(compare('2026-09-25', rows, '2026-09-24', { prices: PRICES, targets: { opus_priced_share_max: 30 } }), 'Opus share (priced)').status, 'MISS');
});

test('a day with subagents but no subagent cell has no subagent dollars instead of zero', () => {
    const old = costRow('2026-09-25', { mixSub: '-', subs: 10 });
    assert.ok(Number.isNaN(byName(compare('2026-09-25', new Map([['2026-09-25', old]]), '2026-09-24', { prices: PRICES }), 'Est. $ subagents').today));
    const none = costRow('2026-09-25', { mixSub: '-', subs: 0 });
    assert.equal(byName(compare('2026-09-25', new Map([['2026-09-25', none]]), '2026-09-24', { prices: PRICES }), 'Est. $ subagents').today, 0);
});

test('rows from before the cost columns give no number instead of a wrong one', () => {
    const old = ['2026-09-20', '1', '100', '10', '4 (4/0)', '1k', '1k', '1M', '0', '100k', '5', '1', '-', '1k', '1k'];
    const c = compare('2026-09-25', new Map([['2026-09-20', old], ['2026-09-25', old]]), '2026-09-24', { prices: null });
    assert.ok(Number.isNaN(byName(c, 'Opus share (read)').today));
    assert.equal(byName(c, 'Opus share (read)').status, '-');
    assert.ok(Number.isNaN(byName(c, 'Small-agent rate').today));
});

test('CLI: the day summary shows the mix, the cost block and PASS/MISS; prices unset says so', () => {
    const r = run('--date', '2026-09-25');
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /model mix \(cache read\) opus 9[0-9]% · sonnet [0-9]+% · haiku [0-9]+%/);
    assert.match(r.out, /est\. cost +prices unset \(model_prices\): token mix only/);
    assert.match(r.out, /Cost targets 2026-09-25/);
    assert.match(r.out, /Opus share \(read\) +9\d% +.*<=40% +MISS/);
    assert.match(r.out, /Wakes\/prompt +2\.00 .*<=0\.50 +MISS/);
    assert.match(r.out, /Opus subagents: each should be design, decision or review work\./);
    assert.doesNotMatch(r.out, /share \(priced\)/);
    assert.doesNotMatch(r.out + r.err, /SENTINEL/);
});

test('CLI: with model_prices set the day shows dollars by side, model and category; --compare carries the same metrics', () => {
    const env = { ...process.env, VAULT_ROOT: '', TZ: 'UTC', MAESTRO_MODEL_PRICES: PRICES_TEXT, MAESTRO_COST_TARGETS: 'opus_share_max=95' };
    const go = (...a) => spawnSync(process.execPath, [SCRIPT, '--date', '2026-09-25', ...a, '--projects-dir', projects, '--vault', vault, '--project', 'test-proj'], { encoding: 'utf8', env });
    const day = go();
    assert.equal(day.status, 0, day.stderr);
    // orchestrator: opus 30 fresh, 2500 5m writes, 17410 read, 220 out
    const opus = (30 * 4 + 2500 * 5 + 17410 * 0.2 + 220 * 20) / 1e6;
    assert.match(day.stdout, new RegExp(`est\\. \\$/day orchestrator +\\$${opus.toFixed(2)}  read \\$0\\.00 · write \\$0\\.01 · output \\$0\\.00 · input \\$0\\.00`));
    assert.match(day.stdout, /est\. \$\/day subagents/);
    // what-if: the same orchestrator tokens at Sonnet prices
    const onSonnet = (30 * 2 + 2500 * 2.5 + 17410 * 0.2 + 220 * 10) / 1e6;
    assert.match(day.stdout, new RegExp(`what-if: orchestrator on Sonnet \\$${onSonnet.toFixed(2)} vs \\$${opus.toFixed(2)} actual \\(-\\d+%\\)\\. Same tokens repriced; ignores quality effects`));
    assert.match(day.stdout, /\n    opus +\$0\.02 /);
    assert.match(day.stdout, /\n    haiku +\$0\.00 /);
    assert.match(day.stdout, /model mix \(priced\) +opus \d+% · sonnet \d+% · haiku \d+%/);
    const cmp = go('--compare');
    assert.match(cmp.stdout, /Haiku share \(priced\)/);
    assert.match(cmp.stdout, /Est\. \$ orchestrator +\$0\.02/);
    assert.match(cmp.stdout, /Opus share \(priced\) +9\d% +.*<=50% +MISS/);
    assert.match(cmp.stdout, /Opus share \(read\) +9\d% +.*<=95% +PASS/);
    assert.match(cmp.stdout, /Max turns\/compact +3 .*<=150 +PASS/);
    assert.doesNotMatch(cmp.stdout, /Model prices are unset/);
    assert.doesNotMatch(day.stdout + cmp.stdout + day.stderr, /SENTINEL/);
});

test('a mix cell keeps whole-number precision, so a share just over the target is a MISS', () => {
    const mix = { opus: { read: 1_249_000 }, haiku: { read: 1_851_000 } };
    const rows = new Map([['2026-09-25', costRow('2026-09-25', { mixRead: mixCell(mix, 'read') })]]);
    const c = byName(compare('2026-09-25', rows, '2026-09-24', { prices: null }), 'Opus share (read)');
    assert.ok(c.today > 0.4 && c.today < 0.404);
    assert.equal(c.status, 'MISS');
});

