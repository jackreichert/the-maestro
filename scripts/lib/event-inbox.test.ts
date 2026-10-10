// Run: node --test scripts/lib/event-inbox.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, appendFileSync, truncateSync, statSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { appendEvents, cleanFields, formatEntry, inboxPath, mark, readInbox, readInboxReport, toInboxEvent } from './event-inbox.ts';
import type { DigestEvent } from './types.ts';

const tempDir = () => mkdtempSync(join(tmpdir(), 'event-inbox-test-'));
const AT = '2026-10-01T12:00:00.000Z';
const ev = (summary: string, extra: Partial<DigestEvent> = {}): DigestEvent => ({ watch: 'prs', type: 'pr-watch', at: AT, summary, actionable: true, report: 'tell the orchestrator', ...extra });
const SENTINEL = 'SENTINEL-free-text-9f3a';

test('a thread event keeps repo, number and who as bot or human, and a kind; no summary or report', () => {
  const e = toInboxEvent(ev('THREAD acme/widgets#12 by copilot-pull-request-reviewer[bot]: https://example.test/t/1'));
  assert.deepEqual(e?.fields, { repo: 'acme/widgets', number: 12, who: 'bot' });
  assert.equal(e?.kind, 'thread');
  assert.deepEqual(Object.keys(e ?? {}).sort(), ['actionable', 'at', 'fields', 'id', 'kind', 'type', 'watch']);
  assert.equal(toInboxEvent(ev('REPLY acme/widgets#12 by fake_person: https://example.test/r'))?.fields.who, 'human');
});

test('kinds: decisions split on the target state, conflicts, messages carry a count, unknown text is other', () => {
  const kind = (s: string) => toInboxEvent(ev(s))?.kind;
  assert.equal(kind('DECISION acme/w#1: NONE -> CHANGES_REQUESTED https://x.test'), 'changes-requested');
  assert.equal(kind('DECISION acme/w#1: NONE -> APPROVED https://x.test'), 'approved');
  assert.equal(kind('CONFLICT acme/w#1 main <- f https://x.test'), 'conflict');
  assert.equal(kind('CONFLICT-CLEARED acme/w#1'), 'conflict-cleared');
  assert.equal(kind('READY acme/w#1 draft promoted to ready for review https://x.test'), 'ready');
  assert.equal(toInboxEvent(ev('3 new message(s) from user', { type: 'inbox', watch: 'inbox' }))?.fields.count, 3);
  assert.equal(kind(`something odd ${SENTINEL}`), 'other');
});

test('the allowlist is applied on the write path: free text and unknown fields never reach the file', () => {
  const dir = tempDir();
  // The producer hands over a digest event carrying extra keys and a summary full of free text.
  const hostile = { ...ev(`THREAD acme/widgets#7 by someone: ${SENTINEL} patient name here`), title: SENTINEL, body: SENTINEL, fields: { title: SENTINEL } } as DigestEvent;
  assert.deepEqual(appendEvents(dir, [hostile, ev(`reminder: ${SENTINEL}`, { type: 'reminder', watch: 'r1' })]), { added: 2, duplicates: 0, refused: 0 });
  const file = readFileSync(inboxPath(dir), 'utf8');
  assert.equal(file.includes(SENTINEL), false);
  assert.equal(file.includes('patient'), false);
  assert.equal(file.includes('someone'), false);
  assert.equal(file.includes('tell the orchestrator'), false);
});

test('cleanFields drops unknown keys and values that fail their rule', () => {
  assert.deepEqual(cleanFields({ repo: 'a/b', number: 4, who: 'human', count: 2, title: 'x', login: 'y' }), { repo: 'a/b', number: 4, who: 'human', count: 2 });
  assert.deepEqual(cleanFields({ repo: 'not a repo', number: -1, who: 'alice', count: 1.5 }), {});
  assert.deepEqual(cleanFields(null), {});
});

test('a row edited by hand cannot get free text past the reader', () => {
  const dir = tempDir();
  appendEvents(dir, [ev('THREAD acme/w#1 by someone: u')]);
  const [good] = readInbox(dir);
  appendFileSync(inboxPath(dir), `${JSON.stringify({ row: 'event', id: 'abcdef012345', watch: 'prs', type: 'pr-watch', kind: 'thread', at: AT, actionable: true, fields: { repo: 'a/b', title: SENTINEL }, summary: SENTINEL })}\n`);
  appendFileSync(inboxPath(dir), `${JSON.stringify({ row: 'event', id: 'abcdef012346', watch: SENTINEL + ' spaces', type: 'x', kind: 'thread', at: AT })}\nnot json\n`);
  const entries = readInbox(dir);
  assert.equal(entries.length, 2);
  assert.equal(JSON.stringify(entries).includes(SENTINEL), false);
  assert.equal(entries[0].id, good.id);
});

