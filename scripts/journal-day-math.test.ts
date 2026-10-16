// Run: node --test scripts/journal-day-math.test.ts
// MAESTRO-184: every day calculation uses one basis. Ages count from the UTC stamp rows carry to the UTC day; a date the user types
// (`defer --until`) is read in the user's zone. Each case pins the clock across UTC midnight, in New York and in Tokyo.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const SCRIPT = new URL('./journal.ts', import.meta.url).pathname;
const PROJECT = 'test-proj';
const MARK = ['--model', 'claude-sonnet-5-5', '--used', 'tool:test'];

/** A temp ledger holding one in-flight row stamped `date` that nothing has touched since. */
function fixture(date: string): string {
    const vault = join(mkdtempSync(join(tmpdir(), 'dm-')), 'vault');
    mkdirSync(join(vault, 'Projects', PROJECT, 'Journal'), { recursive: true });
    const row = { id: 'aaaa', ts: `${date}T10:00:00Z`, date, kind: 'wip', stream: 's', text: 'untouched work' };
    writeFileSync(join(vault, 'Projects', PROJECT, 'Journal', 'ledger.jsonl'), `${JSON.stringify(row)}\n`);
    return vault;
}

/** Runs journal.ts with the clock pinned to `now` and the user's zone set to `tz`. */
function journal(vault: string, now: string, tz: string, ...args: string[]): { out: string; code: number } {
    const r = spawnSync(process.execPath, [SCRIPT, ...args, '--vault', vault, '--project', PROJECT], {
        encoding: 'utf8',
        env: { ...process.env, TZ: tz, MAESTRO_WATCH_TZ: tz, MAESTRO_NOW: now, VAULT_ROOT: '', MAESTRO_LOCAL_CONFIG: '', MAESTRO_UPDATE_CHECK: 'off', MAESTRO_EVENT_DIR: join(vault, 'Events') },
    });
    return { out: r.stdout + r.stderr, code: r.status ?? -1 };
}

const staleIds = (vault: string, now: string, tz: string): string[] => {
    const j = JSON.parse(journal(vault, now, tz, 'status', '--json').out) as { stale?: { id: string }[] };
    return (j.stale ?? []).map((i) => i.id);
};

// Three UTC days after the row's stamp, from UTC midnight on. The local day is still the 11th in New York until 04:00Z.
for (const [label, now, tz] of [
    ['New York, after UTC midnight and before local midnight', '2026-10-12T00:18:00Z', 'America/New_York'],
    ['New York, after both midnights', '2026-10-12T05:30:00Z', 'America/New_York'],
    ['Tokyo, after UTC midnight', '2026-10-12T00:18:00Z', 'Asia/Tokyo'],
] as const) {
    test(`a row untouched since 2026-10-09 is stale 3 days later in the footer count and status --json (${label})`, () => {
        const vault = fixture('2026-10-09');
        assert.deepEqual(staleIds(vault, now, tz), ['aaaa']);
        assert.match(journal(vault, now, tz, 'status', '--footer').out, /1 stale/);
    });
}

test('the stale count does not tip early: before UTC midnight the same row is 2 days old', () => {
    const vault = fixture('2026-10-09');
    assert.deepEqual(staleIds(vault, '2026-10-11T23:30:00Z', 'America/New_York'), []);
});

test('defer --until accepts tomorrow in the user\'s zone at 8:18 pm New York time, when the UTC day has already turned', () => {
    const vault = fixture('2026-10-11');
    const now = '2026-10-12T00:18:00Z';
    const today = journal(vault, now, 'America/New_York', 'defer', 'aaaa', '--until', '2026-10-11');
    assert.equal(today.code, 1, 'the user\'s today is not in the future');
    assert.match(today.out, /today is 2026-10-11/);
    const tomorrow = journal(vault, now, 'America/New_York', 'defer', 'aaaa', '--until', '2026-10-12', ...MARK);
    assert.equal(tomorrow.code, 0, tomorrow.out);
    assert.doesNotMatch(journal(vault, now, 'America/New_York', 'status', '--json').out, /"id": ?"aaaa"/, 'hidden for the rest of the user\'s day');
    assert.match(journal(vault, '2026-10-12T05:00:00Z', 'America/New_York', 'status', '--json').out, /"id": ?"aaaa"/, 'back at local midnight');
});

test('defer --until refuses a date that is already today in Tokyo although UTC has not reached it', () => {
    const vault = fixture('2026-10-11');
    const r = journal(vault, '2026-10-11T23:30:00Z', 'Asia/Tokyo', 'defer', 'aaaa', '--until', '2026-10-12');
    assert.equal(r.code, 1);
    assert.match(r.out, /today is 2026-10-12/);
});
