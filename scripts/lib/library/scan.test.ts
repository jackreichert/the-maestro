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

test('a bare random-looking token is caught: a 96-character base64 blob and a 32-character mixed token', () => {
  const blob = 'Zm9vYmFyQmF6UXV4MTIzNDU2Nzg5MGFiY2RlZkdISUpLTE1OT1BRUlNUVVZXWFlaYWJjZGVmZ2hpamtsbW5vcHFyc3R1dnd4eXo+/w==';
  assert.ok(blob.length >= 96);
  const mixed = 'aB3dE5gH7jK9mN2pQ4sT6vW8xZ1cF3hJ';
  for (const t of [blob, mixed, `the key is ${mixed}.`, `\`${mixed}\``, `"${blob}"`, `(${mixed})`]) {
    assert.deepEqual(scanText(t).map((h) => h.rule), ['secret:high-entropy'], t.slice(0, 20));
  }
});

test('ordinary evidence is not mistaken for a token: shas, digests, uuids, ledger ids, paths, urls, slugs and long identifiers', () => {
  const evidence = [
    'commit 488b6fe and 488b6fe0a1b2c3d4e5f60718293a4b5c6d7e8f90 on origin/develop',
    `sha256 ${'0123456789abcdef'.repeat(4)}`,
    'md5 9e107d9d372bb6826bd81d3542a419d6',
    'uuid 3f2b8c1e-5d4a-4b7e-9c10-a1b2c3d4e5f6',
    'ledger id k7q2 and ticket MAESTRO-149',
    'src/lib/library/scan.ts:24 and /Users/someone/dev-env/skills/the-maestro/scripts/library-check.ts#L40',
    'https://github.com/example-org/avonlea-api/blob/0123456789abcdef0123456789abcdef01234567/packages/orchard/src/sync.ts#L40-L52',
    'packages/orchard/src/harvest-export/HarvestExportHandler',
    'decision-orchard-row-id-column-added-before-the-harvest-sync-slug',
    'verifyOrchardSyncScheduleBeforeEveryHarvestExportRun',
    'Projects/avonlea-api/Knowledge/orchard-sync-nightly-schedule-and-retries',
    'TEAMSELECT_DB_NAME_FOR_THE_STAGING_INTERIM_DATABASE_CLUSTER',
    '-'.repeat(40), '='.repeat(40),
  ].join('\n');
  assert.deepEqual(scanText(evidence), []);
});

test('random base62 tokens are caught at the documented rate: at least 90 in 100 32-character ones and 98 in 100 64-character ones', () => {
  let seed = 12345;
  const next = (): number => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed; };
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  const token = (n: number): string => Array.from({ length: n }, () => alphabet[(next() >> 8) % 62]).join('');
  const caught = (n: number): number => Array.from({ length: 300 }, () => scanText(token(n)).length).filter(Boolean).length;
  assert.ok(caught(32) >= 270, `32: ${caught(32)}`);
  assert.ok(caught(64) >= 294, `64: ${caught(64)}`);
});
