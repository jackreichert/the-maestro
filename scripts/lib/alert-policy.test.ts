import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { appendEvents, readInbox } from './event-inbox.ts';
import type { InboxEntry } from './event-inbox.ts';
import { AWAY_MS, RATE_MS, HEALTH_AFTER_MS, alertsPath, decide, emptyState, readAlertState, runAlerts } from './alert-policy.ts';
import type { AlertState } from './alert-policy.ts';

const SENTINEL = 'SENTINEL_FREE_TEXT_7c1e';
const CFG = { quietHours: '23:00-07:00', tz: 'UTC' };
const NOON = Date.parse('2026-10-09T12:00:00Z');
const ok = { state: 'ok' as const, line: '**Loop:** ok' };
const started: AlertState = { ...emptyState(), startSent: true };
let n = 0;
const ev = (over: Partial<InboxEntry> = {}): InboxEntry => ({ id: (++n).toString(16).padStart(12, '0'), watch: 'prs', type: 'pr-watch', kind: 'conflict', at: new Date(NOON - 11 * 60_000).toISOString(), actionable: true, fields: { repo: 'a/scraper', number: 542 }, seen: false, handled: false, seenWindows: [], ...over });
const go = (entries: InboxEntry[], over: Partial<Parameters<typeof decide>[0]> = {}) => decide({ now: NOON, entries, health: ok, state: started, config: CFG, ...over });

test('an allowlisted event unseen for 10 minutes is texted as repo, number and kind', () => {
  assert.equal(go([ev()]).text, 'maestro: scraper#542 conflict');
});

test('away rule: a young, seen or handled event is not texted', () => {
  assert.equal(go([ev({ at: new Date(NOON - AWAY_MS + 1000).toISOString() })]).text, null);
  assert.equal(go([ev({ seen: true })]).text, null);
  assert.equal(go([ev({ handled: true })]).text, null);
});

test('kind allowlist: bot and unknown-author threads, info events and other kinds never text; a human thread does', () => {
  assert.equal(go([ev({ kind: 'thread', fields: { repo: 'a/b', number: 1, who: 'bot' } })]).text, null);
  assert.equal(go([ev({ kind: 'thread', fields: { repo: 'a/b', number: 1 } })]).text, null);
  assert.equal(go([ev({ kind: 'conflict', actionable: false })]).text, null);
  assert.equal(go([ev({ kind: 'message', fields: { count: 2 } }), ev({ kind: 'ready' }), ev({ kind: 'other' })]).text, null);
  assert.equal(go([ev({ kind: 'thread', fields: { repo: 'a/b', number: 1, who: 'human' } })]).text, 'maestro: b#1 thread');
});

test('several events batch into one line with +N', () => {
  const d = go([ev(), ev({ kind: 'changes-requested', fields: { repo: 'a/dtr', number: 3934 } }), ev({ fields: { repo: 'a/x', number: 1 } }), ev({ fields: { repo: 'a/y', number: 2 } })]);
  assert.equal(d.text, 'maestro: 4 PR events: scraper#542 conflict, dtr#3934 changes-requested, x#1 conflict, +1');
});

test('rate limit: nothing within 20 minutes of the last text, and what waited goes out as one line after', () => {
  const state = { ...started, lastSentAt: NOON - RATE_MS + 1000 };
  assert.equal(go([ev()], { state }).text, null);
  assert.equal(go([ev()], { state: { ...started, lastSentAt: NOON - RATE_MS } }).text, 'maestro: scraper#542 conflict');
});

test('an event already texted is not texted again', () => {
  const e = ev();
  const d = go([e]);
  assert.ok(d.text);
  assert.equal(go([e], { state: d.state, now: NOON + RATE_MS }).text, null);
});

test('quiet hours hold everything, and the first line after is one batch', () => {
  const night = Date.parse('2026-10-09T23:30:00Z');
  const entries = [ev({ at: new Date(night - AWAY_MS * 2).toISOString() }), ev({ kind: 'changes-requested', at: new Date(night - AWAY_MS * 2).toISOString() })];
  assert.equal(go(entries, { now: night }).text, null);
  assert.equal(go(entries, { now: Date.parse('2026-10-10T06:59:00Z') }).text, null);
  assert.match(go(entries, { now: Date.parse('2026-10-10T07:00:00Z') }).text ?? '', /^maestro: 2 PR events:/);
});

