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
        env: { ...process.env, MAESTRO_LOCAL_CONFIG: '', LEDGER_ROOT: '', VAULT_ROOT: '', MAESTRO_OVERLAY: '', MAESTRO_GH_ORG: '', MAESTRO_REPO_OWNERS: '', MAESTRO_STATUS_DIR: mkdtempSync(join(tmpdir(), 'ms-status-')), MAESTRO_EVENT_DIR: mkdtempSync(join(tmpdir(), 'ms-events-')), ...gh.env },
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
        base('dddd', { kind: 'blocked', refs: ['acme/widget#7'], text: 'closed unmerged' }),
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

test('a pull URL is swept, and "acme/widget pull 12" is still not a PR', () => {
    const { vault } = ledgerWith([
        base('aa12', { kind: 'wip', text: 'see https://github.com/acme/widget/pull/12' }),
        base('bb12', { kind: 'wip', text: 'acme/widget pull 12' }),
    ]);
    const gh = fakeGh(VIEWS);
    const r = run(vault, [], gh);
    assert.equal(r.status, 1, r.stderr);
    assert.match(r.stdout, /Merged open rows \(1\)/);
    assert.match(r.stdout, /aa12 {2}see https:\/\/github\.com\/acme\/widget\/pull\/12/);
    assert.equal(r.stdout.includes('bb12'), false, 'two words and a number are not a PR name');
    assert.equal((r.log.match(/pr view/g) ?? []).length, 1, 'only the URL row is read');
});

test('repo#N, "repo #N" and gh:pr:repo#N resolve their owner from repo_owners or the row repo field', () => {
    const { vault } = ledgerWith([
        base('aa01', { kind: 'wip', text: 'widget#12 landed' }),
        base('bb01', { kind: 'wip', text: 'follow up on widget #9' }),
        base('cc01', { kind: 'blocked', gate: 'gh:pr:widget#8', text: 'wait for it' }),
        base('dd01', { kind: 'wip', repo: 'acme/widget', text: 'widget #7 closed' }),
        base('ee01', { kind: 'wip', text: 'ticket #12 and step #9, no PR here' }),
        base('ff01', { kind: 'blocked', gate: 'gh:pr:gadget#3', text: 'gadget has no known owner' }),
    ]);
    const gh = fakeGh(VIEWS);
    const r = run(vault, ['--json'], { ...gh, env: { ...gh.env, MAESTRO_REPO_OWNERS: 'widget=acme' } });
    assert.equal(r.status, 1, r.stderr);
    const body = JSON.parse(r.stdout) as { merged: { id: string }[]; stale: { id: string }[]; closed: { id: string }[]; unknown: { id: string; prs: { reason?: string }[] }[]; parsed: number };
    assert.deepEqual(body.merged.map((x) => x.id), ['aa01']);
    assert.deepEqual(body.stale.map((x) => x.id), ['bb01']);
    assert.deepEqual(body.closed.map((x) => x.id), ['dd01']);
    assert.deepEqual(body.unknown.map((x) => x.id), ['ff01']);
    assert.equal(body.unknown[0]?.prs[0]?.reason, 'no owner');
    assert.equal(r.log.includes('widget'), true);
    assert.equal(/--repo gadget( |$)/m.test(r.log), false, 'a bare repo with no owner is never sent to gh');
    assert.equal(JSON.stringify(body).includes('ee01'), false, 'ticket #12 is not a PR');
});

test('a sweep that parsed no PR from the open rows warns and is not clean', () => {
    const { vault } = ledgerWith([
        base('aa01', { kind: 'wip', text: 'merged long ago, see widget #12' }),
        base('bb01', { kind: 'blocked', text: 'waiting on a review' }),
    ]);
    const text = run(vault, [], fakeGh(VIEWS));
    assert.equal(text.status, 3, text.stderr);
    assert.match(text.stdout, /^WARNING: merge-sweep parsed 0 pull requests across 2 open rows/);
    assert.equal(/\bclean\b/i.test(text.stdout.split('\n')[0] ?? ''), true, 'the warning says it is not clean');
    const json = JSON.parse(run(vault, ['--json'], fakeGh(VIEWS)).stdout) as { warning?: string; parsed: number; openRows: number };
    assert.equal(json.parsed, 0);
    assert.equal(json.openRows, 2);
    assert.match(json.warning ?? '', /parsed 0 pull requests/);
});

