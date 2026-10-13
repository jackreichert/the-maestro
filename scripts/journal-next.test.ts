// Run: node --test scripts/journal-next.test.ts
// Hermetic: a temp ledger root, a temp vault, a temp HOME and a temp status dir. Never the live ledger.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const SCRIPT = new URL('./journal.ts', import.meta.url).pathname;

interface Sandbox { root: string; ledger: string; vault: string; home: string; status: string }

function sandbox(): Sandbox {
    const root = mkdtempSync(join(tmpdir(), 'journal-next-'));
    const s = { root, ledger: join(root, 'ledger'), vault: join(root, 'vault'), home: join(root, 'home'), status: join(root, 'status') };
    for (const d of [s.home, s.status, join(s.ledger, 'Projects', 'test-proj', 'Journal')]) mkdirSync(d, { recursive: true });
    writeFileSync(join(s.ledger, 'Projects', 'test-proj', 'Journal', 'ledger.jsonl'), '');
    return s;
}

function run(s: Sandbox, args: string[], input?: string): { code: number | null; out: string; err: string } {
    const r = spawnSync(process.execPath, [SCRIPT, ...args, '--vault', s.ledger, '--project', 'test-proj'], {
        encoding: 'utf8', cwd: s.root, timeout: 20_000, input,
        env: {
            ...process.env, HOME: s.home, VAULT_ROOT: s.vault, LEDGER_ROOT: '', MAESTRO_LOCAL_CONFIG: '', MAESTRO_STATUS_DIR: s.status,
            MAESTRO_CONTAINER_ROOT: '', MAESTRO_UPDATE_CHECK: 'off', MAESTRO_EVENT_DIR: join(s.root, 'Events'), MAESTRO_NOTIFY_COMMAND: '/usr/bin/true',
        },
    });
    return { code: r.status, out: r.stdout, err: r.stderr };
}

const search = { issues: [{ key: 'ZZ-7', fields: { summary: 'Mend the Bywater fence', status: { name: 'To Do' }, priority: { name: 'High' }, labels: [] } }, { key: 'bad' }] };

test('tracker-import reads standard input, writes the snapshot, and names what it skipped', () => {
    const s = sandbox();
    const r = run(s, ['tracker-import', '-'], JSON.stringify(search));
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /^wrote {2}1 item\(s\)/);
    assert.match(r.out, /skipped {2}#2: key "bad" is not a tracker key/);
    const snap = JSON.parse(readFileSync(join(s.status, 'tracker-items.json'), 'utf8')) as { source: string; items: { key: string }[] };
    assert.deepEqual([snap.source, snap.items.map((i) => i.key)], ['jira', ['ZZ-7']]);
});

test('tracker-import refuses unreadable input and a bad shape, and --dry-run writes nothing', () => {
    const s = sandbox();
    assert.match(run(s, ['tracker-import', '-'], 'not json').err, /is not readable JSON/);
    assert.match(run(s, ['tracker-import', '-'], '{"total":1}').err, /expected an array of issues/);
    const file = join(s.root, 'in.json');
    writeFileSync(file, JSON.stringify(search));
    const r = run(s, ['tracker-import', file, '--dry-run']);
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /^would write {2}1 item\(s\)/);
    assert.equal(existsSync(join(s.status, 'tracker-items.json')), false);
});
