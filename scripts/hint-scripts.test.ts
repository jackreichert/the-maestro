// Run: node --test scripts/hint-scripts.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
/** The sources whose strings the prime board, the status line and the handoff print as things to run. */
const HINT_SOURCES = ['scripts/lib/continuous-roll.ts', 'scripts/lib/standing.ts', 'scripts/lib/journal/handoff.ts', 'scripts/lib/journal/approvals.ts', 'scripts/lib/journal/compact-checklist.ts', 'scripts/lib/journal/guidance.ts'];

/** A script named in backticks inside a hint, as written: `x.ts`, `scripts/x.ts`, `node scripts/hooks/x.ts`. */
const NAMED = /`(?:node |node --[\w-]+ )?((?:[\w.-]+\/)*[\w-]+\.ts)\b/g;
/** A hint is run from the repo root, or from scripts/ (where most of the tools sit), so either must resolve it. */
const resolves = (name: string): boolean => existsSync(join(ROOT, name)) || existsSync(join(ROOT, 'scripts', name));

test('every script a prime or status hint tells the reader to run exists where it is written', () => {
  const missing: string[] = [];
  let seen = 0;
  for (const source of HINT_SOURCES) {
    const text = readFileSync(join(ROOT, source), 'utf8');
    for (const m of text.matchAll(NAMED)) {
      seen += 1;
      if (!resolves(m[1]!)) missing.push(`${source}: \`${m[1]}\``);
    }
  }
  assert.ok(seen > 0, 'the scan found no script names, so the pattern or the source list is stale');
  assert.deepEqual(missing, [], 'a hint names a script that does not resolve from the repo root or scripts/');
});

test('the hint sources all exist, so a rename cannot empty the scan silently', () => {
  for (const source of HINT_SOURCES) assert.ok(existsSync(join(ROOT, source)), source);
  assert.ok(readdirSync(join(ROOT, 'scripts')).includes('hooks'));
});
