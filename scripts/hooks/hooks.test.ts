import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { LedgerRow } from '../lib/ledger-core.ts';
import { continuityLines } from '../lib/continuous-roll.ts';
import { decisionsOnly, precompact } from './precompact.ts';
import type { PrecompactDeps } from './precompact.ts';
import { assemble, context, streamsFrom } from './session-start-compact.ts';
import { snippet } from './print-settings-snippet.ts';

const T = '2026-10-09T12:00:00.000Z';
const transcript = JSON.stringify({ type: 'user', timestamp: '2026-10-09T11:00:00.000Z', message: { content: 'from now on never merge without a green suite' } });

function deps(over: Partial<PrecompactDeps> = {}): { d: PrecompactDeps; calls: string[][] } {
  const calls: string[][] = [];
  return { calls, d: { journal: (a) => { calls.push(a); return { ok: true, out: '' }; }, readLedger: () => [], readTranscript: () => transcript, handoffPath: (d, w) => `/j/HANDOFF-${d}-precompact-${w}.md`, snapshot: () => ({ worktrees: 2, files: 5, skipped: 1, partial: false, capped: false }), now: () => new Date(T), ...over } };
}

test('precompact writes the handoff delta, raises the decision and ends with a marker row', () => {
  const { d, calls } = deps();
  const prior = process.env.MAESTRO_WINDOW;
  process.env.MAESTRO_WINDOW = 'envwin';
  let text: string;
  try { text = precompact({ transcript_path: '/t.jsonl', trigger: 'auto' }, d); } finally { if (prior === undefined) delete process.env.MAESTRO_WINDOW; else process.env.MAESTRO_WINDOW = prior; }
  assert.deepEqual(calls[0].slice(0, 2), ['log', 'precompact started (trigger auto, session unknown)'], 'the trace row comes before any slow work');
  assert.deepEqual(calls[1], ['handoff', '--all', '--no-worktree-sweep', '--force', '--window', 'envwin', '--out', '/j/HANDOFF-2026-10-09-precompact-envwin.md']);
  assert.equal(calls[2][0], 'ask');
  assert.match(calls[2][1], /^unledgered decision\? \(1\) \[msg 2026-10-09T11:00:00.000Z [0-9a-f]{6}\]/);
  assert.deepEqual(calls[3].slice(0, 2), ['log', text]);
  assert.match(text, /^precompact: handoff written, 5 file\(s\) snapshotted from 2 worktree\(s\), 1 unledgered decision\(s\) raised in 1 ask\(s\) \(trigger auto, session unknown\)$/);
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
  assert.match(text, /^precompact incomplete: handoff: boom; snapshot: disk full; decisions: ENOENT \(trigger manual, session unknown\)$/);
  assert.equal(calls.at(-1)?.[0], 'log');
});

test('precompact reports a missing transcript_path and an unset scripts_dir instead of skipping silently', () => {
  const { d } = deps({ snapshot: () => null });
  assert.match(precompact({}, d), /^precompact incomplete: snapshot: scripts_dir is not set; decisions: no transcript_path/);
});

test('session-start context: only compact and clear print; streams come from prime; a missing library-brief is named once', () => {
  const run = (a: string[]) => (a[0] === 'prime' ? { ok: true, out: "Board x\nToday's streams: alpha, beta" } : a[0] === 'start-here' ? { ok: true, out: 'start page' } : { ok: false, out: 'unknown' });
  assert.equal(context('startup', run), '');
  const out = context('compact', run);
  assert.match(out, /== Board \(journal\.ts prime\) ==/);
  assert.match(out, /== Start here ==\nstart page/);
  assert.equal(out.match(/library-brief is not available/g)?.length, 1);
  assert.deepEqual(streamsFrom("Today's streams: none"), []);
});

test('session-start context passes --source to prime and caps the output', () => {
  const seen: string[][] = [];
  const out = context('clear', (a) => { seen.push(a); return { ok: true, out: 'x'.repeat(30_000) }; });
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
  assert.match(s.hooks.SessionStart[0].hooks[0].command, /session-start-compact\.ts' --project 'p'$/);
});

test('a partial snapshot (deadline hit) is reported as a failed step, not as success', () => {
  const { d } = deps({ snapshot: () => ({ worktrees: 3, files: 4, skipped: 0, partial: true, capped: false }) });
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
  const { d } = deps({ snapshot: () => ({ worktrees: 3, files: 300, skipped: 9, partial: false, capped: true }) });
  assert.match(precompact({ transcript_path: '/t', trigger: 'auto' }, d), /^precompact incomplete: snapshot: file or size cap reached after 300 file\(s\); later source was not copied /);
});

test('the started and result rows carry the same session tag, and 12 decisions go out in one ask row, none left pending', () => {
  const transcript12 = Array.from({ length: 12 }, (_, n) => JSON.stringify({ type: 'user', timestamp: `2026-10-09T11:${String(10 + n)}:00.000Z`, message: { content: `from now on rule ${n} applies` } })).join('\n');
  const { d, calls } = deps({ readTranscript: () => transcript12 });
  const text = precompact({ transcript_path: '/t', trigger: 'auto', session_id: 'abcdef1234567' }, d);
  assert.equal(calls[0][1], 'precompact started (trigger auto, session abcdef12)');
  assert.match(text, /12 unledgered decision\(s\) raised in 1 ask\(s\) \(trigger auto, session abcdef12\)$/);
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
