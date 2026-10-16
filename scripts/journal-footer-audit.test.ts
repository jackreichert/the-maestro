// Run: node --test scripts/journal-footer-audit.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const SCRIPT = new URL('./journal.ts', import.meta.url).pathname;
const turn = (id: string, read: number) => JSON.stringify({ type: 'assistant', timestamp: '2026-10-02T10:00:00Z', message: { id, role: 'assistant', model: 'claude-opus-5-5', usage: { input_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: read, output_tokens: 1 } } });

/** Two transcripts: this window's (older) and another window's (newer). The footer must measure the first when told which window it is. */
function world() {
    const vault = mkdtempSync(join(tmpdir(), 'footer-audit-'));
    const projects = mkdtempSync(join(tmpdir(), 'footer-audit-proj-'));
    writeFileSync(join(projects, 'aaaaaaaa-mine.jsonl'), `${turn('o1', 100000)}\n${turn('o2', 100000)}\n`);
    writeFileSync(join(projects, 'bbbbbbbb-other.jsonl'), `${turn('m1', 150000)}\n`);
    utimesSync(join(projects, 'aaaaaaaa-mine.jsonl'), new Date(Date.now() - 60000), new Date(Date.now() - 60000));
    const line = (env: Record<string, string> = {}) => spawnSync(process.execPath, [SCRIPT, 'status', '--footer', '--line', '--vault', vault, '--project', 'test-proj'], {
        encoding: 'utf8', env: { ...process.env, VAULT_ROOT: '', MAESTRO_LOCAL_CONFIG: '', MAESTRO_WINDOW: 'testwin', MAESTRO_PROJECTS_DIR: projects, CLAUDE_AUTOCOMPACT_PCT_OVERRIDE: '20', CLAUDE_CODE_AUTO_COMPACT_WINDOW: '1000000', MAESTRO_CLAUDE_SETTINGS: '/nonexistent', CLAUDE_CODE_SESSION_ID: '', ...env },
    }).stdout.trim();
    const dated = (day: string) => spawnSync(process.execPath, [SCRIPT, 'status', '--footer', '--line', '--date', day, '--vault', vault, '--project', 'test-proj'], { encoding: 'utf8', env: { ...process.env, VAULT_ROOT: '', MAESTRO_LOCAL_CONFIG: '', MAESTRO_WINDOW: 'testwin', MAESTRO_PROJECTS_DIR: projects, MAESTRO_CLAUDE_SETTINGS: '/nonexistent', CLAUDE_CODE_SESSION_ID: '' } }).stdout.trim();
    return { line, dated };
}

test('the footer measures the session Claude Code names for this window, not whichever transcript was written last', () => {
    const { line } = world();
    assert.match(line(), /Session: bbbbbbbb \(newest transcript\) · 1 turns/, 'nothing names a session: the newest transcript, and it says so');
    assert.match(line({ CLAUDE_CODE_SESSION_ID: 'aaaaaaaa-mine' }), /Session: aaaaaaaa · 2 turns · 100k\/200k/, 'the env session pins the footer to this window');
    assert.doesNotMatch(line({ CLAUDE_CODE_SESSION_ID: 'aaaaaaaa-mine' }), /newest transcript/);
});

test('a session id that names no transcript here falls back to the newest, labelled, rather than reading as unavailable', () => {
    const { line } = world();
    assert.match(line({ CLAUDE_CODE_SESSION_ID: 'zzzzzzzz-elsewhere' }), /Session: bbbbbbbb \(newest transcript\)/);
});

test('the one-line footer says its done count is today\'s', () => {
    assert.match(world().line(), /^Ledger: 0 done today · /);
});

test('a footer of another day says which day its done count is of', () => {
    const { line, dated } = world();
    assert.match(line(), /\d+ done today/);
    assert.match(dated('2026-10-01'), /0 done on 2026-10-01/);
    assert.doesNotMatch(dated('2026-10-01'), /done today/);
});

test('a bad --date is refused, and the multi-line footer labels another day too', () => {
    const { dated } = world();
    assert.equal(dated('banana'), '');
    assert.match(spawnSync(process.execPath, [SCRIPT, 'status', '--footer', '--date', '2026-10-01', '--vault', mkdtempSync(join(tmpdir(), 'fa-')), '--project', 'test-proj'], { encoding: 'utf8', env: { ...process.env, VAULT_ROOT: '', MAESTRO_LOCAL_CONFIG: '' } }).stdout, /0 done on 2026-10-01/);
});
