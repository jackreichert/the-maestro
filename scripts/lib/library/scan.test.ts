// Run: node --test scripts/lib/library/scan.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scanText } from './scan.ts';

// Built at run time so this file holds no secret-shaped literal. Every value is a fake placeholder for a test.
const SHAPES: Record<string, string> = {
  'secret:private-key': `-----BEGIN ${'RSA'} PRIVATE KEY-----`,
  'secret:aws-access-key': `key ${'AKIA'}${'ABCDEFGHIJKLMNOP'}`,
  'secret:github-token': `${'ghp'}_${'a'.repeat(36)}`,
  'secret:slack-token': `${'xoxb'}-${'1'.repeat(12)}`,
  'secret:api-key': `${'sk'}-${'a1'.repeat(14)}`,
  'secret:jwt': `${'eyJ'}${'a'.repeat(10)}.${'b'.repeat(10)}.${'c'.repeat(10)}`,
  'secret:auth-header': `Authorization: ${'Bearer'} ${'x'.repeat(24)}`,
  'secret:url-credentials': `postgres://orchard_user:${'fakepass1234'}@db.example.net/orchard`, // example fixture
  'secret:key-value': `ORCHARD_API_${'TOKEN'}=${'q'.repeat(12)}`,
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
  const hits = scanText(SHAPES['secret:key-value'] as string);
  assert.deepEqual(Object.keys(hits[0] as object).sort(), ['line', 'rule']);
});

test('names, placeholders and ordinary prose are clean', () => {
  const clean = [
    'The Kubernetes secret keeps the ORCHARD_DB_NAME key and the ORCHARD_API_TOKEN name only.',
    'ORCHARD_API_TOKEN=<redacted>',
    'password: ${ORCHARD_PASSWORD}',
    'the token: none',
    'tokens: 12 rows',
    'postgres://orchard_user:<password>@db.example.net/orchard',
    'password: $ORCHARD_PASSWORD',
    'proxy on localhost:5439, 12 rows, verified 2026-10-08',
    'contact support@example.com',
  ].join('\n');
  assert.deepEqual(scanText(clean), []);
});

test('the common config forms are caught: snake and camel keys, quoted keys, spaces, next-line values, no-user URLs', () => {
  const forms = [
    `db_${'password'}: fakevalue99`, `access_${'token'} = fakevalue99`, `client_${'secret'}: fakevalue99`, `aws_${'secret'}_access_key = fakevalue99`, `db${'Password'}: fakevalue99`,
    `"${'password'}": "fakevalue99"`, `'api_${'key'}': fakevalue99`, `${'secret'}_key: fakevalue99`, `${'password'}: "fake horse battery staple"`,
    `${'password'}: |\n  fakevalue99`, `${'password'}:\n  fakevalue99`, `redis://:${'fake123'}@localhost:6379`, `postgres://u:${'fake1234'}@dbhost/x`, // example fixtures
    `Authorization: ${'bearer'} ${'x'.repeat(20)}`, `Authorization: ${'Basic'} ${'dXNlcjpwYXNz'.repeat(2)}`, `${'sk_live'}_${'a'.repeat(20)}`,
    `${'AIza'}${'a'.repeat(35)}`, `${'npm'}_${'a'.repeat(36)}`, `https://${'hooks.slack.com'}/services/T0/B0/x`, 'ssn 123 45 6789', '+15550100123', 'date_of_birth: 1970-01-01',
  ];
  for (const f of forms) assert.ok(scanText(f).length > 0, `not caught: ${f.replace(/[A-Za-z0-9]{8,}/g, 'X')}`);
});

test('a line over the length cap is reported instead of scanned, so the scan stays linear', () => {
  const hits = scanText(`${'a.'.repeat(5000)}\nfine line`);
  assert.deepEqual(hits, [{ rule: 'scan:line-too-long', line: 1 }]);
});