test('refuses an event whose watch or type is not a plain token, or whose time is bad', () => {
  const dir = tempDir();
  const r = appendEvents(dir, [ev('x', { watch: 'has spaces and text' }), ev('y', { type: '' }), ev('z', { at: 'yesterday' })]);
  assert.deepEqual(r, { added: 0, duplicates: 0, refused: 3 });
  assert.deepEqual(readInbox(dir), []);
});

test('the same digest line replayed lands once; the same words at a later time are a new event, even after an ack', () => {
  const dir = tempDir();
  const e = ev('THREAD acme/w#1 by someone: https://x.test/a');
  assert.deepEqual(appendEvents(dir, [e, e]), { added: 1, duplicates: 1, refused: 0 });
  assert.deepEqual(appendEvents(dir, [e]), { added: 0, duplicates: 1, refused: 0 });
  mark(dir, 'handled', [readInbox(dir)[0].id]);
  assert.deepEqual(appendEvents(dir, [{ ...e, at: '2026-10-02T00:00:00.000Z' }]), { added: 1, duplicates: 0, refused: 0 });
  assert.equal(readInbox(dir).length, 2);
});

test('two writers racing the dedupe check leave one entry on read', () => {
  const dir = tempDir();
  const line = `${JSON.stringify({ row: 'event', ...toInboxEvent(ev('THREAD acme/w#1 by someone: u')) })}\n`;
  writeFileSync(inboxPath(dir), line + line);
  assert.equal(readInbox(dir).length, 1);
});

test('seen and handled are idempotent, handled implies seen, unknown ids are reported', () => {
  const dir = tempDir();
  appendEvents(dir, [ev('THREAD acme/w#1 by a: u'), ev('THREAD acme/w#2 by a: u')]);
  const [a, b] = readInbox(dir);
  assert.deepEqual(mark(dir, 'seen', [a.id, a.id, 'ffffffffffff']), { unknown: ['ffffffffffff'] });
  mark(dir, 'seen', [a.id]);
  mark(dir, 'handled', [b.id]);
  mark(dir, 'handled', [b.id]);
  const rows = readFileSync(inboxPath(dir), 'utf8').trim().split('\n').map((l) => JSON.parse(l).row);
  assert.deepEqual(rows, ['event', 'event', 'seen', 'handled']);
  const [a2, b2] = readInbox(dir);
  assert.deepEqual([a2.seen, a2.handled, b2.seen, b2.handled], [true, false, true, true]);
});

test('formatEntry prints id, state, kind, watch and fields only', () => {
  const dir = tempDir();
  appendEvents(dir, [ev(`THREAD acme/w#3 by someone: ${SENTINEL}`)]);
  const line = formatEntry(readInbox(dir)[0]);
  assert.match(line, /^[0-9a-f]{12} new ACTION thread prs \(pr-watch\) repo=acme\/w number=3 who=human$/);
  assert.equal(line.includes(SENTINEL), false);
});

test('a time with trailing free text is re-serialised on write and on read, never stored verbatim', () => {
  const dir = tempDir();
  appendEvents(dir, [ev('THREAD acme/w#1 by someone: u', { at: `2026-01-01 (${SENTINEL})` })]);
  assert.equal(readFileSync(inboxPath(dir), 'utf8').includes(SENTINEL), false);
  appendFileSync(inboxPath(dir), `${JSON.stringify({ row: 'event', id: 'abcdef012345', watch: 'prs', type: 'pr-watch', kind: 'thread', at: `Jan 1 2026 (${SENTINEL})`, actionable: true, fields: {} })}\n`);
  const entries = readInbox(dir);
  assert.equal(entries.length, 2);
  assert.equal(JSON.stringify(entries).includes(SENTINEL), false);
  assert.match(entries[1].at, /^\d{4}-\d\d-\d\dT[\d:.]+Z$/);
});

const THREADS = (from: number, n: number): DigestEvent[] => Array.from({ length: n }, (_, i) => ev(`THREAD acme/widgets#${from + i} by someone: u`));

test('a torn last line does not swallow the next appends, and is reported rather than hidden', () => {
  const dir = tempDir();
  appendEvents(dir, THREADS(1, 3));
  truncateSync(inboxPath(dir), statSync(inboxPath(dir)).size - 20);
  assert.deepEqual(readInboxReport(dir), { entries: readInbox(dir), torn: 1 });
  assert.equal(readInbox(dir).length, 2);
  assert.deepEqual(appendEvents(dir, THREADS(4, 2)), { added: 2, duplicates: 0, refused: 0 });
  const report = readInboxReport(dir);
  assert.deepEqual(report.entries.map((e) => e.fields.number), [1, 2, 4, 5]);
  assert.equal(report.torn, 1);
});

