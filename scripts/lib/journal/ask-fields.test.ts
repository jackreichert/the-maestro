// Run: node --test scripts/lib/journal/ask-fields.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseAskFields, normaliseBy, askDoor, autoDefault, askBits, askSummary, askFieldProblems, askClass, hasAskFields } from './ask-fields.ts';
import type { RawAskFlags, RawFlag } from './ask-fields.ts';

const NOW = new Date('2026-10-07T12:00:00Z');
const none: RawFlag = { given: false, value: null };
const flags = (over: Partial<Record<keyof RawAskFlags, string | null>> = {}): RawAskFlags => {
    const f: RawAskFlags = { recommend: none, default: none, door: none, 'decide-by': none, class: none };
    for (const [k, v] of Object.entries(over)) f[k as keyof RawAskFlags] = { given: true, value: v ?? null };
    return f;
};
const parse = (over: Partial<Record<keyof RawAskFlags, string | null>> = {}, paste = false) => parseAskFields(flags(over), { paste, now: NOW });

test('a bare ask parses to the standard class, warns about the recommendation and the door, and refuses nothing', () => {
    const r = parse();
    assert.deepEqual(r.fields, { class: 'standard' });
    assert.deepEqual(r.errors, []);
    assert.equal(r.warnings.length, 2);
    assert.match(r.warnings[0], /--recommend/);
    assert.match(r.warnings[1], /--door/);
});

test('a complete two-way ask stores every field and warns about nothing', () => {
    const r = parse({ recommend: '  Yes,  use the window ', default: 'apply it', door: 'two-way', 'decide-by': '2026-10-09', class: 'fixed-date' });
    assert.deepEqual(r.fields, { recommend: 'Yes, use the window', default: 'apply it', door: 'two-way', by: '2026-10-09', class: 'fixed-date' });
    assert.deepEqual([r.errors, r.warnings], [[], []]);
});

test('a one-way ask with a default is refused, and so is a default with no door', () => {
    const oneWay = parse({ door: 'one-way', default: 'merge it', recommend: 'r' });
    assert.equal(oneWay.errors.length, 1);
    assert.match(oneWay.errors[0], /one-way ask can never carry a default/);
    const noDoor = parse({ default: 'merge it', recommend: 'r' });
    assert.equal(noDoor.errors.length, 1);
    assert.match(noDoor.errors[0], /needs --door two-way/);
});

test('every refusal is reported, not only the first', () => {
    const r = parse({ door: 'sideways', class: 'urgent', 'decide-by': 'someday', recommend: '' });
    assert.equal(r.errors.length, 4);
});

test('a flag given with no value is refused rather than ignored', () => {
    for (const f of ['recommend', 'default', 'door', 'decide-by', 'class'] as const) assert.ok(parse({ [f]: null, door: f === 'default' ? 'two-way' : undefined }).errors.length >= 1, f);
});

test('text over the cap is refused', () => {
    assert.match(parse({ recommend: 'x'.repeat(301) }).errors[0], /over 300/);
    assert.deepEqual(parse({ recommend: 'x'.repeat(300) }).errors, []);
});

test('a paste ask takes none of the fields, and gets no warnings', () => {
    const bare = parse({}, true);
    assert.deepEqual([bare.fields, bare.errors, bare.warnings], [{}, [], []]);
    assert.match(parse({ recommend: 'r' }, true).errors[0], /run-this block/);
});

test('decide-by: dates, instants and relative values normalise; past and malformed values are refused', () => {
    assert.equal(normaliseBy('2026-10-09', NOW), '2026-10-09');
    assert.equal(normaliseBy('2d', NOW), '2026-10-09');
    assert.equal(normaliseBy('1w', NOW), '2026-10-14');
    assert.equal(normaliseBy('6h', NOW), '2026-10-07T18:00:00.000Z');
    assert.equal(normaliseBy('2026-10-09T10:00:00-04:00', NOW), '2026-10-09T14:00:00.000Z');
    for (const bad of ['2026-02-30', '2026-13-01', 'tomorrow', '2x', '-1d', '2026-10-09T10:00', '99999999999999999999d', '']) assert.equal(normaliseBy(bad, NOW), null, bad);
    assert.deepEqual(parse({ 'decide-by': '2026-10-07' }).errors, [], 'today is not past');
    assert.match(parse({ 'decide-by': '2026-10-06' }).errors[0], /already past/);
    assert.match(parse({ 'decide-by': '2026-10-07T11:59:00Z' }).errors[0], /already past/);
    assert.match(parse({ 'decide-by': 'someday' }).errors[0], /must be an ISO date/);
});

test('reading a row: a missing, misspelt or hand-edited door is one-way and never yields an auto default', () => {
    assert.equal(askDoor({}), 'one-way');
    assert.equal(askDoor({ door: 'Two-Way' }), 'one-way');
    assert.equal(askDoor({ door: 'two-way' }), 'two-way');
    assert.equal(autoDefault({ door: 'one-way', default: 'merge it' }), null);
    assert.equal(autoDefault({ default: 'merge it' }), null);
    assert.equal(autoDefault({ door: 'two-way', default: '   ' }), null);
    assert.equal(autoDefault({ door: 'two-way', default: 7 }), null);
    assert.equal(autoDefault({ door: 'two-way', default: ' apply ' }), 'apply');
});

test('a legacy row has no fields, no bits and the standard class', () => {
    const legacy = { kind: 'question', text: 'which way?' };
    assert.equal(hasAskFields(legacy), false);
    assert.deepEqual(askBits(legacy), []);
    assert.equal(askClass(legacy), 'standard');
    assert.deepEqual(askFieldProblems(legacy), []);
    assert.deepEqual(askSummary([legacy, legacy]), { oneWay: 0 });
});

test('askBits is compact and ordered, names no default for a one-way ask, and clips long text', () => {
    assert.deepEqual(askBits({ door: 'two-way', by: '2026-10-09', class: 'expedite', recommend: 'Yes', default: 'apply it' }), ['two-way', 'by 2026-10-09', 'expedite', 'rec: Yes', 'if silent: apply it']);
    assert.deepEqual(askBits({ door: 'one-way', default: 'sneaky', class: 'standard' }), ['one-way']);
    assert.deepEqual(askBits({ class: 'standard' }), [], 'the class every new ask carries does not make it field-bearing');
    assert.deepEqual(askBits({ class: 'intangible' }), ['door not set: one-way', 'intangible']);
    assert.deepEqual(askBits({ door: 'two-way', by: '2026-10-09T14:00:00.000Z' }), ['two-way', 'by 2026-10-09 14:00Z']);
    const long = askBits({ recommend: 'a'.repeat(200) }, 20);
    assert.equal(long[1].length, 'rec: '.length + 20);
});

test('askSummary counts one-way asks among those with fields and finds the soonest decide-by', () => {
    const rows = [{ door: 'one-way', by: '2026-10-12' }, { door: 'two-way', by: '2026-10-09' }, { recommend: 'wait' }, { class: 'standard' }, { kind: 'question' }];
    assert.deepEqual(askSummary(rows), { oneWay: 2, nextBy: '2026-10-09' });
});

test('askFieldProblems flags hand edits the write path would have refused', () => {
    assert.equal(askFieldProblems({ door: 'one-way', default: 'x' }).length, 1);
    assert.equal(askFieldProblems({ default: 'x' }).length, 1);
    assert.equal(askFieldProblems({ door: 'maybe', class: 'urgent', by: 'soon' }).length, 3);
    assert.deepEqual(askFieldProblems({ door: 'two-way', default: 'x', by: '2026-10-09', class: 'intangible' }), []);
});
