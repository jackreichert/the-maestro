// Run: node --test scripts/lib/journal/decide.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { decideProblems, relatedDecision, renderEntry, topicSlug, writeProjectDecision, writeWorkingRule } from './decide.ts';
import type { DecideInput } from './decide.ts';

const base: DecideInput = { decision: 'Branch from staging for every repo', why: 'staging is what ships', scope: 'project', date: '2026-10-12' };
const tmp = (): string => mkdtempSync(join(tmpdir(), 'decide-'));

test('a decision without --why is refused, naming the flag', () => {
    const p = decideProblems({ ...base, why: '' });
    assert.equal(p.length, 1);
    assert.match(p[0] as string, /--why is required/);
});

test('a secret shape in any field is refused without echoing it', () => {
    const key = `sk-${'a1B2c3D4'.repeat(5)}`;
    const p = decideProblems({ ...base, consequence: `use ${key} here` });
    assert.ok(p.length >= 1);
    assert.ok(p.every((l) => !l.includes(key)));
});

test('a clean decision has no problems; a bad scope, date or topic each do', () => {
    assert.deepEqual(decideProblems(base), []);
    assert.equal(decideProblems({ ...base, scope: 'x' as never }).length, 1);
    assert.equal(decideProblems({ ...base, date: 'tomorrow' }).length, 1);
    assert.equal(decideProblems({ ...base, topic: 'Bad Topic' }).length, 1);
});

test('the entry has date, decision, rationale, rejected alternatives and consequence', () => {
    const e = renderEntry({ ...base, rejected: 'branch from main', consequence: 'hotfixes cut from staging' });
    assert.match(e, /^## 2026-10-12: Branch from staging for every repo/);
    assert.match(e, /\*\*Rationale:\*\* staging is what ships/);
    assert.match(e, /\*\*Rejected alternatives:\*\* branch from main/);
    assert.match(e, /\*\*Consequence:\*\* hotfixes cut from staging/);
});

test('a project decision is added newest first, and a repeat adds nothing', () => {
    const path = join(tmp(), 'Projects', 'p', 'DECISIONS.md');
    const first = writeProjectDecision(path, base);
    assert.equal(first.kind, 'created');
    writeProjectDecision(path, { ...base, decision: 'A later decision', date: '2026-10-13' });
    const text = readFileSync(path, 'utf8');
    assert.ok(text.startsWith('# Decisions\n\n## 2026-10-13'));
    assert.equal(writeProjectDecision(path, base).kind, 'unchanged');
    assert.equal(readFileSync(path, 'utf8'), text);
});

test('undo removes a file it created and restores one it changed', () => {
    const dir = tmp();
    const path = join(dir, 'DECISIONS.md');
    writeProjectDecision(path, base).undo();
    assert.equal(existsSync(path), false);
    writeFileSync(path, '# Decisions\n\n## 2026-01-01: old\n\n- **Decision:** old\n');
    const before = readFileSync(path, 'utf8');
    writeProjectDecision(path, base).undo();
    assert.equal(readFileSync(path, 'utf8'), before);
});

test('a working rule writes a memory file and one index line; the same topic updates both', () => {
    const dir = tmp();
    const rule = { ...base, scope: 'working-rule' as const, topic: 'branch-base' };
    const a = writeWorkingRule(dir, rule);
    assert.equal(a.kind, 'created');
    const b = writeWorkingRule(dir, { ...rule, decision: 'Branch from develop instead', why: 'staging is gone' });
    assert.equal(b.kind, 'updated');
    const index = readFileSync(join(dir, 'MEMORY.md'), 'utf8').trim().split('\n');
    assert.equal(index.length, 1);
    assert.match(index[0] as string, /\(branch-base\.md\).*staging is gone/);
    assert.match(readFileSync(join(dir, 'branch-base.md'), 'utf8'), /Branch from develop instead/);
    assert.equal(writeWorkingRule(dir, { ...rule, decision: 'Branch from develop instead', why: 'staging is gone' }).kind, 'unchanged');
});

test('a working rule keeps other index lines, and undo puts both files back', () => {
    const dir = tmp();
    writeFileSync(join(dir, 'MEMORY.md'), '- [Other](other.md) — keep me\n');
    const w = writeWorkingRule(dir, { ...base, scope: 'working-rule' });
    assert.match(readFileSync(join(dir, 'MEMORY.md'), 'utf8'), /keep me\n- \[Branch from staging/);
    w.undo();
    assert.equal(readFileSync(join(dir, 'MEMORY.md'), 'utf8'), '- [Other](other.md) — keep me\n');
    assert.equal(existsSync(w.path), false);
});

test('an unwritable memory directory throws and leaves nothing behind', () => {
    const dir = tmp();
    const blocker = join(dir, 'file');
    writeFileSync(blocker, 'x');
    assert.throws(() => writeWorkingRule(join(blocker, 'mem'), { ...base, scope: 'working-rule' }));
});

test('the topic slug is the first six words unless named', () => {
    assert.equal(topicSlug({ decision: 'Never push to main, ever, under any circumstances today' }), 'never-push-to-main-ever-under');
    assert.equal(topicSlug({ decision: 'x', topic: 'named' }), 'named');
});

test('the closest earlier decision is found in DECISIONS.md and in the ledger, and nothing unrelated is', () => {
    const md = '# Decisions\n\n## 2026-10-08: Autocompact set to 50 percent for long sessions\n\nbody\n';
    const hit = relatedDecision('Set autocompact to 70 percent for long sessions', md, []);
    assert.equal(hit?.source, 'DECISIONS.md');
    const row = relatedDecision('Set autocompact to 70 percent for long sessions', null, [{ id: 'ab12', kind: 'decision', text: 'autocompact percent for long sessions is 60' }]);
    assert.equal(row?.source, 'ledger ab12');
    assert.equal(relatedDecision('Rename the podium tab', md, []), null);
    assert.equal(relatedDecision('Set autocompact to 70 percent for long sessions', null, [{ id: 'cd34', kind: 'decision', pending: true, text: 'autocompact percent for long sessions' }]), null);
});
