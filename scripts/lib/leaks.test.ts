// Run: node --test scripts/lib/leaks.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseModelPrices } from '../local-config.ts';
import { leaks, formatLeaks } from './leaks.ts';
import type { Leak } from './leaks.ts';
import { collectTranscripts } from '../token-metrics.ts';

// Hermetic: never read the user's config file (see local-config.ts).
process.env.MAESTRO_LOCAL_CONFIG = '';

const SCRIPT = new URL('../token-metrics.ts', import.meta.url).pathname;
const SENTINEL = 'SENTINEL_CONTENT_fake_id_123';
const PRICES_TEXT = 'opus: input=4, cache_write_5m=5, cache_write_1h=8, cache_read=0.2, output=20; sonnet: input=2, cache_write_5m=2.5, cache_write_1h=4, cache_read=0.2, output=10; haiku: input=1, cache_write_5m=1.25, cache_write_1h=2, cache_read=0.1, output=5';
const PRICES = parseModelPrices(PRICES_TEXT);
const M = 1_000_000;

type Usage = Record<string, unknown>;
interface Call { name: string; input?: Record<string, unknown> }
let seq = 0;
/** One assistant response, with the tool calls it made. Tokens are given in millions so the dollars are round. */
function turn(at: string, model: string, usage: Usage, calls: Call[] = []) {
    seq += 1;
    return { type: 'assistant', timestamp: at, message: { id: `msg_${seq}`, role: 'assistant', model, usage, content: [{ type: 'text', text: SENTINEL }, ...calls.map((c, i) => ({ type: 'tool_use', id: `tu_${seq}_${i}`, name: c.name, input: c.input ?? {} }))] } };
}
const toolResult = (turnSeq: number, chars: number, i = 0) => ({ type: 'user', timestamp: '2026-09-26T10:00:30Z', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: `tu_${turnSeq}_${i}`, content: 'x'.repeat(chars) }] } });
const jsonl = (recs: unknown[]): string => `${recs.map((r) => JSON.stringify(r)).join('\n')}\n`;
const use = (fresh: number, write: number, read: number, out: number): Usage => ({ input_tokens: fresh, cache_creation_input_tokens: write, cache_read_input_tokens: read, output_tokens: out });

interface Fixture { orch?: unknown[]; subs?: { type: string; recs: unknown[] }[] }
/** A projects dir with one session and its subagents. */
function fixture({ orch = [], subs = [] }: Fixture): string {
    const dir = mkdtempSync(join(tmpdir(), 'leaks-'));
    writeFileSync(join(dir, 'sess1.jsonl'), jsonl(orch));
    if (subs.length) mkdirSync(join(dir, 'sess1', 'subagents'), { recursive: true });
    subs.forEach((s, i) => {
        writeFileSync(join(dir, 'sess1', 'subagents', `agent-a${i}.jsonl`), jsonl(s.recs));
        writeFileSync(join(dir, 'sess1', 'subagents', `agent-a${i}.meta.json`), JSON.stringify({ agentType: s.type, description: SENTINEL }));
    });
    return dir;
}
const run = (dir: string, ...args: string[]) => spawnSync(process.execPath, [SCRIPT, '--leaks', ...args, '--projects-dir', dir], { encoding: 'utf8', env: { ...process.env, VAULT_ROOT: '', TZ: 'UTC', MAESTRO_MODEL_PRICES: PRICES_TEXT } });
const report = (dir: string) => leaks(collectTranscripts(dir), PRICES);
const T = (s: number): string => `2026-09-26T10:00:${String(s).padStart(2, '0')}Z`;

