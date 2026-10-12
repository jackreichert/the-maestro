// Run: node --test scripts/rule-hygiene.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readEnforcedBy, repeatViolations } from './lib/rule-hygiene.ts';
import { parseOptions } from './rule-hygiene.ts';

const SCRIPT = new URL('./rule-hygiene.ts', import.meta.url).pathname;
const rule = (front: string) => ({ name: 'r', text: `---\nname: r\n${front}\n---\nbody enforced-by: hook` });

test('enforced-by is read at the top level or under metadata; the body is ignored', () => {
    assert.equal(readEnforcedBy(rule('enforced-by: hook')).enforcedBy, 'hook');
    assert.equal(readEnforcedBy(rule('metadata:\n  enforced-by: "none"')).enforcedBy, 'none');
    const s = readEnforcedBy(rule('enforced-by: script: scripts/x.ts'));
    assert.deepEqual([s.enforcedBy, s.detail], ['script', 'scripts/x.ts']);
    assert.equal(readEnforcedBy(rule('description: x')).problem, 'missing');
    assert.equal(readEnforcedBy({ name: 'r', text: 'no frontmatter enforced-by: hook' }).problem, 'missing');
});

test('an unknown value or a script with no path is invalid', () => {
    assert.equal(readEnforcedBy(rule('enforced-by: convention')).problem, 'invalid');
    assert.equal(readEnforcedBy(rule('enforced-by: script')).problem, 'invalid');
});

test('repeat violations count table rows and ignore unknown names', () => {
    const audit = ['| said | dates | captured | fix |', '|---|---|---|---|', '| a | 10-07, 10-11 | memory `alpha`, `ghost` | x |', '| b | 10-08 | `alpha` and `beta` | y |', 'prose `beta`'].join('\n');
    const r = repeatViolations(audit, new Set(['alpha', 'beta']));
    assert.deepEqual(r.map((x) => [x.rule, x.rows]), [['alpha', 2], ['beta', 1]]);
    assert.deepEqual(r[0].dates, ['10-07', '10-11', '10-08']);
});

test('parseOptions needs --memory-dir and rejects unknown flags', () => {
    assert.match(String(parseOptions([])), /memory-dir/);
    assert.match(String(parseOptions(['--memory-dir', 'd', '--x'])), /unknown/);
    assert.deepEqual(parseOptions(['--memory-dir', 'd', '--json']), { memoryDir: 'd', audit: undefined, json: true });
});

test('the CLI lists missing rules, flags a repeated unenforced rule and never writes', () => {
    const dir = mkdtempSync(join(tmpdir(), 'rh-'));
    writeFileSync(join(dir, 'MEMORY.md'), '- index');
    writeFileSync(join(dir, 'good.md'), '---\nname: good\nenforced-by: hook\n---\n');
    writeFileSync(join(dir, 'bad.md'), '---\nname: bad\n---\n');
    const audit = join(dir, 'audit.txt');
    writeFileSync(audit, '| a | 10-07 | `bad` | f |\n');
    const env = { ...process.env, HOME: mkdtempSync(join(tmpdir(), 'rh-home-')), MAESTRO_NOTIFY_COMMAND: '/usr/bin/true' };
    const run = (args: string[]) => spawnSync(process.execPath, [SCRIPT, ...args], { env, encoding: 'utf8' });
    const r = run(['--memory-dir', dir, '--audit', audit]);
    assert.equal(r.status, 1);
    assert.match(r.stdout, /2 rules, 1 tagged, ?|2 rules, 1 tagged enforced-by, 1 not/);
    assert.match(r.stdout, /MISSING {2}bad/);
    assert.match(r.stdout, /PROMOTE {2}bad/);
    writeFileSync(join(dir, 'bad.md'), '---\nname: bad\nenforced-by: check\n---\n');
    assert.equal(run(['--memory-dir', dir, '--audit', audit]).status, 0);
    assert.equal(run(['--memory-dir', join(dir, 'nope')]).status, 2);
});
