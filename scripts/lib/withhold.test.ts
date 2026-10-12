import { test } from 'node:test';
import assert from 'node:assert/strict';
import { withhold, WITHHELD } from './withhold.ts';

// A fake GitHub-token shape built from placeholder text; nothing here is a real credential.
const token = `ghp_${'a1B2c3D4e5F6g7H8i9J0'}${'k1L2m3N4o5P6'}`;
const split = (sep: string): string => `${token.slice(0, 10)}${sep}${token.slice(10)}`;

test('withhold replaces a plain secret-shaped line and keeps the rest', () => {
  assert.equal(withhold(`ok\nstream ${token}\nfine`), `ok\n${WITHHELD}\nfine`);
});

test('withhold catches a token split by a zero-width character', () => {
  const line = `stream ${split('​')} end`;
  assert.equal(withhold(`ok\n${line}`), `ok\n${WITHHELD}`);
});

test('withhold catches a token split by a space', () => {
  assert.equal(withhold(`ok\nstream ${split(' ')} end`), `ok\n${WITHHELD}`);
});

test('withhold withholds the original line, not the normalised one', () => {
  const out = withhold(`a ${split('​')}\nb`);
  assert.ok(!out.includes('​') && !out.includes('ghp_'));
});

test('withhold leaves ordinary lines with spaces and zero-width characters alone', () => {
  const body = 'two words\nzero​width in prose';
  assert.equal(withhold(body), body);
});
