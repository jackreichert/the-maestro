import { test } from 'node:test';
import assert from 'node:assert/strict';
import { precompact } from './precompact.ts';
import type { PrecompactDeps } from './precompact.ts';
import { assemble, context, streamsFrom } from './session-start-compact.ts';
import { snippet } from './print-settings-snippet.ts';

const T = '2026-10-09T12:00:00.000Z';
const transcript = JSON.stringify({ type: 'user', timestamp: '2026-10-09T11:00:00.000Z', message: { content: 'from now on never merge without a green suite' } });

function deps(over: Partial<PrecompactDeps> = {}): { d: PrecompactDeps; calls: string[][] } {
  const calls: string[][] = [];
  return { calls, d: { journal: (a) => { calls.push(a); return { ok: true, out: '' }; }, readLedger: () => [], readTranscript: () => transcript, snapshot: () => ({ worktrees: 2, files: 5, skipped: 1 }), now: () => new Date(T), ...over } };
}

test('precompact writes the handoff delta, raises the decision and ends with a marker row', () => {
  const { d, calls } = deps();
  const text = precompact({ transcript_path: '/t.jsonl', trigger: 'auto' }, d);
  assert.deepEqual(calls[0], ['handoff', '--all', '--delta']);
  assert.equal(calls[1][0], 'ask');
  assert.match(calls[1][1], /^unledgered decision\? \[msg 2026-10-09T11:00:00.000Z\]/);
  assert.deepEqual(calls[2].slice(0, 2), ['log', text]);
  assert.match(text, /^precompact: handoff delta written, 5 file\(s\) snapshotted from 2 worktree\(s\), 1 unledgered decision\(s\) raised \(trigger auto\)$/);
});

test('precompact fails open: each failing step is named in an "incomplete" row and the others still run', () => {
  const { d, calls } = deps({
    journal: (a) => { calls.push(a); return a[0] === 'handoff' ? { ok: false, out: 'boom' } : { ok: true, out: '' }; },
    snapshot: () => { throw new Error('disk full'); },
    readTranscript: () => { throw new Error('ENOENT'); },
  });
  const text = precompact({ transcript_path: '/gone', trigger: 'manual' }, d);
  assert.match(text, /^precompact incomplete: handoff: boom; snapshot: disk full; decisions: ENOENT \(trigger manual\)$/);
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
  assert.equal(s.hooks.SessionStart[0].matcher, 'compact|clear');
  assert.match(s.hooks.PreCompact[0].hooks[0].command, /precompact\.ts' --project 'p'$/);
  assert.match(s.hooks.SessionStart[0].hooks[0].command, /session-start-compact\.ts' --project 'p'$/);
});
