// Run: node --test scripts/repost-nudge-config.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { checkWindow, logProblem, parseClock, parseDays, parseInt10, parseRepos, parseSwitch, parseTriggers, parseZone, resetLogged } from './lib/repost-nudge-config.ts';

const zoneOk = (n: string): boolean => n === 'America/New_York' || n === 'UTC';

test('repost_nudge_enabled and repost_nudge_hold_empty: on/off words, empty is the default, anything else falls back with a problem', () => {
  assert.deepEqual(parseSwitch('', true), { value: true });
  assert.deepEqual(parseSwitch(' OFF ', true), { value: false });
  assert.deepEqual(parseSwitch('Yes', false), { value: true });
  assert.equal(parseSwitch('maybe', true).value, true);
  assert.match(parseSwitch('maybe', false).problem ?? '', /on or off/);
  assert.equal(parseSwitch('maybe', false).value, false);
});

test('repost_nudge_triggers: a list of known triggers, unknown names dropped with a problem, nothing usable means both', () => {
  assert.deepEqual(parseTriggers('').value, ['approval', 'teammate-review']);
  assert.deepEqual(parseTriggers('approval').value, ['approval']);
  assert.deepEqual(parseTriggers(' Teammate-Review , approval,approval ').value, ['teammate-review', 'approval']);
  const mixed = parseTriggers('approval,slack');
  assert.deepEqual(mixed.value, ['approval']);
  assert.match(mixed.problem ?? '', /unknown trigger slack/);
  assert.deepEqual(parseTriggers('nope').value, ['approval', 'teammate-review']);
});

test('repost_nudge_minutes, _gap_minutes and _asked_minutes: whole numbers from 0, else the default', () => {
  for (const [raw, want] of [['', 60], ['0', 0], ['15', 15], ['  90 ', 90]] as const) assert.deepEqual(parseInt10(raw, 60, 0), { value: want });
  for (const raw of ['-1', '1.5', 'soon', '1e3', '99999999999']) {
    const p = parseInt10(raw, 60, 0);
    assert.equal(p.value, 60, raw);
    assert.match(p.problem ?? '', /whole number from 0/, raw);
  }
});

test('repost_nudge_count: 1 to 5', () => {
  assert.equal(parseInt10('5', 3, 1, 5).value, 5);
  assert.equal(parseInt10('', 3, 1, 5).value, 3);
  for (const raw of ['0', '6', 'many']) assert.deepEqual([parseInt10(raw, 3, 1, 5).value, /from 1 to 5/.test(parseInt10(raw, 3, 1, 5).problem ?? '')], [3, true], raw);
});

test('repost_nudge_check_seconds: at least the 120 second network floor', () => {
  assert.equal(parseInt10('600', 300, 120).value, 600);
  assert.equal(parseInt10('', 300, 120).value, 300);
  const p = parseInt10('30', 300, 120);
  assert.equal(p.value, 300);
  assert.match(p.problem ?? '', /from 120/);
});

test('repost_nudge_start and _end: HH:MM, and the end must be after the start', () => {
  assert.deepEqual(parseClock('', '08:30'), { value: '08:30' });
  assert.deepEqual(parseClock('07:05', '08:30'), { value: '07:05' });
  for (const raw of ['8:30', '25:00', '08:60', 'noon']) assert.equal(parseClock(raw, '08:30').value, '08:30', raw);
  assert.match(parseClock('noon', '08:30').problem ?? '', /HH:MM/);
  assert.deepEqual(checkWindow('09:00', '17:00', { start: '08:30', end: '18:00' }), { value: { start: '09:00', end: '17:00' } });
  const empty = checkWindow('18:00', '08:30', { start: '08:30', end: '18:00' });
  assert.deepEqual(empty.value, { start: '08:30', end: '18:00' });
  assert.match(empty.problem ?? '', /must be after/);
});

test('repost_nudge_tz: a zone the runtime knows, else the default', () => {
  assert.deepEqual(parseZone('UTC', 'America/New_York', zoneOk), { value: 'UTC' });
  assert.deepEqual(parseZone('', 'America/New_York', zoneOk), { value: 'America/New_York' });
  const p = parseZone('Mars/Base', 'America/New_York', zoneOk);
  assert.equal(p.value, 'America/New_York');
  assert.match(p.problem ?? '', /IANA/);
});

test('repost_nudge_repos: owner, owner/name and owner/* entries; a bare owner means owner/*; bad entries are dropped with a problem', () => {
  assert.deepEqual(parseRepos(''), { value: [] });
  assert.deepEqual(parseRepos('acme, acme/api ,other/*').value, ['acme/*', 'acme/api', 'other/*']);
  const bad = parseRepos('acme/api,*/api,*,acme/a/b,a b');
  assert.deepEqual(bad.value, ['acme/api']);
  assert.match(bad.problem ?? '', /dropped \*\/api, \*, acme\/a\/b, a b/);
});

test('repost_nudge_days: names, ranges (also wrapping) and daily; any bad entry sends the whole value to mon-fri', () => {
  assert.deepEqual(parseDays(''), { value: [1, 2, 3, 4, 5] });
  assert.deepEqual(parseDays('mon-fri').value, [1, 2, 3, 4, 5]);
  assert.deepEqual(parseDays('Mon, wed-thu , SAT').value, [1, 3, 4, 6]);
  assert.deepEqual(parseDays('fri-mon').value, [0, 1, 5, 6]);
  assert.deepEqual(parseDays('daily').value, [0, 1, 2, 3, 4, 5, 6]);
  for (const raw of ['mon-funday', 'weekdays', 'mon-tue-wed', ',']) {
    const p = parseDays(raw);
    assert.deepEqual(p.value, [1, 2, 3, 4, 5], raw);
    assert.match(p.problem ?? '', /day names or ranges/, raw);
  }
});

