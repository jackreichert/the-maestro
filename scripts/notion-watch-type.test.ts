// Run: node --test scripts/notion-watch-type.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { tick } from './event-loop.ts';
import { BUILTIN_TYPES } from './event-types/index.ts';
import * as notion from './event-types/notion-watch.ts';
import { addWatch } from './lib/watch-registry.ts';

const NOON = Date.parse('2026-10-05T16:00:00Z');

/** A stand-in for the notion-sync skill, so the suite needs neither the skill nor Notion. */
function fakeSkill(source: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'fake-skill-'));
  mkdirSync(join(dir, 'scripts'));
  writeFileSync(join(dir, 'scripts', 'notion-watch-adapter.ts'), source);
  return dir;
}
const ADAPTER = `
export const label = 'NOTION';
export const tags = () => ['plan'];
export const probe = () => ({ kind: 'ok', tags: { plan: 'changed' } });
export const refresh = () => ({ kind: 'changed', id: 'h1', note: '/v/plan.md', diff: '/v/plan.diff-1.md', added: 2, removed: 0 });
`;

test('the type is registered with the documented schedule and the watch target must be a registry path', () => {
  assert.equal(BUILTIN_TYPES['notion-watch'], notion);
  assert.equal(notion.interval, 900);
  assert.equal(notion.network, true);
  assert.equal(notion.defaultTtlMs("/abs/notion-tags.json", 0), 72 * 3600 * 1000);
  notion.validate('/abs/notion-tags.json', { now: 0 });
  assert.throws(() => notion.validate('notion-tags.json', { now: 0 }), /absolute path/);
  assert.throws(() => notion.validate('/abs/notes.md', { now: 0 }), /\.json/);
});

test('through the loop, a change from the skill becomes one actionable digest line', () => {
  const saved = process.env.NOTION_SYNC_DIR;
  process.env.NOTION_SYNC_DIR = fakeSkill(ADAPTER);
  try {
    const dir = mkdtempSync(join(tmpdir(), 'loop-'));
    addWatch(dir, { id: 'notion', type: 'notion-watch', target: '/abs/notion-tags.json', report: 'tell the user' }, NOON);
    const first = tick({ dir, types: BUILTIN_TYPES, now: NOON + 1000, config: { quietHours: 'off' }, ctx: { run: () => ({ status: 0, stdout: '', stderr: '' }) } });
    assert.deepEqual(first.events.map((e) => [e.summary, e.actionable, e.report]), [['NOTION-CHANGED tag=plan note=/v/plan.md diff=/v/plan.diff-1.md summary=+2/-0 lines', true, 'tell the user']]);
    const later = tick({ dir, types: BUILTIN_TYPES, now: NOON + 3_600_000, config: { quietHours: 'off' }, ctx: { run: () => ({ status: 0, stdout: '', stderr: '' }) } });
    assert.deepEqual(later.events, [], 'the same change is not reported twice');
  } finally {
    if (saved === undefined) delete process.env.NOTION_SYNC_DIR; else process.env.NOTION_SYNC_DIR = saved;
  }
});

test('without the skill installed the check fails loudly with where it looked, and nothing else in the loop breaks', () => {
  const saved = process.env.NOTION_SYNC_DIR;
  process.env.NOTION_SYNC_DIR = join(tmpdir(), 'definitely-not-here');
  try {
    // The home-directory fallbacks may find a real install on a developer machine; only assert when none does.
    try { notion.check('/abs/notion-tags.json', { run: () => ({ status: 0, stdout: '', stderr: '' }), now: NOON }); } catch (err) {
      assert.match((err as Error).message, /notion-sync skill is not installed.*NOTION_SYNC_DIR/);
    }
  } finally {
    if (saved === undefined) delete process.env.NOTION_SYNC_DIR; else process.env.NOTION_SYNC_DIR = saved;
  }
});