test('health: DOWN texts only after 15 minutes, once per stretch, and never in quiet hours', () => {
  const down = { state: 'down' as const, line: '**Loop:** DOWN' };
  const first = go([], { health: down });
  assert.equal(first.text, null);
  assert.equal(first.state.badSince, NOON);
  const later = go([], { health: down, state: first.state, now: NOON + HEALTH_AFTER_MS });
  assert.equal(later.text, 'maestro: loop DOWN');
  assert.equal(go([], { health: down, state: later.state, now: NOON + HEALTH_AFTER_MS + RATE_MS }).text, null, 'once per stretch');
  assert.equal(go([], { health: ok, state: later.state, now: NOON + 60 * 60_000 }).state.badAlerted, false, 'recovery resets it');
  const night = Date.parse('2026-10-09T23:30:00Z');
  assert.equal(go([], { health: down, state: { ...started, badSince: night - HEALTH_AFTER_MS * 2 }, now: night }).text, null);
});

test('health: a check that keeps failing texts as a count, without its name', () => {
  assert.equal(go([ev({ kind: 'check-failing', watch: 'secretwatch', fields: {} })]).text, 'maestro: 1 loop check failing');
});

test('first start: texted once when the loop is first healthy', () => {
  const first = go([], { state: emptyState() });
  assert.equal(first.text, 'maestro: loop started');
  assert.equal(go([], { state: first.state, now: NOON + RATE_MS }).text, null);
  assert.equal(go([], { state: emptyState(), health: { state: 'down', line: 'DOWN' } }).text, null, 'not while down');
});

test('runAlerts saves state only after a send that worked, and keeps it on a failure', () => {
  const dir = mkdtempSync(join(tmpdir(), 'alerts-'));
  try {
    const base = { eventDir: dir, command: ['say-it', '--to', 'me'], now: NOON, entries: [ev()], health: ok, config: CFG };
    const sent: string[][] = [];
    assert.equal(runAlerts({ ...base, run: () => ({ status: 1 }) }), null);
    assert.equal(existsSync(alertsPath(dir)), false, 'a failed send leaves no state, so it is retried');
    assert.match(runAlerts({ ...base, run: (c, a) => { sent.push([c, ...a]); return { status: 0 }; } }) ?? '', /conflict/);
    assert.deepEqual(sent[0]!.slice(0, 3), ['say-it', '--to', 'me']);
    assert.equal(readAlertState(dir).lastSentAt, NOON);
    assert.equal(runAlerts({ ...base, command: [] }), null);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('SENTINEL: free text in a summary never reaches the notifier argv', () => {
  const dir = mkdtempSync(join(tmpdir(), 'alerts-'));
  try {
    const at = new Date(NOON - 30 * 60_000).toISOString();
    appendEvents(dir, [
      { watch: 'prs', type: 'pr-watch', at, actionable: true, report: SENTINEL, summary: `CONFLICT a/scraper#9 by ${SENTINEL}: ${SENTINEL} title ${SENTINEL}` },
      { watch: 'prs', type: 'pr-watch', at, actionable: true, report: '', summary: `DECISION a/dtr#4 by human-person -> CHANGES_REQUESTED ${SENTINEL}` },
      { watch: 'notion', type: 'notion-watch', at, actionable: true, report: '', summary: `NOTION-CHANGED ${SENTINEL} Acme Customer Org` },
      { watch: 'r', type: 'reminder', at, actionable: true, report: '', summary: `reminder ${SENTINEL}` },
    ]);
    const argvs: string[][] = [];
    const line = runAlerts({ eventDir: dir, command: ['notify'], now: NOON, entries: readInbox(dir), health: ok, config: CFG, run: (c, a) => { argvs.push([c, ...a]); return { status: 0 }; } });
    assert.ok(line && line.includes('scraper#9'), 'something was sent');
    assert.ok(!argvs.flat().join('\n').includes(SENTINEL), 'no sentinel in argv');
    assert.ok(!line.includes(SENTINEL));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('SENTINEL: hand-built rows with free text in fields, kind or extra keys still send none of it', () => {
  const hostile = [
    ev({ fields: { repo: `${SENTINEL}/x y`, number: 5, title: SENTINEL } as never }),
    ev({ kind: SENTINEL, fields: { repo: 'a/b', number: 1 } }),
    ev({ fields: { repo: 'a/b', number: `${SENTINEL}` as never } }),
  ];
  const d = go(hostile);
  assert.ok(!(d.text ?? '').includes(SENTINEL), `line was: ${d.text}`);
  assert.equal(d.text, 'maestro: 2 PR events: conflict, b conflict');
});
