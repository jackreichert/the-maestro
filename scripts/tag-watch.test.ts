// Run: node --test scripts/tag-watch.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkTags, findSkillFile, tagEvents } from './lib/tag-watch.ts';
import type { ProbeResult, RefreshResult, TagAdapter, TagWatchState } from './lib/tag-watch.ts';
import type { Run } from './lib/types.ts';

const T0 = Date.parse('2026-10-05T15:00:00Z');
const run: Run = () => ({ status: 0, stdout: '', stderr: '' });
const changed = (id: string): RefreshResult => ({ kind: 'changed', id, note: '/v/plan.md', diff: `/v/plan.diff-${id}.md`, added: 4, removed: 1 });

/** A scripted source: set `probeNext` / `refreshNext`, and read how often each was called. */
function source(tags = ['plan']) {
  const s = { probeNext: { kind: 'ok', tags: {} } as ProbeResult, refreshNext: { kind: 'same' } as RefreshResult, probes: 0, refreshes: [] as string[] };
  const adapter: TagAdapter = {
    label: 'NOTION',
    tags: () => tags,
    probe: () => { s.probes++; return s.probeNext; },
    refresh: (_f, tag) => { s.refreshes.push(tag); return s.refreshNext; },
  };
  return { s, adapter };
}

/** A fake loop: carries the state between ticks and collects the event summaries. */
function loop(adapter: TagAdapter) {
  let state: TagWatchState | null = null;
  let now = T0;
  return {
    tick(advanceS = 900): string[] {
      now += advanceS * 1000;
      const next = checkTags(adapter, '/r.json', { run, now, prev: state });
      const events = tagEvents('NOTION', state, next).map((e) => e.summary);
      state = next;
      return events;
    },
    get state() { return state as TagWatchState; },
  };
}

test('unchanged pages are silent and never trigger a refresh', () => {
  const { s, adapter } = source();
  s.probeNext = { kind: 'ok', tags: { plan: 'unchanged' } };
  const l = loop(adapter);
  assert.deepEqual([l.tick(), l.tick(), l.tick()], [[], [], []]);
  assert.deepEqual(s.refreshes, []);
});

test('a change refreshes once and emits exactly one actionable CHANGED line with the diff path and counts', () => {
  const { s, adapter } = source();
  const l = loop(adapter);
  s.probeNext = { kind: 'ok', tags: { plan: 'changed' } };
  s.refreshNext = changed('h1');
  assert.deepEqual(l.tick(), ['NOTION-CHANGED tag=plan note=/v/plan.md diff=/v/plan.diff-h1.md summary=+4/-1 lines']);
  s.probeNext = { kind: 'ok', tags: { plan: 'unchanged' } };
  assert.deepEqual(l.tick(), [], 'the same change is not announced again');
  s.probeNext = { kind: 'ok', tags: { plan: 'changed' } };
  s.refreshNext = changed('h2');
  assert.equal(l.tick().length, 1, 'a later, different change is');
  assert.equal(tagEvents('NOTION', null, l.state)[0]?.actionable, true);
});

test('a page that moved but has nothing new to read (same) stays silent', () => {
  const { s, adapter } = source();
  s.probeNext = { kind: 'ok', tags: { plan: 'changed' } };
  s.refreshNext = { kind: 'same' };
  assert.deepEqual(loop(adapter).tick(), []);
});

test('an unshared page (404/403/archived) is one distinct event, once, and again if it returns and goes away again', () => {
  const { s, adapter } = source();
  const l = loop(adapter);
  s.probeNext = { kind: 'ok', tags: { plan: { gone: '404' } } };
  assert.deepEqual(l.tick(), ['NOTION-UNSHARED tag=plan reason=404']);
  assert.deepEqual(l.tick(), []);
  assert.deepEqual(l.tick(), []);
  s.probeNext = { kind: 'ok', tags: { plan: 'unchanged' } };
  assert.deepEqual(l.tick(), []);
  s.probeNext = { kind: 'ok', tags: { plan: { gone: '403' } } };
  assert.deepEqual(l.tick(), ['NOTION-UNSHARED tag=plan reason=403']);
});

test('a refresh that finds the page gone is the same UNSHARED event', () => {
  const { s, adapter } = source();
  s.probeNext = { kind: 'ok', tags: { plan: 'changed' } };
  s.refreshNext = { kind: 'gone', reason: '404' };
  assert.deepEqual(loop(adapter).tick(), ['NOTION-UNSHARED tag=plan reason=404']);
});

test('a 429 on the probe is silent and nothing is called again until Retry-After has passed (at least a minute)', () => {
  const { s, adapter } = source();
  const l = loop(adapter);
  s.probeNext = { kind: 'rate-limited', retryAfter: 5 };
  assert.deepEqual(l.tick(), []);
  assert.equal(s.probes, 1);
  s.probeNext = { kind: 'ok', tags: { plan: 'changed' } };
  s.refreshNext = changed('h1');
  assert.deepEqual(l.tick(30), [], 'inside the backoff window: no call at all');
  assert.equal(s.probes, 1);
  assert.equal(l.tick(60).length, 1, 'after it: back to normal');
  assert.equal(s.probes, 2);
});

test('a 429 during the refresh backs off without losing the change, which is reported once the refresh succeeds', () => {
  const { s, adapter } = source();
  const l = loop(adapter);
  s.probeNext = { kind: 'ok', tags: { plan: 'changed' } };
  s.refreshNext = { kind: 'rate-limited', retryAfter: 120 };
  assert.deepEqual(l.tick(), []);
  assert.equal(l.state.retryAt > T0, true);
  s.refreshNext = changed('h1');
  assert.deepEqual(l.tick(30), []);
  assert.equal(l.tick(200).length, 1);
});

test('network errors are counted, speak once on the third in a row (informational), and reset on success', () => {
  const { s, adapter } = source();
  const l = loop(adapter);
  s.probeNext = { kind: 'error', message: 'getaddrinfo ENOTFOUND' };
  assert.deepEqual([l.tick(), l.tick()], [[], []]);
  assert.deepEqual(l.tick(), ['NOTION-CHECK-FAILING tag=plan getaddrinfo ENOTFOUND']);
  assert.deepEqual([l.tick(), l.tick()], [[], []], 'not repeated while it keeps failing');
  s.probeNext = { kind: 'ok', tags: { plan: 'unchanged' } };
  l.tick();
  assert.equal(l.state.tags.plan?.fails, 0);
});

test('an empty registry costs nothing: no probe', () => {
  const { s, adapter } = source([]);
  assert.deepEqual(loop(adapter).tick(), []);
  assert.equal(s.probes, 0);
});

test('findSkillFile honours the override variable and names where it looked when the skill is missing', () => {
  const dir = mkdtempSync(join(tmpdir(), 'skill-'));
  mkdirSync(join(dir, 'scripts'));
  writeFileSync(join(dir, 'scripts', 'a.ts'), 'export const label = "X";\n');
  assert.equal(findSkillFile('demo-skill', 'scripts/a.ts', { DEMO_SKILL_DIR: dir }), join(dir, 'scripts', 'a.ts'));
  assert.throws(() => findSkillFile('no-such-skill-xyz', 'scripts/a.ts', {}), /skill is not installed.*NO_SUCH_SKILL_XYZ_DIR/);
});
