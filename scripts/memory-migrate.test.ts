// Run: node --test scripts/memory-migrate.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { parseOptions } from './memory-migrate.ts';

const SCRIPT = new URL('./memory-migrate.ts', import.meta.url).pathname;
const mem = (name: string, type: string, d: string) => `---\nname: ${name}\ndescription: "${d}"\nmetadata:\n  type: ${type}\n---\nORIGINAL BODY\n`;

function setup(): { mem: string; vault: string; approved: string } {
    const root = mkdtempSync(join(tmpdir(), 'memmig-'));
    const m = join(root, 'memory');
    mkdirSync(m);
    writeFileSync(join(m, 'MEMORY.md'), '- index\n');
    for (const n of ['has-page', 'no-page', 'unapproved']) writeFileSync(join(m, `${n}.md`), mem(n, 'project', 'the maestro has a fact'));
    writeFileSync(join(m, 'tone.md'), mem('tone', 'feedback', 'be kind'));
    const vault = join(root, 'vault');
    for (const n of ['has-page', 'unapproved']) {
        const p = join(vault, 'Projects/the-maestro/Knowledge', `${n}.md`);
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, '---\ntype: library\nverified-at: 2026-10-11@abc1234\n---\nFact.\n');
    }
    const approved = join(root, 'approved.txt');
    writeFileSync(approved, 'has-page\nno-page\n');
    return { mem: m, vault, approved };
}
const run = (...a: string[]) => spawnSync(process.execPath, [SCRIPT, ...a], { encoding: 'utf8' });

test('--apply without --approved is refused', () => {
    assert.match(String(parseOptions(['--memory-dir', 'm', '--vault', 'v', '--apply'])), /--apply needs --approved/);
});

test('the default run is a dry run that changes nothing', () => {
    const s = setup();
    const before = readFileSync(join(s.mem, 'has-page.md'), 'utf8');
    const r = run('--memory-dir', s.mem, '--vault', s.vault, '--approved', s.approved);
    assert.equal(r.status, 0);
    assert.match(r.stdout, /point +has-page/);
    assert.match(r.stdout, /wait-for-page +no-page/);
    assert.match(r.stdout, /wait-for-approval +unapproved/);
    assert.ok(!r.stdout.includes('tone'));
    assert.match(r.stdout, /Dry run/);
    assert.equal(readFileSync(join(s.mem, 'has-page.md'), 'utf8'), before);
});

test('--apply points only the approved file whose page is verified', () => {
    const s = setup();
    const r = run('--memory-dir', s.mem, '--vault', s.vault, '--approved', s.approved, '--apply');
    assert.equal(r.status, 0);
    assert.match(r.stdout, /1 memory files replaced/);
    const pointed = readFileSync(join(s.mem, 'has-page.md'), 'utf8');
    assert.match(pointed, /^---\nname: has-page/);
    assert.match(pointed, /Moved to the library: \[\[Projects\/the-maestro\/Knowledge\/has-page\]\]\n$/);
    assert.ok(!pointed.includes('ORIGINAL BODY'));
    for (const n of ['no-page', 'unapproved', 'tone']) assert.match(readFileSync(join(s.mem, `${n}.md`), 'utf8'), /ORIGINAL BODY/);
    assert.equal(run('--memory-dir', s.mem, '--vault', s.vault, '--approved', s.approved, '--apply').status, 0);
});

test('a missing path exits 2', () => {
    assert.equal(run('--memory-dir', '/nonexistent-x', '--vault', '/nonexistent-y').status, 2);
});

test('--hints maps a memory file to the project the hint names', () => {
    const s = setup();
    writeFileSync(join(s.mem, 'gizmo.md'), mem('gizmo', 'project', 'the gizmo has a fact'));
    const hints = join(s.mem, '..', 'hints.json');
    writeFileSync(hints, JSON.stringify([['gizmo', 'gizmo-api']]));
    const r = run('--memory-dir', s.mem, '--vault', s.vault, '--hints', hints);
    assert.equal(r.status, 0);
    assert.match(r.stdout, /gizmo +-> +Projects\/gizmo-api\/Knowledge\/gizmo\.md/);
});