test('a problem is logged once per key, with the key, the bad text and what is used instead; no problem logs nothing', () => {
  resetLogged();
  const out: string[] = [];
  const write = (l: string): void => { out.push(l); };
  const p = parseInt10('soon', 60, 0);
  logProblem('repost_nudge_minutes', 'soon', p, write);
  logProblem('repost_nudge_minutes', 'soon', p, write);
  logProblem('repost_nudge_count', '3', parseInt10('3', 3, 1, 5), write);
  assert.equal(out.length, 1);
  assert.match(out[0] ?? '', /^the-maestro: repost_nudge_minutes "soon" ignored: .*; using 60$/);
});

test('local-config applies every key: good values are read, each bad one falls back to its default and is logged once', () => {
  const load = (env: Record<string, string>) => spawnSync(process.execPath, ['-e', `import('./scripts/local-config.ts').then((c) => console.log(JSON.stringify({ e: c.REPOST_NUDGE_ENABLED, t: c.REPOST_NUDGE_TRIGGERS, m: c.REPOST_NUDGE_MINUTES, n: c.REPOST_NUDGE_COUNT, r: c.REPOST_NUDGE_REPOS, d: c.REPOST_NUDGE_DAYS, g: c.REPOST_NUDGE_GAP_MINUTES, k: c.REPOST_NUDGE_CHECK_SECONDS, h: c.REPOST_NUDGE_HOLD_EMPTY, a: c.REPOST_NUDGE_ASKED_MINUTES, z: c.REPOST_NUDGE_TZ, s: c.REPOST_NUDGE_START, x: c.REPOST_NUDGE_END })))`], { encoding: 'utf8', env: { ...process.env, MAESTRO_LOCAL_CONFIG: '', ...env } });
  const defaults = load({});
  assert.equal(defaults.stderr, '');
  assert.deepEqual(JSON.parse(defaults.stdout), { e: true, t: ['approval', 'teammate-review'], m: 60, n: 3, r: [], d: [1, 2, 3, 4, 5], g: 60, k: 300, h: false, a: 60, z: 'America/New_York', s: '08:30', x: '18:00' });

  const good = load({ MAESTRO_REPOST_NUDGE_ENABLED: 'off', MAESTRO_REPOST_NUDGE_TRIGGERS: 'approval', MAESTRO_REPOST_NUDGE_MINUTES: '30', MAESTRO_REPOST_NUDGE_COUNT: '2', MAESTRO_REPOST_NUDGE_REPOS: 'acme', MAESTRO_REPOST_NUDGE_DAYS: 'mon,sat', MAESTRO_REPOST_NUDGE_GAP_MINUTES: '15', MAESTRO_REPOST_NUDGE_CHECK_SECONDS: '600', MAESTRO_REPOST_NUDGE_HOLD_EMPTY: 'on', MAESTRO_REPOST_NUDGE_ASKED_MINUTES: '5', MAESTRO_REPOST_NUDGE_TZ: 'UTC', MAESTRO_REPOST_NUDGE_START: '09:00', MAESTRO_REPOST_NUDGE_END: '17:00' });
  assert.equal(good.stderr, '');
  assert.deepEqual(JSON.parse(good.stdout), { e: false, t: ['approval'], m: 30, n: 2, r: ['acme/*'], d: [1, 6], g: 15, k: 600, h: true, a: 5, z: 'UTC', s: '09:00', x: '17:00' });

  const badEnv = { MAESTRO_REPOST_NUDGE_ENABLED: 'perhaps', MAESTRO_REPOST_NUDGE_TRIGGERS: 'carrier-pigeon', MAESTRO_REPOST_NUDGE_MINUTES: 'soon', MAESTRO_REPOST_NUDGE_COUNT: '9', MAESTRO_REPOST_NUDGE_REPOS: '*/x', MAESTRO_REPOST_NUDGE_DAYS: 'funday', MAESTRO_REPOST_NUDGE_GAP_MINUTES: '-3', MAESTRO_REPOST_NUDGE_CHECK_SECONDS: '5', MAESTRO_REPOST_NUDGE_HOLD_EMPTY: 'sometimes', MAESTRO_REPOST_NUDGE_ASKED_MINUTES: 'x', MAESTRO_REPOST_NUDGE_TZ: 'Mars/Base', MAESTRO_REPOST_NUDGE_START: '9am', MAESTRO_REPOST_NUDGE_END: '5pm' };
  const bad = load(badEnv);
  assert.deepEqual(JSON.parse(bad.stdout), JSON.parse(defaults.stdout), 'every bad value is its default');
  const lines = bad.stderr.trim().split('\n');
  for (const key of Object.keys(badEnv).map((k) => k.replace('MAESTRO_', '').toLowerCase())) assert.equal(lines.filter((l) => l.includes(` ${key} `)).length, 1, `${key} is logged exactly once`);
  assert.equal(lines.length, Object.keys(badEnv).length, lines.join('\n'));
  const window = load({ MAESTRO_REPOST_NUDGE_START: '18:00', MAESTRO_REPOST_NUDGE_END: '09:00' });
  assert.match(window.stderr, /repost_nudge_window/);
  assert.equal(JSON.parse(window.stdout).s, '08:30');
});