test('read-only subagents: judged by the tools they called, repriced at Haiku, grouped by agent type', () => {
    const read = (model: string, n: number) => Array.from({ length: n }, (_, i) => turn(T(i), model, use(M, 0, 9 * M, M / 10), [{ name: 'Read', input: { file_path: '/p/a.ts' } }, { name: 'Bash', input: { command: 'grep -rn x .' } }]));
    const dir = fixture({ subs: [
        { type: 'explorer', recs: read('claude-sonnet-5', 2) },
        { type: 'explorer', recs: read('claude-opus-5', 1) },
        { type: 'builder', recs: [turn(T(0), 'claude-sonnet-5', use(M, 0, 9 * M, M / 10), [{ name: 'Read' }, { name: 'Edit' }])] },
        { type: 'scribe', recs: [turn(T(0), 'claude-sonnet-5', use(M, 0, 9 * M, M / 10), [{ name: 'Bash', input: { command: `echo ${SENTINEL} > out.txt` } }])] },
        { type: 'thinker', recs: [turn(T(0), 'claude-sonnet-5', use(M, 0, 9 * M, M / 10))] },
        { type: 'cheap', recs: read('claude-haiku-5', 1) },
    ] });
    const [l] = report(dir);
    // sonnet turn: 4.8 at sonnet, 2.4 at haiku -> 2.4 each, two turns; opus turn: 4+1.8*... = 4 + 9*0.2 + 0.1*20 = 7.8 vs 2.4 -> 5.4
    assert.equal(l.bucket, 'Read-only subagents on a dearer model, repriced at Haiku');
    assert.ok(Math.abs(l.usd - (2.4 * 2 + 5.4)) < 1e-9, String(l.usd));
    assert.deepEqual(l.detail, ['explorer: 2 runs, $10.20']);
    assert.match(l.fix, /model: haiku/);
});

test('subagent cache TTL: avoided rewrites within the hour minus the extra paid on every 5m write, none reported when it costs more', () => {
    const at = (iso: string) => `2026-09-26T${iso}Z`;
    const write = (when: string, tokens: number) => turn(at(when), 'claude-sonnet-5', use(0, tokens, 0, 0));
    // sonnet: 5m write 2.5, 1h write 4, read 0.2 per MTok. Rewrite avoided = 2M x (2.5 - 0.2) = 4.6; extra on a 2M write = 2M x 1.5 = 3.
    const dir = fixture({ subs: [{ type: 'any', recs: [
        write('10:00:00', 0.1 * M),
        write('10:10:00', 2 * M), write('10:20:00', 2 * M), write('10:30:00', 2 * M), write('10:40:00', 2 * M),
        write('12:40:00', 2 * M), // a 2h gap: a 1h TTL has lapsed too, so no rewrite avoided, but the write costs more
    ] }], orch: [write('10:00:00', 50 * M)] });
    const [l] = report(dir);
    assert.equal(l.bucket, 'Subagent prompt cache on a 1h TTL instead of 5m');
    assert.ok(Math.abs(l.usd - (4 * 4.6 - (0.15 + 5 * 3))) < 1e-9, String(l.usd));
    assert.match(l.detail[0], /4 expiry rewrites within the hour avoided, \$18\.40; every 5m write at the 1h price costs \$15\.15 more/);
    assert.match(l.fix, /subagentPromptCacheTtl/);
    // One rewrite avoided (4.6) does not pay for the extra on two big writes (6.0): not a leak.
    const small = fixture({ subs: [{ type: 'any', recs: [write('10:00:00', 2 * M), write('10:10:00', 2 * M)] }] });
    assert.deepEqual(report(small), []);
});

test('roll replay: past the threshold the context drops to the floor, reads are avoided, the new base is written once; a threshold that does not pay reports nothing', () => {
    const at = (n: number) => `2026-09-26T10:${String(n).padStart(2, '0')}:00Z`;
    // opus: read 0.2, 5m write 5 per MTok. Threshold 1M, floor 0.2M. Turn 1 reads 0.9M; turns 2..9 read 1.1M, 1.2M ... 1.8M.
    const ctxs = [0.9, 1.1, 1.2, 1.3, 1.4, 1.5, 1.6, 1.7, 1.8];
    const orch = ctxs.map((c, i) => turn(at(i), 'claude-opus-5', use(0, 0, c * M, 0)));
    const dir = fixture({ orch });
    const roll = (d: string, rollTokens: number) => leaks(collectTranscripts(d), PRICES, { rollTokens, floorTokens: 0.2 * M });
    // Rolling at turn 2 sets the base to 0.9M: every later read is 0.9M lower. 8 turns x 0.9M x 0.2 = 1.44, less 0.2M x 5 = 1.00.
    const [l] = roll(dir, M);
    assert.match(l.bucket, /^Compaction replayed at the roll threshold \(1000k tokens\)/);
    assert.ok(Math.abs(l.usd - 0.44) < 1e-9, String(l.usd));
    assert.match(l.detail[0], /1 session ran past it \(1 roll replayed\)/);
    // Nothing passes a 2M threshold, so nothing to avoid. A session that never gets past it is untouched.
    assert.deepEqual(roll(dir, 2 * M), []);
    // Two turns past the threshold do not repay the 1.00 write.
    assert.deepEqual(roll(fixture({ orch: ctxs.slice(0, 3).map((c, i) => turn(at(i), 'claude-opus-5', use(0, 0, c * M, 0))) }), M), []);
    // Without a threshold the bucket is not computed at all.
    assert.deepEqual(leaks(collectTranscripts(dir), PRICES), []);
});

