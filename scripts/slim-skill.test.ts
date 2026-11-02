// Run: node --test scripts/slim-skill.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { SLIM_LINE } from './session-start.ts';

const read = (rel: string): string => readFileSync(new URL(`../${rel}`, import.meta.url), 'utf8');

test('slim/SKILL.md stays under 150 lines (always loaded in slim mode)', () => {
  const lines = read('slim/SKILL.md').split('\n').length;
  assert.ok(lines < 150, `slim/SKILL.md is ${lines} lines`);
});

test('the full SKILL.md hands off to slim/SKILL.md on the session-start mode line', () => {
  const marker = SLIM_LINE.split('.')[0] ?? '';
  const handoff = read('SKILL.md').split('\n').find((l) => l.includes(`\`${marker}\``));
  assert.ok(handoff?.includes('[slim/SKILL.md](slim/SKILL.md)'), `no SKILL.md line names \`${marker}\` and links slim/SKILL.md`);
});
