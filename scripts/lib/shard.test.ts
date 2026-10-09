// Run: node --test scripts/lib/shard.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { setShard } from './shard.ts';

const SCRIPTS = new URL('..', import.meta.url).pathname;
const files = readdirSync(SCRIPTS);

test('setShard refuses a shard outside 1..of, so a typo cannot silently drop tests', () => {
    for (const [n, of] of [[0, 3], [4, 3], [1.5, 3], [1, 0]]) assert.throws(() => setShard(n, of), /bad shard/);
    setShard(1, 1);   // leave the default: every test registers
});

test('every *.cases.ts has shard files 1..N for one N, each importing it, so no case is left unrun', () => {
    const cases = files.filter((f) => f.endsWith('.cases.ts')).map((f) => f.slice(0, -'.cases.ts'.length));
    assert.ok(cases.length > 0, 'no cases files found');
    for (const name of cases) {
        const shards = files.filter((f) => f.startsWith(`${name}.shard-`) && f.endsWith('.test.ts'));
        const calls = shards.map((f) => {
            const text = readFileSync(`${SCRIPTS}${f}`, 'utf8');
            const m = /^setShard\((\d+), (\d+)\);$/m.exec(text);
            assert.ok(m, `${f} has no setShard(n, of) call`);
            assert.ok(text.includes(`await import('./${name}.cases.ts');`), `${f} does not import ${name}.cases.ts`);
            assert.equal(f, `${name}.shard-${m[1]}.test.ts`, `${f} names a different shard than it runs`);
            return { n: Number(m[1]), of: Number(m[2]) };
        });
        const of = calls[0]?.of;
        assert.ok(of && of >= 1, `${name}: no shard files`);
        assert.ok(calls.every((c) => c.of === of), `${name}: shards disagree on the total`);
        assert.deepEqual(calls.map((c) => c.n).sort((a, b) => a - b), Array.from({ length: of }, (_, i) => i + 1), `${name}: shards must be exactly 1..${of}`);
    }
});
