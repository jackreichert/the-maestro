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

test('snake_case and kebab-case credential names are caught, not only bare ones', () => {
    for (const t of [j('db_pass', 'word=hunter2xyz'), j('access_tok', 'en=abcdef123456'), j('api-tok', 'en: Abcd1234Efgh'), j('https://h.test/x?access_tok', 'en=abcdef123456')]) {
        assert.ok(scanText(t).length > 0, t.replace(/=.*/, '='));
    }
});

test('common accidental pastes are caught: bearer headers, vendor prefixes, hex keys, camelCase and pwd names', () => {
    const hex32 = 'a1b2c3d4'.repeat(4);
    for (const t of [
        j('curl -H "Author', 'ization: Bear', 'er ', 'abcDEF123456abcdef7890', '" returned 200'),
        j('key AI', 'za', 'SyA1B2C3D4E5F6G7H8I9J0K1L2M3N4O5P6Q'),
        j('s', 'k_live_', 'abcdefghij1234'),
        j('gl', 'pat-', 'abcdefghij1234567890'),
        j('the key is ', hex32),
        j('db', 'Pass', 'word=hunter2xyz'),
        j('DB_', 'PWD=hunter22x'),
        j('pwd', '=hunter22x'),
        j('pass', 'word: Ab1defg'),
    ]) assert.ok(scanText(t).length > 0, t.slice(0, 20));
});

test('zero-width and fullwidth characters do not hide a shape', () => {
    assert.ok(scanText(j('AK', '\u200b', 'IAABCDEFGHIJKLMNOP')).length > 0);
    assert.ok(scanText(j('\uff21\uff2b\uff29\uff21', 'ABCDEFGHIJKLMNOP')).length > 0);
    assert.ok(scanText(j('a', '\uff20', 'clinic.test')).length > 0);
});

test('long adversarial input scans in well under a second', () => {
    for (const unit of ['a.', 'x@a.', 'aB3-', '123-', 'a:']) {
        const t0 = Date.now();
        scanText(unit.repeat(50_000));
        assert.ok(Date.now() - t0 < 1000, `${unit} took ${Date.now() - t0}ms`);
    }
});

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

test('a long path or URL is not a blob, but a random token is, in a path or alone', () => {
    for (const ok of [
        'Projects/the-maestro/Plans/2026-10-08-ledger-to-library.md',
        'https://github.com/Example-Org/example-repo/pull/488/files',
        'tests/integration/test_ClinicianPageCountSemantics_2026.py:88',
        'terraform/modules/rds_proxy/RdsProxyStagingSharedSecretsManagerPolicy2.tf:30',
        'Projects/example-repo/Reviews/2026-10-08-Learned-Entries-Re-Review-v2-Final-Notes.md',
    ]) assert.deepEqual(scanText(ok), [], ok);
    const blob = 'aB3dE6gH9jK2mN5pQ8rS1tU4vW7xY0zC';
    for (const bad of [
        blob + blob,
        `https://example.test/files/${blob}${blob}`,
        `docs/${blob}${blob}/index`,
        `${blob}/${blob}`,
        `https://example.test/a/b?sig=${blob}${blob}`,
        `A${'bC1+dE2/fG3-'.repeat(5)}`,
    ]) assert.ok(rules(bad).length > 0, bad.slice(0, 30));
});

test('shapes a first pass missed are caught: short bearer values, npm tokens, password flags, passphrases, written-out dates of birth, bare SSNs, slashes in a URL password', () => {
    for (const t of [
        j('Author', 'ization: Bear', 'er abc123def456'),
        j('npm', '_', 'a1B2c3D4'.repeat(5)),
        j('postgres', '://admin:pa/ss', '1234@db.internal.test/app'),
        j('run with --pass', 'word x'),
        j('run with --pass', 'word=correcthorsebattery'),
        j('run with --api', '-key abc'),
        j('pass', 'word: correcthorsebattery'),
        j('db', 'Pass', 'word: correcthorsebattery'),
        'DOB: 03-03-1950',
        'dob 3.3.1950',
        'date of birth: March 3, 1950',
        'born on 3rd Mar 1950',
        'SSN 123456789',
        'social security number: 123456789',
        'ssn 123-45-6789',
    ]) assert.ok(scanText(t).length > 0, t.replace(/\S+$/, '<value>'));
});