test('no open rows at all is clean, not blind', () => {
    const { vault } = ledgerWith([base('aaaa', { kind: 'wip', text: 'x' }), base('zzzz', { kind: 'done', closes: 'aaaa', text: 'x' })]);
    const r = run(vault, [], fakeGh(VIEWS));
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout.includes('WARNING'), false);
});

const rowsOf = (vault: string): { id?: string; kind?: string; closes?: string; text?: string }[] => readFileSync(join(vault, 'Projects', 'demo', 'Journal', 'ledger.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));

test('--close appends done to a row linked by refs once every PR merged, and a second run does nothing', () => {
    const { vault } = ledgerWith([
        base('aa01', { kind: 'wip', refs: ['gh:pr:acme/widget#12'], text: 'linked, merged' }),
        base('bb01', { kind: 'wip', text: 'mentions acme/widget#12 only in its text' }),
        base('cc01', { kind: 'wip', refs: ['gh:pr:acme/widget#12', 'gh:pr:acme/widget#8'], text: 'one PR still open' }),
        base('dd01', { kind: 'wip', refs: ['gh:pr:acme/widget#12', 'gh:pr:acme/widget#3'], text: 'one PR unreadable' }),
        base('ee01', { kind: 'wip', refs: ['gh:pr:acme/widget#7'], text: 'closed unmerged' }),
    ]);
    const first = run(vault, ['--close', '--json'], fakeGh(VIEWS));
    assert.equal(first.status, 1, first.stderr);
    const report = JSON.parse(first.stdout) as { autoClosed: { id: string }[]; merged: { id: string; closable: boolean }[] };
    assert.deepEqual(report.autoClosed.map((x) => x.id), ['aa01']);
    assert.deepEqual(report.merged.map((x) => x.id).sort(), ['bb01', 'cc01', 'dd01']);
    assert.equal(report.merged.some((x) => x.closable), false, 'only the all-merged linked row was closable');
    const dones = rowsOf(vault).filter((r) => r.kind === 'done');
    assert.deepEqual(dones.map((d) => d.closes), ['aa01']);
    assert.match(dones[0]?.text ?? '', /acme\/widget#12/);

    const second = run(vault, ['--close', '--json'], fakeGh(VIEWS));
    assert.deepEqual((JSON.parse(second.stdout) as { autoClosed: unknown[] }).autoClosed, []);
    assert.equal(rowsOf(vault).filter((r) => r.kind === 'done').length, 1, 'a closed row is never closed twice');
});

test('without --close the sweep still never writes, and --close text says what it closed', () => {
    const { vault, ledger } = ledgerWith([base('aa01', { kind: 'wip', refs: ['gh:pr:acme/widget#12'], text: 'linked, merged' })]);
    const before = readFileSync(ledger, 'utf8');
    const read = run(vault, [], fakeGh(VIEWS));
    assert.equal(read.status, 1);
    assert.equal(readFileSync(ledger, 'utf8'), before);
    const closed = run(vault, ['--close'], fakeGh(VIEWS));
    assert.equal(closed.status, 0, closed.stderr);
    assert.match(closed.stdout, /Closed on merge \(1\):\n {2}aa01 {2}linked, merged/);
});

test('a ref row written by pr-open links the row, so --close closes it', () => {
    const { vault } = ledgerWith([
        base('aa01', { kind: 'wip', text: 'build the thing' }),
        base('rr01', { kind: 'ref', attaches: 'aa01', refs: ['gh:pr:acme/widget#12'], branch: 'feat/MAESTRO-aa01-thing', text: 'PR acme/widget#12 opened for aa01' }),
    ]);
    const r = run(vault, ['--close', '--json'], fakeGh(VIEWS));
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual((JSON.parse(r.stdout) as { autoClosed: { id: string }[] }).autoClosed.map((x) => x.id), ['aa01']);
    assert.equal(rowsOf(vault).some((x) => x.kind === 'done' && x.closes === 'aa01'), true);
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

test('an open question, ask or pending decision is never matched or closed, even when it cites a merged PR in refs', () => {
    const { vault, ledger } = ledgerWith([
        base('zl01', { kind: 'question', refs: ['gh:pr:acme/widget#12'], text: 'should we ship acme/widget#12 early?' }),
        base('8i01', { kind: 'decision', pending: true, refs: ['gh:pr:acme/widget#12'], text: 'pick after acme/widget#12' }),
        base('bl01', { kind: 'blocked', refs: ['gh:pr:acme/widget#12'], text: 'waits on acme/widget#12' }),
    ]);
    const before = readFileSync(ledger, 'utf8');
    const r = run(vault, ['--close-ledger', '--json'], fakeGh(VIEWS));
    const report = JSON.parse(r.stdout) as { autoClosed: unknown[]; merged: { id: string; closable: boolean }[]; skipped: number; actions: number; closedCount: number };
    assert.deepEqual(report.autoClosed, []);
    assert.equal(report.skipped, 2);
    assert.deepEqual(report.merged.map((x) => x.id), ['bl01'], 'a blocked row is listed, never closed');
    assert.equal(report.merged[0]?.closable, false);
    assert.equal(report.closedCount, 0);
    assert.equal(report.actions, 1);
    assert.equal(readFileSync(ledger, 'utf8'), before, 'nothing was written');
});

test('--json carries actions and closedCount; exit 0 means actions is 0, and --close-ledger closes like --close', () => {
    const { vault } = ledgerWith([base('aa01', { kind: 'wip', refs: ['gh:pr:acme/widget#12'], text: 'linked, merged' })]);
    const r = run(vault, ['--close-ledger', '--json'], fakeGh(VIEWS));
    assert.equal(r.status, 0, r.stderr);
    const report = JSON.parse(r.stdout) as { actions: number; closedCount: number; blind: boolean };
    assert.deepEqual({ actions: report.actions, closedCount: report.closedCount, blind: report.blind }, { actions: 0, closedCount: 1, blind: false });
    const quiet = ledgerWith([base('bb01', { kind: 'wip', refs: ['gh:pr:acme/widget#12', 'gh:pr:acme/widget#8'], text: 'one still open' })]);
    const q = run(quiet.vault, ['--json'], fakeGh(VIEWS));
    assert.equal(q.status, 1);
    assert.equal((JSON.parse(q.stdout) as { actions: number }).actions, 1);
});

test('a ledger whose only open rows are questions is clean, not blind', () => {
    const { vault } = ledgerWith([base('zl01', { kind: 'question', text: 'which way?' })]);
    const r = run(vault, ['--json'], fakeGh(VIEWS));
    assert.equal(r.status, 0, r.stderr);
    assert.equal((JSON.parse(r.stdout) as { blind: boolean }).blind, false);
});

test('the playbook names the exit codes and the close flag', () => {
    const text = readFileSync(PLAYBOOK, 'utf8');
    assert.match(text, /\| 0 \|/);
    assert.match(text, /\| 1 \|/);
    assert.match(text, /\| 2 \|/);
    assert.match(text, /\| 3 \|/);
    assert.match(text, /journal\.ts done/);
    assert.match(text, /Never run `journal\.ts done`/);
    assert.match(text, /--close/);
    assert.match(text, /not merged/i);
    assert.match(text, /acme\/widget|owner\/repo/);
});

test('--prune-others adds a pruned report to the JSON, changes nothing in the sweep, and the playbook names it', () => {
    const { vault } = ledgerWith([base('aaaa', { kind: 'wip', text: 'follow-ups for acme/widget#12' })]);
    const plain = run(vault, ['--json'], fakeGh(VIEWS));
    const pruned = run(vault, ['--json', '--prune-others'], fakeGh(VIEWS));
    assert.equal(pruned.status, plain.status, pruned.stderr);
    const out = JSON.parse(pruned.stdout) as { pruned?: { cards: unknown[]; drafts: unknown[]; unread: number }; merged: unknown[] };
    assert.deepEqual(out.pruned, { cards: [], drafts: [], unread: 0 }, 'nothing cached and nothing queued: nothing pruned');
    assert.equal(out.merged.length, 1);
    assert.equal('pruned' in (JSON.parse(plain.stdout) as object), false, 'without the flag the JSON has no pruned key');
    assert.match(readFileSync(PLAYBOOK, 'utf8'), /--prune-others/);
});
