import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadHookGuard } from './hook-guard.ts';

const dir = mkdtempSync(join(tmpdir(), 'hook-guard-'));
const hook = (name: string, body: string): string => { const p = join(dir, name); writeFileSync(p, body); return p; };

test('an absent hook adds no check', async () => {
  assert.equal(await loadHookGuard(join(dir, 'nope.mjs')), undefined);
});

test('a hook that blocks refuses the command, one that allows does not, one that throws refuses', async () => {
  const blocks = await loadHookGuard(hook('a.mjs', "export const decide = (i) => ({ block: i.tool_input.command.includes('bad') });"));
  assert.equal(blocks?.('echo bad') !== null, true);
  assert.equal(blocks?.('echo good'), null);
  const throws = await loadHookGuard(hook('b.mjs', "export const decide = () => { throw new Error('x'); };"));
  assert.notEqual(throws?.('echo good'), null);
});

test('a module without a decision function, or one that does not load, adds no check', async () => {
  assert.equal(await loadHookGuard(hook('c.mjs', 'export const x = 1;')), undefined);
  assert.equal(await loadHookGuard(hook('d.mjs', 'this is not javascript')), undefined);
});