// A single long word after `password:` is read as a passphrase, so `password: authentication` is refused: a reword costs less than a leak.
test('prose near those shapes still passes', () => {
    for (const ok of [
        'the bearer tokens are rotated nightly',
        'Basic authentication is off in staging',
        'send the bearer header as documented',
        'run with --password-file /run/secrets/db',
        'run with --password <redacted>',
        'the password: rotated monthly',
        'see http://host:8080/path/to/file@latest',
        'born in the 1950s; date of birth is not stored',
        'the ssn column is masked',
        'npm tokens are scoped per package',
    ]) assert.deepEqual(scanText(ok), [], ok);
});

test('a bare 40-hex or 64-hex value is a key unless a label says it is a sha or a digest', () => {
    const h40 = '5f4dcc3b5aa765d61d8327deb882cf995f4dcc3b';
    const h64 = 'a1b2c3d4'.repeat(8);
    for (const bad of [`legacy token ${h40}`, `key ${h64}`, h40, `sha ${h64}`, `checksum ${h40}`]) assert.ok(rules(bad).includes('hex-key'), bad.slice(0, 24));
    for (const ok of [
        `sha ${h40}`, `commit ${h40}`, `commit: ${h40}`, `rev ${h40}`, `merged at head ${h40}`, `repo@${h40}`, `SHA-1 ${h40}`,
        `https://github.com/example-org/example-repo/commit/${h40}`, `https://github.com/example-org/example-repo/blob/${h40}/README.md`,
        `sha256 ${h64}`, `sha256:${h64}`, `checksum: ${h64}`, `digest ${h64}`,
        '1727982', `(commit 172798256b14d55d39d43eadaf54dafdb39d27ca, tests green)`,
    ]) assert.deepEqual(scanText(ok), [], ok);
});

test('scanFields lets a sha-field hold a bare 40-hex sha and nothing longer', () => {
    const h40 = '5f4dcc3b5aa765d61d8327deb882cf995f4dcc3b';
    assert.deepEqual(scanFields({ 'verified-at': h40 }, { shaFields: ['verified-at'] }), []);
    assert.deepEqual(scanFields({ evidence: h40 }, { shaFields: ['verified-at'] }).map((f) => f.field), ['evidence']);
    assert.equal(scanFields({ 'verified-at': 'a1b2c3d4'.repeat(8) }, { shaFields: ['verified-at'] }).length, 1, 'only a 40-hex value is exempt');
});

test('percent-encoded and lookalike-letter shapes are decoded and folded before matching', () => {
    for (const t of [
        j('AKIA%49', 'OSFODNN7EXAMPLE'),
        j('AKIA%2549', 'OSFODNN7EXAMPLE'),
        j('tok', 'en%3Dabcd1234efgh5678'),
        j('pass', 'word%3Dhunter2xyz'),
        j('AKIAIOSFODNN7EXA', 'М', 'PLE'),
        j('ΑKIAIOSFODNN7EXAMPLE'),
        j('рassword', '=hunter2xyz'),
        j('gіthub_pat_', 'a1B2c3D4'.repeat(5)),
    ]) assert.ok(scanText(t).length > 0, t.slice(0, 16));
});

test('decoding is bounded and leaves ordinary percent signs alone', () => {
    assert.deepEqual(scanText('50% of 12 rows; 100% done; %zz and %4 stay as written'), []);
    assert.deepEqual(scanText('Cyrillic prose is not altered into a shape: Привет, мир'), []);
    const t0 = Date.now();
    scanText('%25'.repeat(50_000) + '%41'.repeat(50_000));
    assert.ok(Date.now() - t0 < 1000, `took ${Date.now() - t0}ms`);
});
