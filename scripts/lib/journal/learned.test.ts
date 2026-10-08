// Run: node --test scripts/lib/journal/learned.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseLearned, learnedProblems, parseAppliesTo } from './learned.ts';
import type { RawLearned } from './learned.ts';

const ctx = { learnedIds: new Set(['ab12']) };
const GOOD: RawLearned = {
    claim: 'The fake-service page count is the page length, not the total.', kind: 'how-it-works', appliesTo: 'fake-repo:fake-api:staging',
    evidence: 'docs/openapi.yaml:120', verifiedAt: '2026-10-08 read the spec', confidence: 'observed', supersedes: null,
};
const parse = (over: Partial<RawLearned> = {}, c = ctx) => parseLearned({ ...GOOD, ...over }, c);

test('a complete entry parses to the stored fields', () => {
    const r = parse();
    assert.deepEqual(r.errors, []);
    assert.deepEqual(r.fields, {
        text: GOOD.claim, learnedKind: 'how-it-works', appliesTo: 'fake-repo:fake-api:staging', evidence: 'docs/openapi.yaml:120', verifiedAt: '2026-10-08 read the spec', confidence: 'observed',
    });
});

test('a missing evidence or applies-to is refused and no fields come back', () => {
    for (const [over, pattern] of [[{ evidence: null }, /--evidence is required/], [{ appliesTo: null }, /--applies-to is required/], [{ evidence: '   ' }, /--evidence is required/]] as const) {
        const r = parse(over);
        assert.equal(r.fields, undefined);
        assert.ok(r.errors.some((e) => pattern.test(e)), String(pattern));
    }
});

test('every refusal is reported, not only the first', () => {
    const r = parse({ kind: 'idea', appliesTo: 'nope', verifiedAt: 'yesterday', confidence: 'sure' });
    assert.equal(r.errors.length, 4);
});

const GOOD_STORED = { text: GOOD.claim, learnedKind: 'gotcha', appliesTo: 'fake-repo:fake-api', evidence: 'x:1', verifiedAt: '342b177', confidence: 'observed' };

test('a bare claim of nothing, a multi-line claim and an over-long claim are refused', () => {
    assert.match(parse({ claim: '  ' }).errors[0] ?? '', /claim is required/);
    assert.match(learnedProblems({ ...GOOD_STORED, text: 'one\ntwo' }, new Set())[0] ?? '', /must be one line/);
    assert.match(parse({ claim: 'x'.repeat(401) }).errors[0] ?? '', /over 400/);
});

test('applies-to parses repo:component[:env] and rejects unknown envs and extra parts', () => {
    assert.deepEqual(parseAppliesTo('r:c:prod'), { repo: 'r', component: 'c', env: 'prod' });
    assert.deepEqual(parseAppliesTo('r:c'), { repo: 'r', component: 'c' });
    for (const bad of ['r', 'r:c:qa', 'r:c:prod:x', 'r::c', 'r: c', ':c']) assert.equal(parseAppliesTo(bad), null, bad);
});

test('a repo outside the known set is refused; with no set only the shape is checked', () => {
    assert.match(parse({}, { learnedIds: new Set(), repos: new Set(['other']) } as never).errors[0] ?? '', /not a known repo/);
    assert.deepEqual(parse({}, { learnedIds: new Set(), repos: new Set(['fake-repo']) } as never).errors, []);
});

test('verified-at is a sha, or a real date plus how it was checked, and nothing else', () => {
    assert.deepEqual(parse({ verifiedAt: '342b177' }).errors, []);
    for (const bad of ['2026-10-08', '2026-02-30 ran it', 'abc', 'g342b177']) assert.ok(parse({ verifiedAt: bad }).errors.length > 0, bad);
});

test('supersedes takes an existing learned id or a page path', () => {
    assert.deepEqual(parse({ supersedes: 'ab12' }).errors, []);
    assert.deepEqual(parse({ supersedes: 'Knowledge/page.md' }).errors, []);
    assert.match(parse({ supersedes: 'zz99' }).errors[0] ?? '', /not a learned row/);
    assert.match(parse({ supersedes: 'garbage' }).errors[0] ?? '', /earlier learned id or a page path/);
});

test('a secret or PHI shape in the claim, evidence or location is refused, naming the field and never the value', () => {
    const secret = ['pass', 'word=hunter2-sentinel'].join('');
    for (const field of ['claim', 'evidence', 'appliesTo'] as const) {
        const r = parse({ [field]: field === 'appliesTo' ? `fake-repo:${secret}` : `see ${secret}` });
        assert.equal(r.fields, undefined, field);
        assert.ok(r.errors.length > 0, field);
        assert.ok(r.errors.every((e) => !e.includes('hunter2-sentinel')), `${field} leaked the value`);
    }
    const phi = parse({ claim: ['The patient SSN is 123-45', '-6789.'].join('') });
    assert.equal(phi.fields, undefined);
    assert.ok(phi.errors.some((e) => /PHI \(ssn\)/.test(e)));
});

test('learnedProblems flags a stored row a hand edit made impossible, and passes a well-formed one', () => {
    const stored = GOOD_STORED;
    assert.deepEqual(learnedProblems(stored, new Set()), []);
    assert.ok(learnedProblems({ ...stored, evidence: undefined }, new Set()).length > 0);
    assert.ok(learnedProblems({ ...stored, text: ['tok', 'en=abcdef123'].join('') }, new Set()).some((p) => /looks like a secret/.test(p)));
    assert.ok(learnedProblems({ ...stored, confidence: 5 }, new Set()).length > 0);
});

test('the usage marks, repo, stream and date on the row are scanned or checked too', () => {
    const secret = ['tok', 'en=abc123secret'].join('');
    for (const extras of [{ used: secret }, { repo: secret }, { model: secret }, { stream: secret }]) {
        const r = parse({ extras });
        assert.equal(r.fields, undefined, JSON.stringify(Object.keys(extras)));
        assert.ok(r.errors.every((e) => !e.includes('abc123secret')));
    }
    assert.match(parse({ extras: { date: 'yesterday' } }).errors[0] ?? '', /--date must be a real YYYY-MM-DD/);
    assert.match(parse({ extras: { date: '2026-02-30' } }).errors[0] ?? '', /--date/);
    assert.deepEqual(parse({ extras: { date: '2026-10-08', used: 'skill:x,tool:y', model: 'Test Model' } }).errors, []);
    assert.ok(learnedProblems({ ...GOOD_STORED, used: ['tool:x', secret] }, new Set()).length > 0, 'a stored row is audited too');
});
