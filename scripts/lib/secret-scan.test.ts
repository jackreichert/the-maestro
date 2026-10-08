// Run: node --test scripts/lib/secret-scan.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scanText, scanFields, describeFindings } from './secret-scan.ts';

const rules = (text: string, opts = {}): string[] => scanText(text, opts).map((f) => f.rule);

// Every sentinel is invented and assembled at run time from pieces, so no complete secret shape sits in this
// source file (a repo secret scanner would rightly flag one) and none is a live credential or a real person.
const j = (...parts: string[]): string => parts.join('');
const SENTINELS: [string, string][] = [
    ['private-key-block', j('-----BEGIN RSA ', 'PRIVATE KEY-----')],
    ['aws-access-key-id', j('key AKIA', 'ABCDEFGHIJKLMNOP in the log')],
    ['github-token', j('token ghp', '_', 'a1B2'.repeat(10))],
    ['slack-token', j('xox', 'b-1234567890-abcdefghij')],
    ['api-key-prefix', j('s', 'k-', 'Ab3dE6gH9j'.repeat(3))],
    ['jwt', j('ey', 'JhbGciOiJIUzI1NiJ9.', 'ey', 'JzdWIiOiJmYWtlIn0.c2lnbmF0dXJlMTIz')],
    ['url-credentials', j('postgres', '://svc_user:', 's3cretPass', '@db.internal.test:5432/app')],
    ['env-name-value', j('export DB_', 'PASSWORD=', 'hunter22x')],
    ['secret-assignment', j('pass', 'word=hunter2')],
    ['secret-colon-value', j('tok', 'en: Abcd1234Efgh')],
    ['high-entropy-blob', j('blob ', 'aB3dE6gH9jK2mN5pQ8'.repeat(3))],
    ['ssn', j('ssn 123-45', '-6789')],
    ['phone-number', 'call (555) 010-0199'],
    ['email-address', j('reach pat.sample', '@clinic.test')],
    ['date-of-birth', 'DOB: 1950-01-02'],
    ['medical-record-number', 'MRN 00012345'],
];

for (const [rule, text] of SENTINELS) {
    test(`flags ${rule}`, () => {
        assert.ok(rules(text).includes(rule), `${rule} not found in ${JSON.stringify(rules(text))}`);
    });
}

test('clean claims about systems, ids and counts pass', () => {
    for (const ok of [
        'The staging interim DB is reached through the staging Cloud SQL proxy on localhost:5439',
        'ClinicianPage.count is the page length, not the total (OpenAPI spec, 3 pages)',
        'Credentials are located with env-where <NAME>; the env store is canonical',
        'verified at 342b177c3f1d2a9e8b7c6d5e4f3a2b1c0d9e8f7a',
        'set PASSWORD=<redacted> and TOKEN=$TOKEN in the env file',
        'the token: the value comes from the store',
        j('postgres', '://user:', '<pass', 'word>', '@host/db'),
        'org id 4521 has 12 locations; run scripts/helpers/probe.sh --count',
    ]) assert.deepEqual(scanText(ok), [], ok);
});

test('an allowed email domain passes, another does not', () => {
    assert.deepEqual(rules('write to test@example.com', { allowedEmailDomains: ['example.com'] }), []);
    assert.deepEqual(rules('write to test@example.com'), ['email-address']);
    assert.deepEqual(rules('write to a@other.test', { allowedEmailDomains: ['example.com'] }), ['email-address']);
});

test('findings never carry the matched text', () => {
    const secret = 'hunter2-sentinel';
    const findings = scanText(j('pass', 'word=', secret));
    assert.ok(findings.length > 0);
    assert.ok(!JSON.stringify(findings).includes(secret));
    const lines = describeFindings(scanFields({ claim: j('pass', 'word=', secret) }));
    assert.ok(lines.length > 0 && lines.every((l) => !l.includes(secret)));
    assert.match(lines[0] ?? '', /^claim: looks like a secret \(/);
});

test('scanFields names the field and skips empty ones', () => {
    const f = scanFields({ claim: 'fine', evidence: j('ssn 123-45', '-6789'), note: undefined });
    assert.deepEqual(f.map((x) => [x.field, x.rule, x.class]), [['evidence', 'ssn', 'phi']]);
});

test('scanning is repeatable: no state leaks between calls', () => {
    const t = j('pass', 'word=hunter2');
    assert.deepEqual(scanText(t), scanText(t));
});
