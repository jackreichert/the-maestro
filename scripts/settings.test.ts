// Run: node --test scripts/settings.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { findSettingCopies, settingsLines } from './lib/settings.ts';
import type { ResolvedSetting } from './local-config.ts';

const JOURNAL = new URL('./journal.ts', import.meta.url).pathname;
const S = (key: string, value: string, source: string, envName = `MAESTRO_${key.toUpperCase()}`): ResolvedSetting => ({ key, envName, value, source });
const LIST = [S('lease_ttl_minutes', '45', '/cfg.md'), S('notify_command', 'say hi', 'env MAESTRO_NOTIFY_COMMAND'), S('auto_pull', '', 'default')];

test('settingsLines shows value and source, hides command values and unset settings unless asked', () => {
    const lines = settingsLines(LIST);
    assert.equal(lines.length, 2);
    assert.match(lines[0] ?? '', /^lease_ttl_minutes\s+45\s+\/cfg\.md$/);
    assert.match(lines[1] ?? '', /notify_command\s+\(set\)\s+env MAESTRO_NOTIFY_COMMAND/);
    assert.ok(!lines.join('\n').includes('say hi'));
    assert.match(settingsLines(LIST, true).join('\n'), /auto_pull\s+\(unset\)\s+default/);
});

test('findSettingCopies flags a literal value by key or env name, and ignores prose and a maestro-config fence', () => {
    const text = [
        'lease_ttl_minutes: 45',
        'Set `MAESTRO_LEASE_TTL_MINUTES=90` in the shell.',
        'lease_ttl_minutes: see the user config file',
        'The auto_pull = on setting.',
        '```maestro-config',
        'lease_ttl_minutes: 60',
        '```',
        'unrelated_key: 5',
    ].join('\n');
    const found = findSettingCopies('note.md', text, LIST).map((c) => `${c.line}:${c.name}=${c.value}`);
    assert.deepEqual(found, ['1:lease_ttl_minutes=45', '2:MAESTRO_LEASE_TTL_MINUTES=90', '4:auto_pull=on']);
});

/** Runs `journal.ts settings` with a throwaway HOME and the given user config text. */
function run(config: string, ...args: string[]) {
    const home = mkdtempSync(join(tmpdir(), 'st-home-'));
    const file = join(home, 'config.md');
    writeFileSync(file, config);
    const r = spawnSync(process.execPath, [JOURNAL, 'settings', ...args], { encoding: 'utf8', cwd: home, env: { PATH: process.env.PATH ?? '', HOME: home, MAESTRO_LOCAL_CONFIG: file, MAESTRO_UPDATE_CHECK: 'off' } });
    return { home, file, code: r.status, out: r.stdout, err: r.stderr };
}

test('journal.ts settings prints each configured setting with the file it came from', () => {
    const r = run('```maestro-config\nlease_ttl_minutes: 45\n```\n');
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, new RegExp(`lease_ttl_minutes\\s+45\\s+${r.file.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
});

test('journal.ts settings --check exits 1 on a copy in a note and 0 once it links instead; the config file is not flagged', () => {
    const r = run('```maestro-config\nlease_ttl_minutes: 45\n```\n');
    const notes = join(r.home, 'notes');
    mkdirSync(notes);
    writeFileSync(join(notes, 'CONTEXT.md'), 'Leases last lease_ttl_minutes: 45.\n');
    const bad = spawnSync(process.execPath, [JOURNAL, 'settings', '--check', notes, r.file], { encoding: 'utf8', env: { PATH: process.env.PATH ?? '', HOME: r.home, MAESTRO_LOCAL_CONFIG: r.file } });
    assert.equal(bad.status, 1, bad.stdout + bad.stderr);
    assert.match(bad.stdout, /CONTEXT\.md:1: lease_ttl_minutes is given the value 45/);
    assert.ok(!bad.stdout.includes('config.md'));
    writeFileSync(join(notes, 'CONTEXT.md'), 'Lease length is set in the user config file.\n');
    const good = spawnSync(process.execPath, [JOURNAL, 'settings', '--check', notes], { encoding: 'utf8', env: { PATH: process.env.PATH ?? '', HOME: r.home, MAESTRO_LOCAL_CONFIG: r.file } });
    assert.equal(good.status, 0, good.stdout + good.stderr);
});

test('journal.ts settings --check with nothing to read exits 2', () => {
    const r = run('', '--check');
    assert.equal(r.code, 2);
});
