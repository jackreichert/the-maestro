import { test } from 'node:test';
import assert from 'node:assert/strict';
import { withholdJson } from './json-out.ts';
import { WITHHELD } from './withhold.ts';

const token = `ghp_${'a1B2c3D4e5F6g7H8i9J0'}${'k1L2m3N4o5P6'}`;

test('withholdJson redacts secret-shaped values and keys in place and leaves the rest alone', () => {
  const out = withholdJson({ stream: token, n: 3, ok: true, none: null, list: ['fine', token], nested: { [token]: 'x', day: new Date(0) } });
  assert.deepEqual(out, { stream: WITHHELD, n: 3, ok: true, none: null, list: ['fine', WITHHELD], nested: { [WITHHELD]: 'x', day: '1970-01-01T00:00:00.000Z' } });
  assert.ok(!JSON.stringify(out).includes(token));
});

test('two secret-shaped keys stay two keys', () => {
  const out = withholdJson({ [token]: 1, [`${token}x`]: 2 }) as Record<string, number>;
  assert.equal(Object.keys(out).length, 2);
});
