// Run: node --test scripts/lib/library/scan.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scanText } from './scan.ts';

// Built at run time so this file holds no secret-shaped literal.
const SHAPES: Record<string, string> = {
  'secret:private-key': `-----BEGIN ${'RSA'} PRIVATE KEY-----`,
  'secret:aws-access-key': `key ${'AKIA'}${'ABCDEFGHIJKLMNOP'}`,
  'secret:github-token': `${'ghp'}_${'a'.repeat(36)}`,
  'secret:slack-token': `${'xoxb'}-${'1'.repeat(12)}`,
  'secret:api-key': `${'sk'}-${'a1'.repeat(14)}`,
  'secret:jwt': `${'eyJ'}${'a'.repeat(10)}.${'b'.repeat(10)}.${'c'.repeat(10)}`,
  'secret:bearer-token': `Authorization: ${'Bearer'} ${'x'.repeat(24)}`,
  'secret:url-credentials': `postgres://orchard_user:${'hunter2hunter2'}@db.example.net/orchard`,
  'secret:env-assignment': `ORCHARD_API_${'TOKEN'}=${'q'.repeat(12)}`,
  'secret:named-value': `${'password'}: ${'swordfish99'}`,
  'phi:email': 'mail jane.doe@clinic.example.net today',
  'phi:phone': 'call 614-555-0142',
  'phi:ssn': 'id 123-45-6789',
  'phi:birth-date': 'DOB: 1970-01-01',
};

test('each shape is reported by its own rule, with the line number', () => {
  for (const [rule, sample] of Object.entries(SHAPES)) {
    const hits = scanText(`first line\n${sample}\n`);
    assert.ok(hits.some((h) => h.rule === rule && h.line === 2), `${rule} not found in its sample`);
  }
});

test('a hit never carries the matched text', () => {
  const hits = scanText(SHAPES['secret:named-value'] as string);
  assert.deepEqual(Object.keys(hits[0] as object).sort(), ['line', 'rule']);
});

test('names, placeholders and ordinary prose are clean', () => {
  const clean = [
    'The Kubernetes secret keeps the ORCHARD_DB_NAME key and the ORCHARD_API_TOKEN name only.',
    'ORCHARD_API_TOKEN=<redacted>',
    'postgres://orchard_user:<password>@db.example.net/orchard',
    'password: $ORCHARD_PASSWORD',
    'proxy on localhost:5439, 12 rows, verified 2026-10-08',
    'contact support@example.com',
  ].join('\n');
  assert.deepEqual(scanText(clean), []);
});