test('huge results: tool and file basename, priced over every later turn until a compaction, small results ignored, content never printed', () => {
    const at = (n: number) => `2026-09-26T10:0${n}:00Z`;
    const call = (when: string, model: string, c: Call): [ReturnType<typeof turn>, number] => { const x = turn(when, model, use(0, 0, M, 0), [c]); return [x, seq]; };
    const [t1, s1] = call(at(1), 'claude-opus-5', { name: 'Read', input: { file_path: '/some/dir/big.log' } });
    const [t3, s3] = call(at(3), 'claude-sonnet-5', { name: 'Bash', input: { command: `echo ${SENTINEL}` } });
    const orch = [
        t1, toolResult(s1, 80_000),
        turn(at(2), 'claude-opus-5', use(0, 0, M, 0)), // the result's first turn: written, not yet carried
        t3, toolResult(s3, 8_000), // 2k tokens: small
        turn(at(4), 'claude-haiku-5', use(0, 0, M, 0)), // carried at haiku's read price, 0.1
        turn(at(5), 'claude-opus-5', use(0, 0, M, 0)), // and opus's, 0.2, as t3 (sonnet) did
        { type: 'system', subtype: 'compact_boundary' },
        turn(at(6), 'claude-opus-5', use(0, 0, M, 0)), // after a compaction: not carried
    ];
    const [g1, sg] = call(at(1), 'claude-sonnet-5', { name: 'Grep' });
    const subs = [{ type: 'any', recs: [g1, toolResult(sg, 100_000), turn(at(2), 'claude-sonnet-5', use(0, 0, M, 0)), turn(at(3), 'claude-sonnet-5', use(0, 0, M, 0))] }];
    // Read big.log: 20k tokens x (sonnet 0.2 + haiku 0.1 + opus 0.2 per MTok: the result first appears in turn 2, turns 3 to 5 carry it, turn 6 follows a compaction)
    // Grep: 25k tokens x one later sonnet turn at 0.2
    const l = report(fixture({ orch, subs })).find((x) => x.bucket.startsWith('Huge')) as Leak;
    assert.match(l.bucket, /^Huge tool results \(8k tokens or more\)/);
    assert.ok(Math.abs(l.usd - (20_000 * 0.5 + 25_000 * 0.2) / 1e6) < 1e-12, String(l.usd));
    assert.deepEqual(l.detail, ['Read big.log: 1 result, avg 20k tokens, carried $0.01', 'Grep: 1 result, avg 25k tokens, carried $0.01']);
    assert.doesNotMatch(formatLeaks([l]), /SENTINEL/);
});

test('--leaks CLI prints the ranked report and no content; without prices it says so', () => {
    const dir = fixture({ subs: [{ type: 'explorer', recs: [turn(T(0), 'claude-sonnet-5', use(M, 0, 9 * M, M / 10), [{ name: 'Read', input: { file_path: `/p/${SENTINEL}`.replace(SENTINEL, 'a.ts') } }])] }] });
    const r = run(dir);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /^1\. \$2\.40  Read-only subagents/m);
    assert.match(r.stdout, /explorer: 1 run, \$2\.40/);
    assert.doesNotMatch(r.stdout + r.stderr, /SENTINEL/);
    const bare = spawnSync(process.execPath, [SCRIPT, '--leaks', '--projects-dir', dir], { encoding: 'utf8', env: { ...process.env, VAULT_ROOT: '', TZ: 'UTC', MAESTRO_MODEL_PRICES: '' } });
    assert.match(bare.stdout, /Model prices are unset/);
});

test('an empty report says nothing was found', () => {
    assert.match(formatLeaks(leaks({ orch: [], subs: [] }, PRICES)), /nothing found/);
    assert.deepEqual(leaks({ orch: [], subs: [] }, { opus: PRICES.opus }), []);
});
