// Run: node --test scripts/merge-sweep.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { stubEnv, writeStub } from './lib/stub-bin.ts';

const SCRIPT = new URL('./merge-sweep.ts', import.meta.url).pathname;
const PLAYBOOK = new URL('../playbooks/merge-sweep.md', import.meta.url);
const TODAY = '2026-10-12';

function ledgerWith(rows: object[]): { vault: string; ledger: string } {
    const vault = mkdtempSync(join(tmpdir(), 'ms-'));
    mkdirSync(join(vault, 'Projects', 'demo', 'Journal'), { recursive: true });
    const ledger = join(vault, 'Projects', 'demo', 'Journal', 'ledger.jsonl');
    writeFileSync(ledger, rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
    return { vault, ledger };
}

const base = (id: string, extra: object): object => ({ id, ts: '2026-10-01T10:00:00Z', date: '2026-10-01', ...extra });

/** A fake gh. Only acme/widget is readable. `fail` exits 1, `empty` prints nothing, `garbage` is not JSON. */
function fakeGh(views: Record<string, object | 'fail' | 'empty' | 'garbage'>): { env: Record<string, string>; log: string } {
    const dir = mkdtempSync(join(tmpdir(), 'ms-gh-'));
    const log = join(dir, 'calls.log');
    const body = `#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(process.env.GH_CALL_LOG, args.join(' ') + '\\n');
const [cmd, view, num, repoFlag, repo, jsonFlag] = args;
if (cmd !== 'pr' || view !== 'view' || repoFlag !== '--repo' || repo !== 'acme/widget' || jsonFlag !== '--json') {
  console.error('bad args');
  process.exit(1);
}
const views = ${JSON.stringify(views)};
const hit = views[num];
if (!hit) { console.error('unexpected ' + num); process.exit(1); }
if (hit === 'fail') process.exit(1);
if (hit === 'empty') process.exit(0);
if (hit === 'garbage') { console.log('not json'); process.exit(0); }
console.log(JSON.stringify(hit));
`;
    return { env: { ...stubEnv('MAESTRO_GH_BIN', writeStub(join(dir, 'gh.js'), body)), GH_CALL_LOG: log }, log };
}

function run(vault: string, args: string[], gh: ReturnType<typeof fakeGh>): { status: number | null; stdout: string; stderr: string; log: string } {
    const r = spawnSync(process.execPath, [SCRIPT, '--vault', vault, '--project', 'demo', '--today', TODAY, ...args], {
        encoding: 'utf8',
        env: { ...process.env, MAESTRO_LOCAL_CONFIG: '', LEDGER_ROOT: '', VAULT_ROOT: '', MAESTRO_OVERLAY: '', MAESTRO_GH_ORG: '', ...gh.env },
    });
    return { status: r.status, stdout: r.stdout, stderr: r.stderr, log: existsSync(gh.log) ? readFileSync(gh.log, 'utf8') : '' };
}

const VIEWS = {
    12: { state: 'MERGED', updatedAt: '2026-10-01T00:00:00Z' },
    9: { state: 'OPEN', updatedAt: '2026-09-01T00:00:00Z' },
    8: { state: 'OPEN', updatedAt: '2026-10-11T00:00:00Z' },
    7: { state: 'CLOSED', updatedAt: '2026-09-01T00:00:00Z' },
    6: { state: 'OPEN', updatedAt: '2026-10-05T00:00:00Z' },
    5: { state: 'OPEN', updatedAt: '2026-10-06T00:00:00Z' },
    3: 'fail' as const,
    2: 'empty' as const,
    1: 'garbage' as const,
    4: { state: 'WEIRD', updatedAt: '2026-09-01T00:00:00Z' },
};

test('lists merged and stale rows, prints the done command, and does not write the ledger', () => {
    const { vault, ledger } = ledgerWith([
        base('aaaa', { kind: 'wip', text: 'follow-ups for acme/widget#12' }),
        base('bbbb', { kind: 'blocked', gate: 'gh:pr:acme/widget#9', text: 'wait on the widget PR' }),
        base('cccc', { kind: 'wip', queued: true, text: 'recent acme/widget#8' }),
        base('dddd', { kind: 'question', refs: ['acme/widget#7'], text: 'closed unmerged' }),
        base('eeee', { kind: 'wip', text: 'no pr named' }),
    ]);
    const before = readFileSync(ledger, 'utf8');
    const r = run(vault, [], fakeGh(VIEWS));
    assert.equal(r.status, 1, r.stderr);
    assert.match(r.stdout, /Merged open rows \(1\); nothing was closed:/);
    assert.match(r.stdout, /aaaa {2}follow-ups for acme\/widget#12/);
    assert.match(r.stdout, /acme\/widget#12 MERGED/);
    assert.match(r.stdout, /close if you agree: journal\.ts done aaaa/);
    assert.match(r.stdout, /Stale open PRs, no activity in 7 days \(1\); nothing was closed:/);
    assert.match(r.stdout, /bbbb {2}wait on the widget PR/);
    assert.match(r.stdout, /acme\/widget#9 OPEN last activity 2026-09-01 \(41d\)/);
    assert.match(r.stdout, /Closed without merging \(1\); nothing was closed:/);
    assert.match(r.stdout, /dddd {2}closed unmerged/);
    assert.equal(r.stdout.includes('cccc'), false, 'a recently active open PR is not listed');
    assert.equal(r.stdout.includes('eeee'), false, 'a row with no PR is not listed');
    assert.equal((r.stdout.match(/journal\.ts done/g) ?? []).length, 1, 'the done command is printed once and only for the merged row');
    assert.equal(r.stdout.includes('journal.ts done bbbb'), false);
    assert.equal(readFileSync(ledger, 'utf8'), before, 'the ledger is untouched');
    assert.match(r.log, /acme\/widget/);
    assert.equal(r.log.includes('journal'), false, 'gh is not asked to run journal');
});

test('a PR gh cannot read is unknown, not merged, and a bare repo name is not sent to gh', () => {
    const { vault, ledger } = ledgerWith([
        base('aa11', { kind: 'blocked', gate: 'gh:pr:acme/widget#3', text: 'unreadable' }),
        base('bb22', { kind: 'wip', text: 'empty acme/widget#2' }),
        base('cc33', { kind: 'wip', text: 'garbage acme/widget#1' }),
        base('dd44', { kind: 'wip', text: 'weird acme/widget#4' }),
        base('ee55', { kind: 'blocked', gate: 'gh:pr:widget#12', text: 'no owner' }),
    ]);
    const before = readFileSync(ledger, 'utf8');
    const r = run(vault, [], fakeGh(VIEWS));
    assert.equal(r.status, 3, r.stderr);
    assert.match(r.stdout, /Unknown, not merged \(5\); nothing was closed:/);
    assert.match(r.stdout, /acme\/widget#3 UNKNOWN \(unreadable\)/);
    assert.match(r.stdout, /acme\/widget#2 UNKNOWN \(unreadable\)/);
    assert.match(r.stdout, /acme\/widget#1 UNKNOWN \(unreadable\)/);
    assert.match(r.stdout, /acme\/widget#4 UNKNOWN \(unreadable\)/);
    assert.match(r.stdout, /widget#12 UNKNOWN \(no owner\)/);
    assert.equal(r.stdout.includes('MERGED'), false, 'none of these is merged');
    assert.equal(r.stdout.includes('journal.ts done'), false);
    assert.equal(/--repo widget( |$)/m.test(r.log), false, 'a bare repo is not sent to gh');
    assert.equal(readFileSync(ledger, 'utf8'), before);
});

test('a merged PR beside one gh cannot read is not all-merged, and the note says so', () => {
    const { vault } = ledgerWith([
        base('ff66', { kind: 'wip', text: 'acme/widget#12 and acme/widget#3' }),
    ]);
    const r = run(vault, [], fakeGh(VIEWS));
    assert.equal(r.status, 1, r.stderr);
    assert.match(r.stdout, /Merged open rows \(1\)/);
    assert.match(r.stdout, /acme\/widget#12 MERGED, acme\/widget#3 UNKNOWN \(unreadable\)/);
    assert.match(r.stdout, /other PRs on this row are not merged/);
    assert.match(r.stdout, /close if you agree: journal\.ts done ff66/);
    assert.equal(readFileSync(join(vault, 'Projects', 'demo', 'Journal', 'ledger.jsonl'), 'utf8').includes('"kind":"done"'), false, 'printing the command does not close the row');
});

test('--json reports the same lists and still does not close', () => {
    const { vault, ledger } = ledgerWith([
        base('aaaa', { kind: 'wip', text: 'acme/widget#12' }),
        base('bbbb', { kind: 'wip', refs: ['gh:pr:acme/widget#9'], text: 'quiet' }),
    ]);
    const before = readFileSync(ledger, 'utf8');
    const r = run(vault, ['--json'], fakeGh(VIEWS));
    assert.equal(r.status, 1, r.stderr);
    const body = JSON.parse(r.stdout) as { merged: { id: string; done?: string; allMerged: boolean }[]; stale: { id: string; done?: string; prs: { idleDays: number }[] }[]; unknown: unknown[]; closed: unknown[] };
    assert.equal(body.merged[0]?.id, 'aaaa');
    assert.equal(body.merged[0]?.allMerged, true);
    assert.equal(body.merged[0]?.done, 'journal.ts done aaaa');
    assert.equal(body.stale[0]?.id, 'bbbb');
    assert.equal(body.stale[0]?.prs[0]?.idleDays, 41);
    assert.equal(body.stale[0]?.done, undefined);
    assert.deepEqual(body.unknown, []);
    assert.deepEqual(body.closed, []);
    assert.equal(readFileSync(ledger, 'utf8'), before);
});

test('a recently active open PR is a clean sweep', () => {
    const { vault } = ledgerWith([base('cccc', { kind: 'wip', text: 'acme/widget#8' })]);
    const r = run(vault, [], fakeGh(VIEWS));
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /Merged open rows \(0\)/);
    assert.match(r.stdout, /Stale open PRs, no activity in 7 days \(0\)/);
    assert.equal(r.stdout.includes('cccc'), false);
});

test('idle for exactly --stale-days is stale; one day newer is not', () => {
    const { vault } = ledgerWith([
        base('aa61', { kind: 'wip', text: 'acme/widget#6' }),
        base('bb51', { kind: 'wip', text: 'acme/widget#5' }),
    ]);
    const r = run(vault, ['--stale-days', '7'], fakeGh(VIEWS));
    assert.equal(r.status, 1, r.stderr);
    assert.match(r.stdout, /aa61 {2}acme\/widget#6/);
    assert.match(r.stdout, /acme\/widget#6 OPEN last activity 2026-10-05 \(7d\)/);
    assert.equal(r.stdout.includes('bb51'), false, '6 idle days is still recent at a 7 day window');
});

test('a closed ledger row is ignored even when its PR is merged', () => {
    const { vault } = ledgerWith([
        base('aaaa', { kind: 'wip', text: 'acme/widget#12' }),
        base('zzzz', { kind: 'done', closes: 'aaaa', text: 'finished' }),
    ]);
    const gh = fakeGh(VIEWS);
    const r = run(vault, [], gh);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout.includes('aaaa'), false);
    assert.equal(existsSync(gh.log) ? readFileSync(gh.log, 'utf8') : '', '', 'gh is not asked about a closed row');
});

test('a pull URL is not one of the two named forms, so it is not swept', () => {
    const { vault } = ledgerWith([
        base('aa12', { kind: 'wip', text: 'see https://github.com/acme/widget/pull/12' }),
        base('bb12', { kind: 'wip', text: 'acme/widget pull 12' }),
    ]);
    const gh = fakeGh(VIEWS);
    const r = run(vault, [], gh);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout.includes('aa12') || r.stdout.includes('bb12'), false);
    assert.equal(existsSync(gh.log) ? readFileSync(gh.log, 'utf8') : '', '');
});

test('usage errors exit 2 and do not need gh', () => {
    const missing = spawnSync(process.execPath, [SCRIPT, '--project', 'demo', '--vault', join(tmpdir(), 'ms-no-such-vault')], {
        encoding: 'utf8',
        env: { ...process.env, MAESTRO_LOCAL_CONFIG: '', LEDGER_ROOT: '', VAULT_ROOT: '', MAESTRO_OVERLAY: '' },
    });
    assert.equal(missing.status, 2);
    assert.match(missing.stderr, /no ledger at/);

    const noProject = spawnSync(process.execPath, [SCRIPT, '--vault', tmpdir()], {
        encoding: 'utf8',
        env: { ...process.env, MAESTRO_LOCAL_CONFIG: '', LEDGER_ROOT: '', VAULT_ROOT: '', MAESTRO_PROJECT: '', MAESTRO_OVERLAY: '' },
    });
    assert.equal(noProject.status, 2);
    assert.match(noProject.stderr, /pass --vault/);

    const { vault } = ledgerWith([]);
    const env = { ...process.env, MAESTRO_LOCAL_CONFIG: '', LEDGER_ROOT: '', VAULT_ROOT: '', MAESTRO_OVERLAY: '', MAESTRO_PROJECT: '' };
    const badDay = spawnSync(process.execPath, [SCRIPT, '--vault', vault, '--project', 'demo', '--today', '2026-02-30'], { encoding: 'utf8', env });
    assert.equal(badDay.status, 2, badDay.stderr);
    assert.match(badDay.stderr, /--today/);
    const badWindow = spawnSync(process.execPath, [SCRIPT, '--vault', vault, '--project', 'demo', '--stale-days', '7d'], { encoding: 'utf8', env });
    assert.equal(badWindow.status, 2, badWindow.stderr);
    assert.match(badWindow.stderr, /--stale-days/);
});

test('the playbook names the exit codes and forbids closing a row', () => {
    const text = readFileSync(PLAYBOOK, 'utf8');
    assert.match(text, /\| 0 \|/);
    assert.match(text, /\| 1 \|/);
    assert.match(text, /\| 2 \|/);
    assert.match(text, /\| 3 \|/);
    assert.match(text, /journal\.ts done/);
    assert.match(text, /Never run `journal\.ts done`/);
    assert.match(text, /not merged/i);
    assert.match(text, /acme\/widget|owner\/repo/);
});
