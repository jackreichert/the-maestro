import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { LedgerRow } from '../lib/ledger-core.ts';
import { continuityLines } from '../lib/continuous-roll.ts';
import { decisionsOnly, precompact } from './precompact.ts';
import type { PrecompactDeps } from './precompact.ts';
import { assemble, context } from './session-start-compact.ts';
import { snippet } from './print-settings-snippet.ts';

const T = '2026-10-09T12:00:00.000Z';
const transcript = JSON.stringify({ type: 'user', timestamp: '2026-10-09T11:00:00.000Z', message: { content: 'from now on never merge without a green suite' } });

function deps(over: Partial<PrecompactDeps> = {}): { d: PrecompactDeps; calls: string[][] } {
  const calls: string[][] = [];
  return { calls, d: { journal: (a) => { calls.push(a); return { ok: true, out: '' }; }, readLedger: () => [], newestHandoff: () => null, readTranscript: () => transcript, handoffPath: (d, w) => `/j/HANDOFF-${d}-precompact-${w}.md`, snapshot: () => ({ worktrees: 2, copied: 5, current: 3, skipped: 1, partial: false, capped: false }), now: () => new Date(T), autocompact: () => ({ pct: 20, window: null, source: 'env' }), ...over } };
}

test('precompact writes the handoff delta, raises the decision and ends with a marker row', () => {
  const { d, calls } = deps();
  const prior = process.env.MAESTRO_WINDOW;
  process.env.MAESTRO_WINDOW = 'envwin';
  let text: string;
  try { text = precompact({ transcript_path: '/t.jsonl', trigger: 'auto' }, d); } finally { if (prior === undefined) delete process.env.MAESTRO_WINDOW; else process.env.MAESTRO_WINDOW = prior; }
  assert.deepEqual(calls[0].slice(0, 2), ['log', 'precompact started (trigger auto, session unknown)'], 'the trace row comes before any slow work');
  assert.equal(calls[1][0], 'ask', 'decisions are raised before the handoff, so the asks land in it');
  assert.match(calls[1][1], /^unledgered decision\? \(1\) \[msg 2026-10-09T11:00:00.000Z [0-9a-f]{6}\]/);
  assert.deepEqual(calls[2], ['handoff', '--all', '--no-worktree-sweep', '--force', '--window', 'envwin', '--out', '/j/HANDOFF-2026-10-09-precompact-envwin.md']);
  assert.deepEqual(calls[3].slice(0, 2), ['log', text]);
  assert.match(text, /^precompact: handoff rewritten \(none before\), snapshot copied 5 \(3 current\), decisions raised 1 in 1 ask\(s\) \(trigger auto, session unknown\)$/);
});

test('a fresh handoff is still rewritten when this run raised asks, and the marker says why; with nothing raised it is left alone', () => {
  const row = (ts: string): LedgerRow => ({ ts, kind: 'done', text: 'work', stream: 'Maestro' } as LedgerRow);
  const fresh = (): Partial<PrecompactDeps> => ({ readLedger: () => [row('2026-10-09T11:00:00.000Z')], newestHandoff: () => ({ name: 'HANDOFF-2026-10-09-all.md', at: '2026-10-09T11:30:00.000Z' }) });
  const withAsk = deps(fresh());
  const text = precompact({ transcript_path: '/t.jsonl', trigger: 'auto' }, withAsk.d);
  assert.deepEqual(withAsk.calls.map((c) => c[0]), ['log', 'ask', 'handoff', 'log'], 'the handoff is written after the ask even though it looked fresh');
  assert.match(text, /^precompact: handoff rewritten \(to include 1 raised ask\(s\)\), snapshot copied 5/);
  const quiet = deps({ ...fresh(), readTranscript: () => '' });
  assert.match(precompact({ transcript_path: '/t.jsonl', trigger: 'auto' }, quiet.d), /^precompact: handoff current/);
  assert.deepEqual(quiet.calls.map((c) => c[0]), ['log', 'log'], 'no ask, fresh handoff: nothing is rewritten');
});

