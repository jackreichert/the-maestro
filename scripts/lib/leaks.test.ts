// Run: node --test scripts/lib/leaks.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseModelPrices } from '../local-config.ts';
import { leaks, formatLeaks } from './leaks.ts';
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
