import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { appendEvents, inboxPath, readInbox } from '../lib/event-inbox.ts';
import type { InboxEntry } from '../lib/event-inbox.ts';
import { eventHooksSnippet } from './install-hooks.ts';
import { MAX_HEADLINES, headline, inject } from './event-inject.ts';

const HOOK = fileURLToPath(new URL('./event-inject.ts', import.meta.url));
const INSTALL = fileURLToPath(new URL('./install-hooks.ts', import.meta.url));
const SENTINEL = 'SENTINEL_FREE_TEXT_9f3a';
const entry = (over: Partial<InboxEntry>): InboxEntry => ({ id: 'aaaaaaaaaaaa', watch: 'prs', type: 'pr-watch', kind: 'thread', at: '2026-10-09T12:00:00.000Z', actionable: true, fields: {}, seen: false, handled: false, seenWindows: [], ...over });
const okHealth = { state: 'ok' as const, line: '**Loop:** ok 2 min' };

test('headline is built from kind and fields only', () => {
  assert.equal(headline(entry({ fields: { repo: 'a/b', number: 5, who: 'human' } })), 'thread a/b#5 (human) [aaaaaaaaaaaa]');
  assert.equal(headline(entry({ kind: 'message', fields: { count: 3 } })), '3 new texts from Jack (read with claude-inbox --new)');
  assert.equal(headline(entry({ kind: 'message', fields: { count: 1 } })), '1 new text from Jack (read with claude-inbox --new)');
});

test('inject prints nothing when there is nothing unseen and the loop is healthy, except a loop line at session start', () => {
  const deps = { claim: () => [], health: () => okHealth };
  assert.equal(inject('UserPromptSubmit', 'w1', deps), '');
  assert.equal(inject('SessionStart', 'w1', deps), okHealth.line);
});

test('inject shows a bad loop state on every prompt, and caps the claim at MAX_HEADLINES', () => {
  let asked = 0;
  const down = { state: 'down' as const, line: '**Loop:** DOWN' };
  assert.equal(inject('UserPromptSubmit', 'w1', { claim: (_w, n) => { asked = n; return []; }, health: () => down }), down.line);
  assert.equal(asked, MAX_HEADLINES);
});

test('inject fails open when a dependency throws', () => {
  assert.equal(inject('SessionStart', 'w1', { claim: () => { throw new Error('boom'); }, health: () => okHealth }), '');
  assert.equal(inject('SessionStart', 'w1', { claim: () => [], health: () => { throw new Error('boom'); } }), '');
});

function run(dir: string, stdin: string): { out: string; code: number | null } {
  const r = spawnSync(process.execPath, [HOOK], { input: stdin, encoding: 'utf8', env: { ...process.env, MAESTRO_EVENT_DIR: dir, MAESTRO_WINDOW: '', CLAUDE_CODE_SESSION_ID: '' }, timeout: 20_000 });
  return { out: r.stdout, code: r.status };
}

test('the hook prints headlines from fields only, marks them seen, and does not repeat them', () => {
  const dir = mkdtempSync(join(tmpdir(), 'inject-'));
  try {
    appendEvents(dir, [{ watch: 'prs', type: 'pr-watch', at: '2026-10-09T12:00:00.000Z', actionable: true, report: '', summary: `THREAD a/b#7 by someone: ${SENTINEL} please fix` }]);
    const first = run(dir, JSON.stringify({ session_id: 'sess-one', hook_event_name: 'UserPromptSubmit' }));
    assert.equal(first.code, 0);
    assert.match(first.out, /thread a\/b#7/);
    assert.ok(!first.out.includes(SENTINEL), 'summary text never reaches the output');
    assert.equal(readInbox(dir)[0].seen, true);
    assert.equal(readInbox(dir)[0].handled, false, 'seen, not handled');
    assert.ok(!run(dir, JSON.stringify({ session_id: 'sess-one', hook_event_name: 'UserPromptSubmit' })).out.includes('thread a/b#7'), 'not shown twice');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('the hook fails open on garbage stdin and a corrupt inbox', () => {
  const dir = mkdtempSync(join(tmpdir(), 'inject-'));
  try {
    writeFileSync(inboxPath(dir), '{not json\n\u0000\u0000{"row":"event"');
    for (const stdin of ['', 'not json', '[]']) assert.equal(run(dir, stdin).code, 0);
    const bad = spawnSync(process.execPath, [HOOK], { input: '{}', encoding: 'utf8', env: { ...process.env, MAESTRO_EVENT_DIR: '/dev/null/x' }, timeout: 20_000 });
    assert.equal(bad.status, 0);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('install-hooks prints a SessionStart and UserPromptSubmit entry and writes no file', () => {
  const snip = eventHooksSnippet() as { hooks: Record<string, { hooks: { command: string; timeout: number }[] }[]> };
  assert.deepEqual(Object.keys(snip.hooks).sort(), ['SessionStart', 'UserPromptSubmit']);
  assert.match(snip.hooks.UserPromptSubmit[0].hooks[0].command, /event-inject\.ts'$/);
  const dir = mkdtempSync(join(tmpdir(), 'inject-home-'));
  try {
    const r = spawnSync(process.execPath, [INSTALL], { encoding: 'utf8', env: { ...process.env, HOME: dir }, cwd: dir });
    assert.equal(r.status, 0);
    assert.deepEqual(JSON.parse(r.stdout), snip);
    assert.deepEqual(spawnSync('ls', ['-A', dir], { encoding: 'utf8' }).stdout.trim(), '', 'nothing written');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
