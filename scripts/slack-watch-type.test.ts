// Run: node --test scripts/slack-watch-type.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { tick } from './event-loop.ts';
import { BUILTIN_TYPES } from './event-types/index.ts';
import * as slack from './event-types/slack-watch.ts';
import { tagEvents } from './lib/tag-watch.ts';
import { addWatch } from './lib/watch-registry.ts';

const NOON = Date.parse('2026-10-05T16:00:00Z');
const quiet = { run: () => ({ status: 0, stdout: '', stderr: '' }) };

/** A stand-in for the slack-sync skill, so the suite needs neither the skill, a token nor Slack. The type loads the adapter once, so the verdict is read from the environment at call time. */
const SKILL = mkdtempSync(join(tmpdir(), 'fake-slack-skill-'));
mkdirSync(join(SKILL, 'scripts'));
writeFileSync(join(SKILL, 'scripts', 'slack-watch-adapter.ts'), `
export const label = 'SLACK';
export const tags = () => ['team'];
export const probe = () => ({ kind: 'ok', tags: { team: JSON.parse(process.env.FAKE_SLACK_VERDICT) } });
export const refresh = () => ({ kind: 'changed', id: 'team@100.2', note: '/v/team.md', diff: '/v/team.new-100.2.md', added: 3, removed: 0 });
`);

function withSkill<T>(verdict: 'changed' | 'unchanged' | { gone: string }, body: () => T): T {
  const saved = [process.env.SLACK_SYNC_DIR, process.env.FAKE_SLACK_VERDICT];
  process.env.SLACK_SYNC_DIR = SKILL;
  process.env.FAKE_SLACK_VERDICT = JSON.stringify(verdict);
  try { return body(); } finally {
    for (const [k, v] of [['SLACK_SYNC_DIR', saved[0]], ['FAKE_SLACK_VERDICT', saved[1]]] as const) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
}

test('the type is registered, renews, and the target must be a registry path', () => {
  assert.equal(BUILTIN_TYPES['slack-watch'], slack);
  assert.equal(slack.interval, 300);
  assert.equal(slack.network, true);
  assert.equal(slack.renews, true);
  assert.equal(slack.defaultTtlMs('/abs/slack-tags.json', 0), 72 * 3600 * 1000);
  slack.validate('/abs/slack-tags.json', { now: 0 });
  assert.throws(() => slack.validate('slack-tags.json', { now: 0 }), /absolute path/);
  assert.throws(() => slack.validate('/abs/notes.md', { now: 0 }), /\.json/);
});

test('new messages become one SLACK-NEW line through the loop, once', () => {
  withSkill('changed', () => {
    const dir = mkdtempSync(join(tmpdir(), 'loop-'));
    addWatch(dir, { id: 'slack', type: 'slack-watch', target: '/abs/slack-tags.json', report: 'tell the user' }, NOON);
    const first = tick({ dir, types: BUILTIN_TYPES, now: NOON + 1000, config: { quietHours: 'off' }, ctx: quiet });
    assert.deepEqual(first.events.map((e) => [e.summary, e.actionable, e.report]), [['SLACK-NEW tag=team note=/v/team.md new=3 file=/v/team.new-100.2.md', true, 'tell the user']]);
    const later = tick({ dir, types: BUILTIN_TYPES, now: NOON + 3_600_000, config: { quietHours: 'off' }, ctx: quiet });
    assert.deepEqual(later.events, [], 'the same messages are not reported twice');
  });
});

test('an unchanged probe produces no event at all', () => {
  withSkill('unchanged', () => {
    const dir = mkdtempSync(join(tmpdir(), 'loop-'));
    addWatch(dir, { id: 'slack', type: 'slack-watch', target: '/abs/slack-tags.json', report: 'tell the user' }, NOON);
    const r = tick({ dir, types: BUILTIN_TYPES, now: NOON + 1000, config: { quietHours: 'off' }, ctx: quiet });
    assert.deepEqual(r.events, []);
  });
});

test('a conversation the token lost reports SLACK-UNSHARED with the reason', () => {
  withSkill({ gone: 'not_in_channel' }, () => {
    const state = slack.check('/abs/slack-tags.json', { ...quiet, now: NOON });
    assert.deepEqual(slack.diff(null, state)?.map((e) => [e.summary, e.actionable]), [['SLACK-UNSHARED tag=team reason=not_in_channel', true]]);
  });
});

test('other labels keep the CHANGED wording', () => {
  const state = { tags: { plan: { status: 'ok' as const, reason: '', fails: 0, error: '', change: { id: 'h', note: '/n.md', diff: '/n.diff', added: 2, removed: 1 } } }, retryAt: 0 };
  assert.deepEqual(tagEvents('NOTION', null, state).map((e) => e.summary), ['NOTION-CHANGED tag=plan note=/n.md diff=/n.diff summary=+2/-1 lines']);
  assert.deepEqual(tagEvents('SLACK', null, state).map((e) => e.summary), ['SLACK-NEW tag=plan note=/n.md new=2 file=/n.diff']);
});