test('two windows compacting the same day write their own precompact handoff and never overwrite each other', () => {
  const dir = mkdtempSync(join(tmpdir(), 'precompact-'));
  try {
    // Stands in for `journal.ts handoff --force --out <path>`: it overwrites whatever is at the path, as the real flag does.
    const forceWrite = (a: string[]): { ok: boolean; out: string } => { if (a[0] === 'handoff') writeFileSync(a[a.indexOf('--out') + 1], `window: ${a[a.indexOf('--window') + 1]}\n`); return { ok: true, out: '' }; };
    const own = (): Partial<PrecompactDeps> => ({ journal: forceWrite, handoffPath: (date, w) => join(dir, `HANDOFF-${date}-precompact-${w}.md`) });
    precompact({ transcript_path: '/t', trigger: 'auto', session_id: 'aaaaaaaa-win-a' }, deps(own()).d);
    precompact({ transcript_path: '/t', trigger: 'auto', session_id: 'bbbbbbbb-win-b' }, deps(own()).d);
    precompact({ transcript_path: '/t', trigger: 'auto', session_id: 'aaaaaaaa-win-a' }, deps(own()).d);
    const files = readdirSync(dir).sort();
    assert.deepEqual(files, ['HANDOFF-2026-10-09-precompact-aaaaaaaa-win.md', 'HANDOFF-2026-10-09-precompact-bbbbbbbb-win.md'], 'one file per window, a repeat run by the same window reuses its own');
    assert.equal(readFileSync(join(dir, files[0]), 'utf8'), 'window: aaaaaaaa-win\n');
    assert.equal(readFileSync(join(dir, files[1]), 'utf8'), 'window: bbbbbbbb-win\n');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('precompact fails open: each failing step is named in an "incomplete" row and the others still run', () => {
  const { d, calls } = deps({
    journal: (a) => { calls.push(a); return a[0] === 'handoff' ? { ok: false, out: 'boom' } : { ok: true, out: '' }; },
    snapshot: () => { throw new Error('disk full'); },
    readTranscript: () => { throw new Error('ENOENT'); },
  });
  const text = precompact({ transcript_path: '/gone', trigger: 'manual' }, d);
  assert.match(text, /^precompact incomplete: decisions: ENOENT; handoff: boom; snapshot: disk full \(trigger manual, session unknown\)$/);
  assert.equal(calls.at(-1)?.[0], 'log');
});

test('precompact reports a missing transcript_path and an unset scripts_dir instead of skipping silently', () => {
  const { d } = deps({ snapshot: () => null });
  assert.match(precompact({}, d), /^precompact incomplete: decisions: no transcript_path in the hook input; snapshot: scripts_dir is not set/);
});

test('session-start context: only compact and clear print; the cold-start page sits before Start here so the cap never cuts it', () => {
  const run = (a: string[]) => (a[0] === 'prime' ? { ok: true, out: 'Board x' } : a[0] === 'start-here' ? { ok: true, out: 'start page' } : { ok: false, out: 'unknown' });
  assert.equal(context('startup', run, () => ({ ok: true, out: 'cold' })), '');
  const out = context('compact', run, () => ({ ok: true, out: '# Cold start\nwork' }));
  assert.match(out, /== Board \(journal\.ts prime\) ==/);
  assert.match(out, /== Cold start ==\n# Cold start\nwork\n\n== Start here ==\nstart page/);
});

test('session-start is a fail-open fallback: a missing, failing or throwing cold-start part is named and the rest still prints', () => {
  const run = (a: string[]) => (a[0] === 'prime' ? { ok: true, out: 'Board x' } : { ok: true, out: 'start page' });
  for (const cold of [undefined, () => ({ ok: false, out: 'no ledger\nboom' }), () => { throw new Error('exploded'); }]) {
    const out = context('compact', run, cold);
    assert.match(out, /== Cold start ==\nskipped: /);
    assert.match(out, /== Start here ==\nstart page/);
  }
});

test('session-start context passes --source to prime and caps the output', () => {
  const seen: string[][] = [];
  const out = context('clear', (a) => { seen.push(a); return { ok: true, out: Array.from({ length: 4000 }, (_, n) => `line ${n}`).join('\n') }; });
  assert.deepEqual(seen[0], ['prime', '--source', 'clear', '--no-update-check']);
  assert.ok(out.length < 20_300 && /cut at 20000/.test(out));
  assert.equal(assemble([{ title: 'a', body: 'b' }]), '== a ==\nb');
});

test('the settings snippet names both events with the matchers and passes flags through', () => {
  const s = snippet(['--project', "'p'"]) as { hooks: Record<string, { matcher: string; hooks: { command: string; timeout: number }[] }[]> };
  assert.equal(s.hooks.PreCompact[0].matcher, 'auto|manual');
  assert.equal(s.hooks.SessionEnd[0].matcher, 'clear|resume|logout|prompt_input_exit|other');
  assert.match(s.hooks.SessionEnd[0].hooks[0].command, /session-end-decisions\.ts' --project 'p'$/);
  assert.equal(s.hooks.SessionEnd[0].hooks[0].timeout, 30);
  assert.equal(s.hooks.SessionStart[0].matcher, 'compact|clear');
  assert.match(s.hooks.PreCompact[0].hooks[0].command, /precompact\.ts' --project 'p'$/);
  assert.equal(s.hooks.PreToolUse[0].matcher, 'Bash');
  assert.match(s.hooks.PreToolUse[0].hooks[0].command, /git-guard\.ts'$/, 'no pass-through flags reach the guard');
  assert.match(s.hooks.SessionStart[0].hooks[0].command, /session-start-compact\.ts' --project 'p'$/);
});

test('a partial snapshot (deadline hit) is reported as a failed step, not as success', () => {
  const { d } = deps({ snapshot: () => ({ worktrees: 3, copied: 4, current: 0, skipped: 0, partial: true, capped: false }) });
  assert.match(precompact({ transcript_path: '/t', trigger: 'auto' }, d), /^precompact incomplete: snapshot: time budget reached after 3 worktree\(s\) \(trigger auto, session unknown\)$/);
});

test('a failed decisions step does not move the scan memory, so the next run raises the decision', () => {
  const rows: LedgerRow[] = [];
  const log = (a: string[]): void => { if (a[0] === 'log') rows.push({ kind: 'note', ts: `2026-10-09T12:0${rows.length}:00.000Z`, text: a[1], used: ['hook:precompact'] }); };
  const first = deps({ readLedger: () => rows, readTranscript: () => { throw new Error('EACCES'); }, journal: (a) => { log(a); return { ok: true, out: '' }; } });
  assert.match(precompact({ transcript_path: '/t', trigger: 'auto' }, first.d), /decisions: EACCES/);
  const second = deps({ readLedger: () => rows, journal: (a) => { log(a); second.calls.push(a); return { ok: true, out: '' }; } });
  precompact({ transcript_path: '/t', trigger: 'auto' }, second.d);
  assert.ok(second.calls.some((c) => c[0] === 'ask'), 'the decision from before the failed run is raised now');
});

test('a capped snapshot is reported as a failed step', () => {
  const { d } = deps({ snapshot: () => ({ worktrees: 3, copied: 300, current: 0, skipped: 9, partial: false, capped: true }) });
  assert.match(precompact({ transcript_path: '/t', trigger: 'auto' }, d), /^precompact incomplete: snapshot: file or size cap reached after 300 file\(s\); later source was not copied /);
});

test('the started and result rows carry the same session tag, and 12 decisions go out in one ask row, none left pending', () => {
  const transcript12 = Array.from({ length: 12 }, (_, n) => JSON.stringify({ type: 'user', timestamp: `2026-10-09T11:${String(10 + n)}:00.000Z`, message: { content: `from now on rule ${n} applies` } })).join('\n');
  const { d, calls } = deps({ readTranscript: () => transcript12 });
  const text = precompact({ transcript_path: '/t', trigger: 'auto', session_id: 'abcdef1234567' }, d);
  assert.equal(calls[0][1], 'precompact started (trigger auto, session abcdef12)');
  assert.match(text, /decisions raised 12 in 1 ask\(s\) \(trigger auto, session abcdef12\)$/);
  assert.equal(calls.filter((c) => c[0] === 'ask').length, 1);
});

test('25 decisions, /clear, next compaction: everything was raised the first time, the second run raises nothing and prime is clean', () => {
  const t25 = Array.from({ length: 25 }, (_, n) => JSON.stringify({ type: 'user', timestamp: `2026-10-09T11:${String(10 + n)}:00.000Z`, message: { content: `from now on rule ${n} applies` } })).join('\n');
  const rows: LedgerRow[] = [];
  let tick = 0;
  const journal = (a: string[]) => {
    const used = ['hook:precompact'];
    if (a[0] === 'log' || a[0] === 'ask') rows.push({ kind: a[0] === 'ask' ? 'question' : 'note', ts: `2026-10-09T12:${String(10 + tick++)}:00.000Z`, text: a[1], used });
    return { ok: true, out: '' };
  };
  const run = (): number => { const before = rows.length; precompact({ transcript_path: '/t', trigger: 'auto', session_id: 'sess0001' }, deps({ readLedger: () => rows, readTranscript: () => t25, journal }).d); return rows.slice(before).filter((r) => r.kind === 'question').length; };
  assert.equal(run(), 2, '25 decisions in two ask rows of 20 and 5');
  assert.equal(run(), 0, 'after /clear the same transcript raises nothing again');
  assert.deepEqual(continuityLines(rows, { name: 'h.md', at: '2026-10-09T13:00:00.000Z' }), []);
});

test('the SessionEnd entry point runs only the decision scan: no handoff, no snapshot, no marker rows on success', () => {
  const { d, calls } = deps({ snapshot: () => { throw new Error('snapshot must not run'); } });
  assert.equal(decisionsOnly({ transcript_path: '/t', reason: 'clear', session_id: 'abcdef1234' }, d), 1);
  assert.deepEqual(calls.map((c) => c[0]), ['ask']);
});

test('the SessionEnd entry point fails open: an unreadable transcript leaves a tagged incomplete row and no throw', () => {
  const { d, calls } = deps({ readTranscript: () => { throw new Error('EACCES'); } });
  assert.equal(decisionsOnly({ transcript_path: '/t', reason: 'logout', session_id: 'abcdef1234' }, d), 0);
  assert.deepEqual(calls.map((c) => c[0]), ['log']);
  assert.equal(calls[0][1], 'precompact incomplete: decisions: EACCES (trigger session-end logout, session abcdef12)');
  const down = deps({ readTranscript: () => { throw new Error('EACCES'); }, journal: () => { throw new Error('journal down'); } });
  assert.equal(decisionsOnly({ transcript_path: '/t' }, down.d), 0);
});

const rowAt = (ts: string, text: string, used?: string[]): LedgerRow => ({ kind: 'note', ts, text, ...(used ? { used } : {}) } as LedgerRow);
const quiet = (): Partial<PrecompactDeps> => ({ readTranscript: () => '', snapshot: () => ({ worktrees: 1, copied: 0, current: 4, skipped: 0, partial: false, capped: false }) });

test('precompact leaves a fresh handoff alone and says everything was current', () => {
  const { d, calls } = deps({ ...quiet(), readLedger: () => [rowAt('2026-10-09T11:00:00.000Z', 'did a thing')], newestHandoff: () => ({ name: 'HANDOFF-x.md', at: '2026-10-09T11:30:00.000Z' }) });
  const text = precompact({ transcript_path: '/t', trigger: 'auto' }, d);
  assert.equal(calls.some((c) => c[0] === 'handoff'), false, 'no handoff call when nothing is newer than it');
  assert.equal(text, 'precompact: all current (trigger auto, session unknown)');
});

test('precompact rewrites a stale handoff and says how far behind it was', () => {
  const { d, calls } = deps({ ...quiet(), readLedger: () => [rowAt('2026-10-09T11:40:00.000Z', 'later work')], newestHandoff: () => ({ name: 'HANDOFF-x.md', at: '2026-10-09T11:03:00.000Z' }) });
  const text = precompact({ transcript_path: '/t', trigger: 'auto' }, d);
  assert.equal(calls.filter((c) => c[0] === 'handoff').length, 1);
  assert.match(text, /^precompact: repaired, handoff rewritten \(37 min behind\), snapshot copied 0 \(4 current\), decisions raised 0 in 0 ask\(s\) /);
});

test('precompact: rows the hook and the loop wrote do not stale the handoff, but a repair is still reported when only the snapshot copied', () => {
  const rows = [rowAt('2026-10-09T11:00:00.000Z', 'work'), rowAt('2026-10-09T11:50:00.000Z', 'ask', ['hook:precompact']), rowAt('2026-10-09T11:55:00.000Z', 'tick', ['loop:continuity'])];
  const { d, calls } = deps({ ...quiet(), readLedger: () => rows, newestHandoff: () => ({ name: 'h.md', at: '2026-10-09T11:30:00.000Z' }), snapshot: () => ({ worktrees: 1, copied: 2, current: 1, skipped: 0, partial: false, capped: false }) });
  const text = precompact({ transcript_path: '/t', trigger: 'auto' }, d);
  assert.equal(calls.some((c) => c[0] === 'handoff'), false);
  assert.match(text, /^precompact: handoff current, snapshot copied 2 \(1 current\), decisions raised 0 in 0 ask\(s\) /);
});

const SNIPPET_CLI = join(dirname(fileURLToPath(import.meta.url)), 'print-settings-snippet.ts');
const runSnippet = (args: string[]) => spawnSync(process.execPath, [SNIPPET_CLI, ...args], { encoding: 'utf8', env: { ...process.env, MAESTRO_CLAUDE_SETTINGS: '/nonexistent', CLAUDE_AUTOCOMPACT_PCT_OVERRIDE: '', CLAUDE_CODE_AUTO_COMPACT_WINDOW: '' }, timeout: 20_000 });

test('the one snippet holds the roll hooks and the event-inject entries, and no settings-env block without the flag', () => {
  const r = runSnippet([]);
  assert.equal(r.status, 0);
  const s = JSON.parse(r.stdout) as Record<string, unknown> & { hooks: Record<string, { matcher?: string; hooks: { command: string }[] }[]> };
  assert.deepEqual(Object.keys(s.hooks).sort(), ['PreCompact', 'PreToolUse', 'SessionEnd', 'SessionStart', 'UserPromptSubmit']);
  assert.equal(s.hooks.SessionStart.length, 2);
  assert.equal(s.hooks.SessionStart[1].matcher, undefined);
  assert.match(s.hooks.SessionStart[1].hooks[0].command, /event-inject\.ts'$/);
  assert.equal(s.hooks.UserPromptSubmit.length, 1);
  assert.deepEqual(Object.keys(s), ['hooks']);
  assert.match(r.stderr, /autocompact: unset% of 1000k window \(source default\)/);
});

test('--autocompact-pct adds the settings env block; a value under the floor is refused with exit 2 and nothing on stdout', () => {
  const ok = runSnippet(['--autocompact-pct', '20']);
  assert.equal(ok.status, 0);
  assert.deepEqual(Object.entries(JSON.parse(ok.stdout) as Record<string, unknown>).find(([k]) => k !== 'hooks')?.[1], { CLAUDE_AUTOCOMPACT_PCT_OVERRIDE: '20' });
  const low = runSnippet(['--autocompact-pct', '5']);
  assert.equal(low.status, 2);
  assert.equal(low.stdout, '');
  assert.match(low.stderr, /refused/);
});

test('session-start context puts the autocompact warnings first, and prints none when there are none', () => {
  const run = (a: string[]) => (a[0] === 'prime' ? { ok: true, out: 'Board x' } : { ok: true, out: 'start page' });
  const out = context('compact', run, () => ({ ok: true, out: 'cold' }), ['too low']);
  assert.ok(out.startsWith('== Autocompact ==\n!! too low\n\n== Board'));
  assert.ok(!context('compact', run, () => ({ ok: true, out: 'cold' })).includes('Autocompact'));
});

test('two compactions two minutes apart leave a thrash row naming the setting, and the handoff, snapshot and marker rows still follow', () => {
  const boundaryRow = JSON.stringify({ type: 'system', subtype: 'compact_boundary', timestamp: '2026-10-09T11:58:00.000Z', compactMetadata: { preTokens: 180000, postTokens: 15000 } });
  const turnRow = JSON.stringify({ type: 'assistant', timestamp: '2026-10-09T11:59:00.000Z', message: { role: 'assistant', usage: { input_tokens: 5, cache_creation_input_tokens: 1000, cache_read_input_tokens: 24000 } } });
  const { d, calls } = deps({ readTranscript: () => [boundaryRow, turnRow].join('\n') });
  const text = precompact({ transcript_path: '/t.jsonl', trigger: 'auto', session_id: 'abcdef1234' }, d);
  const logs = calls.filter((c) => c[0] === 'log').map((c) => c[1]);
  assert.match(logs[1], /^compaction thrash: session abcdef12 compacted 2 time\(s\) in 10 min, 10k growth since the last \(setting 20% of 1000k = 200k, floor 100k\)$/);
  assert.deepEqual(calls.map((c) => c[0]), ['log', 'log', 'handoff', 'log'], 'every step still ran');
  assert.match(text, /^precompact: handoff rewritten/);
});

test('a handoff rewritten 37 minutes behind marks the row repaired; one 4 minutes behind does not', () => {
  const min = (m: number): string => new Date(Date.parse(T) - m * 60_000).toISOString();
  const run = (behind: number): string => {
    const { d } = deps({ readLedger: () => [{ kind: 'wip', ts: min(1), text: 'work' }] as never, newestHandoff: () => ({ name: 'h.md', at: min(1 + behind) }), readTranscript: () => '' });
    return precompact({ transcript_path: '/t.jsonl', trigger: 'auto' }, d);
  };
  assert.match(run(37), /^precompact: repaired, handoff rewritten \(37 min behind\)/);
  assert.match(run(4), /^precompact: handoff rewritten \(4 min behind\)/);
});

test('session-start context withholds a secret-shaped line from every part it injects', () => {
  const token = `ghp_${'x'.repeat(36)}`;
  const key = `AKIA${'IOSFODNN7EXAMPLE'}`;
  const run = (a: string[]) => (a[0] === 'prime' ? { ok: true, out: `Today's streams: ok, ${token}\nplain line` } : { ok: true, out: `- \`${key}\` [Beta] something\nnormal` });
  const out = context('compact', run, () => ({ ok: true, out: '# Cold start\nwork' }));
  assert.ok(!out.includes(token) && !out.includes(key), 'neither value is injected');
  assert.equal(out.split('[withheld: secret shape]').length - 1, 2);
  assert.match(out, /plain line/);
  assert.match(out, /normal/);
});