test('a mark after a torn tail is kept too', () => {
  const dir = tempDir();
  appendEvents(dir, THREADS(1, 2));
  const [first] = readInbox(dir);
  truncateSync(inboxPath(dir), statSync(inboxPath(dir)).size - 5);
  mark(dir, 'handled', [first.id]);
  assert.equal(readInbox(dir)[0].handled, true);
});

test('writers racing on a torn file lose nothing', async () => {
  const dir = tempDir();
  appendEvents(dir, THREADS(1, 2));
  truncateSync(inboxPath(dir), statSync(inboxPath(dir)).size - 20);
  const writers = 6;
  const each = 25;
  const code = `import { appendEvents } from ${JSON.stringify(new URL('./event-inbox.ts', import.meta.url).href)};
    const [dir, w, n] = process.argv.slice(1);
    for (let i = 0; i < Number(n); i += 1) appendEvents(dir, [{ watch: 'prs', type: 'pr-watch', at: '${AT}', summary: 'THREAD acme/widgets#' + (1000 * Number(w) + i) + ' by someone: u', actionable: true, report: '' }]);`;
  await Promise.all(Array.from({ length: writers }, (_, w) => new Promise<void>((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', code, dir, String(w + 1), String(each)], { stdio: 'inherit' });
    child.on('exit', (status) => (status === 0 ? resolve() : reject(new Error(`writer ${w} exited ${status}`))));
  })));
  const report = readInboxReport(dir);
  assert.equal(report.entries.length, 1 + writers * each);
  assert.equal(new Set(report.entries.map((e) => e.id)).size, 1 + writers * each);
  assert.equal(report.torn, 1);
});

test('a seen or handled mark carries the window that made it, free text is stripped, and an unmarked row reads as before', () => {
  const dir = tempDir();
  appendEvents(dir, [ev('THREAD acme/widget#1 by alice: x'), ev('THREAD acme/widget#2 by bob: y', { at: '2026-10-01T12:01:00.000Z' }), ev('THREAD acme/widget#3 by cy: z', { at: '2026-10-01T12:02:00.000Z' })]);
  const [a, b, c] = readInbox(dir).map((e) => e.id);
  mark(dir, 'seen', [a], Date.now(), 'win-one');
  mark(dir, 'handled', [a], Date.now(), 'win-two');
  mark(dir, 'seen', [b], Date.now(), 'bad id "\n{x}');
  mark(dir, 'seen', [c]);
  const by = new Map(readInbox(dir).map((e) => [e.id, e]));
  assert.equal(by.get(a)?.seenBy, 'win-one');
  assert.equal(by.get(a)?.handledBy, 'win-two');
  assert.equal(by.get(b)?.seenBy, 'badidx', 'the id is cleaned before it is stored');
  assert.equal(by.get(c)?.seen, true);
  assert.equal(by.get(c)?.seenBy, undefined);
  assert.ok(!readFileSync(inboxPath(dir), 'utf8').includes('bad id'));
});

test('seen is per window: one window\'s mark does not skip another\'s, and seenWindows lists each', () => {
  const dir = tempDir();
  appendEvents(dir, [ev('THREAD acme/w#1 by a: u')]);
  const [a] = readInbox(dir);
  mark(dir, 'seen', [a.id], Date.now(), 'w1');
  mark(dir, 'seen', [a.id], Date.now(), 'w2');
  mark(dir, 'seen', [a.id], Date.now(), 'w2');
  const rows = readFileSync(inboxPath(dir), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.deepEqual(rows.filter((r) => r.row === 'seen').map((r) => r.window), ['w1', 'w2'], 'w2 wrote its own mark once; its repeat was a no-op');
  const [e] = readInbox(dir);
  assert.deepEqual([e.seen, e.seenBy, e.seenWindows, e.seenAnonymous], [true, 'w1', ['w1', 'w2'], undefined]);
});

test('a mark that names no window counts as seen by every window, and a windowless caller keeps the old skip-once rule', () => {
  const dir = tempDir();
  appendEvents(dir, [ev('THREAD acme/w#1 by a: u'), ev('THREAD acme/w#2 by a: u')]);
  const [a, b] = readInbox(dir);
  mark(dir, 'seen', [a.id]);
  mark(dir, 'seen', [a.id], Date.now(), 'w1');
  mark(dir, 'seen', [b.id], Date.now(), 'w1');
  mark(dir, 'seen', [b.id]);
  const rows = readFileSync(inboxPath(dir), 'utf8').trim().split('\n').map((l) => JSON.parse(l).row);
  assert.deepEqual(rows, ['event', 'event', 'seen', 'seen'], 'w1 adds nothing to an event an older anonymous mark already covers; the windowless repeat on b is skipped');
  const [a2, b2] = readInbox(dir);
  assert.deepEqual([a2.seenAnonymous, a2.seenWindows, b2.seenAnonymous, b2.seenWindows], [true, [], undefined, ['w1']]);
});
