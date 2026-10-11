import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { floorWarnings, readAutocompact, subagentNote, triggerTokens } from './autocompact.ts';

const withSettings = (env: Record<string, unknown>, fn: (path: string) => void): void => {
  const dir = mkdtempSync(join(tmpdir(), 'autocompact-'));
  try {
    const path = join(dir, 'settings.json');
    writeFileSync(path, JSON.stringify({ env, other: 'x' }));
    fn(path);
  } finally { rmSync(dir, { recursive: true, force: true }); }
};

test('the process environment beats the settings file', () => {
  withSettings({ CLAUDE_AUTOCOMPACT_PCT_OVERRIDE: '30' }, (path) => {
    assert.deepEqual(readAutocompact({ CLAUDE_AUTOCOMPACT_PCT_OVERRIDE: '20' }, path), { pct: 20, window: null, source: 'env' });
    assert.deepEqual(readAutocompact({}, path), { pct: 30, window: null, source: 'settings' });
  });
});

test('only the two named keys are read: a secret-shaped sibling never reaches a value or a warning', () => {
  const fake = `ghp_${'x'.repeat(36)}`;
  withSettings({ CLAUDE_AUTOCOMPACT_PCT_OVERRIDE: '5', SOME_TOKEN: fake }, (path) => {
    const s = readAutocompact({}, path);
    const out = JSON.stringify([s, floorWarnings(s), subagentNote(s)]);
    assert.ok(!out.includes(fake) && !out.includes('SOME_TOKEN'));
  });
});

test('a trigger is the window times the percent, else about 967k', () => {
  assert.equal(triggerTokens({ pct: 20, window: 1_000_000, source: 'env' }), 200_000);
  assert.equal(triggerTokens({ pct: 20, window: null, source: 'env' }), 200_000);
  assert.equal(triggerTokens({ pct: null, window: null, source: 'default' }), 967_000);
  assert.equal(triggerTokens({ pct: 50, window: 2_000_000, source: 'env' }, 1_000_000), 500_000, 'the window is capped at the model window');
});

test('below the floor warns with the value, the trigger and the floor; at or above is quiet', () => {
  const warn = floorWarnings({ pct: 5, window: null, source: 'env' }, 100_000);
  assert.equal(warn.length, 1);
  assert.match(warn[0], /=5 .*50k.*100k floor/);
  assert.deepEqual(floorWarnings({ pct: 20, window: null, source: 'env' }, 100_000), []);
  assert.deepEqual(floorWarnings({ pct: null, window: null, source: 'default' }, 100_000), []);
});

test('an invalid percentage or a too-small window reads as unset; a missing file is the default', () => {
  for (const bad of ['0', '101', 'abc', '']) assert.equal(readAutocompact({ CLAUDE_AUTOCOMPACT_PCT_OVERRIDE: bad }, '/nonexistent').pct, null);
  assert.equal(readAutocompact({ CLAUDE_CODE_AUTO_COMPACT_WINDOW: '50000' }, '/nonexistent').window, null);
  const d = readAutocompact({}, '/nonexistent');
  assert.equal(d.source, 'default');
  assert.equal(triggerTokens(d), 967_000);
  assert.match(subagentNote({ pct: 20, window: null, source: 'env' }), /about 40k/);
});
