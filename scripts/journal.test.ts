// Run: node --test scripts/journal.test.ts
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync, spawn } from 'node:child_process';
import { cpSync, mkdtempSync, mkdirSync, rmSync, readFileSync, writeFileSync, existsSync, readdirSync, utimesSync, realpathSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { installGhStub, prNode } from './lib/gh-stub.ts';

// Hermetic: never read the user's config file (see local-config.ts).
process.env.MAESTRO_LOCAL_CONFIG = '';
// ...nor the user's event loop: `prime` and `handoff` read the standing pickups' runtime checks from it.
process.env.MAESTRO_EVENT_DIR = mkdtempSync(join(tmpdir(), 'journal-events-'));

const SCRIPT = new URL('./journal.ts', import.meta.url).pathname;
const MARK = ['--model', 'Test Model', '--used', 'skill:the-maestro,tool:journal.ts'];
let vault: string;
let tv: string;
let projects: string;

/** One row or item as the CLI prints it as JSON; the tests read only a few fields of each. */
interface Out {
    id?: string; stream?: string; text?: string; kind?: string; key?: string; why?: string; scope?: string; refs?: string[]; repo?: string;
    stale?: boolean; model?: string; status?: string; total?: number; open?: number; done?: number; dropped?: number;
    date?: string; ts?: string; desk?: string; pid?: number | null; until?: string; closes?: string; doneOn?: string; box?: number; line?: number; problem?: string;
    canonical?: string; ids?: string[]; rows?: number; high?: number; medium?: number; low?: number; used?: string[]; tokens?: string; [field: string]: unknown;
}
/** The JSON documents the commands print; each test reads the part it needs. */
interface Doc {
    inflight: Out[]; queued: Out[]; blocked: Out[]; awaiting: Out[]; paste: Out[]; done: Out[]; streams: Out[]; claims: Out[]; models: Out[];
    standing: Out[]; oneOff: Out[]; untagged: Out[]; byStream: Out[]; pending: Out[]; blockers: Out[]; pendingTransitions: Out[];
    byBox: Record<string, Out[] | undefined>; problems: Out[]; model: Record<string, number>; [field: string]: unknown;
}
const parse = <T = Doc>(text: string): T => JSON.parse(text);
const emptyCwd = mkdtempSync(join(tmpdir(), 'journal-cwd-'));

/** What a CLI run reports. */
interface Run { code: number | null; out: string; err: string }
/** A value the test expects to be present (a find() that must hit). */
function must<T>(v: T | undefined | null, label = 'value'): T {
    assert.ok(v !== undefined && v !== null, label);
    return v;
}

function run(...args: string[]): Run {
    const r = spawnSync(process.execPath, [SCRIPT, ...args, '--vault', vault, '--project', 'test-proj'], {
        encoding: 'utf8', cwd: emptyCwd,   // roll and handoff sweep the cwd: never a real container
        env: { ...process.env, VAULT_ROOT: '', MAESTRO_PROJECTS_DIR: projects, MAESTRO_CONTAINER_ROOT: '', MAESTRO_UPDATE_CHECK: 'off',
            MAESTRO_EVENT_DIR: join(vault, 'Events'), MAESTRO_LAUNCH_AGENTS_DIR: join(vault, 'LaunchAgents') },
    });
    return { code: r.status, out: r.stdout, err: r.stderr };
}
const ledger = () => readFileSync(join(vault, 'Projects', 'test-proj', 'Journal', 'ledger.jsonl'), 'utf8')
    .split('\n').filter(Boolean).map((l) => parse<Out>(l));
const idOf = (out: string): string => out.trim().split(/\s+/)[1];

beforeEach(() => {
    vault = mkdtempSync(join(tmpdir(), 'journal-test-'));
    tv = mkdtempSync(join(tmpdir(), 'journal-tickets-'));
    projects = mkdtempSync(join(tmpdir(), 'journal-projects-'));
});

test('start without --model fails and writes nothing', () => {
    const r = run('start', 'unmarked work', '--used', 'tool:journal.ts');
    assert.equal(r.code, 1);
    assert.match(r.err, /--model/);
    assert.throws(() => ledger());
});

test('start with model and used shows the marks in status', () => {
    assert.equal(run('start', 'marked work', ...MARK).code, 0);
    const s = run('status');
    assert.equal(s.code, 0);
    assert.match(s.out, /marked work .*model: Test Model · used: skill:the-maestro, tool:journal\.ts/);
});

test('standup hides the usage suffix', () => {
    const id = idOf(run('start', 'team item', ...MARK).out);
    run('done', id, ...MARK);
    const s = run('standup');
    assert.match(s.out, /- team item/);
    assert.doesNotMatch(s.out, /model:/);
});

test('stamp-missing marks an unmarked entry as unrecorded, once', () => {
    const id = idOf(run('start', 'legacy work', '--allow-unmarked').out);
    const first = run('stamp-missing');
    assert.match(first.out, /stamped 1 entry/);
    const stamp = must(ledger().find((e) => e.annotates === id));
    assert.deepEqual([stamp.model, stamp.used, stamp.tokens], ['unrecorded', ['unrecorded'], 'unmeasured']);
    assert.match(run('status').out, /legacy work .*model: unrecorded · used: unrecorded · tokens: unmeasured/);
    assert.match(run('stamp-missing').out, /stamped 0 entries/);
});

test('fold does not duplicate a stamped item', () => {
    const id = idOf(run('start', 'only once', '--allow-unmarked').out);
    run('stamp', id, ...MARK);
    run('stamp-missing');
    const s = parse(run('status', '--json').out);
    assert.equal(s.inflight.length, 1);
    assert.equal(s.inflight[0].model, 'Test Model');
});

test('roll appends a marked row without needing --model', () => {
    const id = idOf(run('start', 'finished', ...MARK).out);
    run('done', id, ...MARK);
    const r = run('roll');
    assert.equal(r.code, 0, r.err);
    const rolled = must(ledger().find((e) => e.kind === 'rolled'));
    assert.deepEqual([rolled.model, rolled.used, rolled.tokens], ['n/a', ['tool:journal.ts'], 'n/a']);
});

test('roll and scratch list <scripts_dir>/scratch with proposals when scripts_dir is set, and say nothing when it is not', () => {
    const shelfDir = mkdtempSync(join(tmpdir(), 'journal-shelf-'));
    mkdirSync(join(shelfDir, 'scratch'));
    const f = join(shelfDir, 'scratch', 'tally.sh');
    writeFileSync(f, '# tally the rows\n');
    const old = new Date(Date.now() - 20 * 86400000);
    utimesSync(f, old, old);
    const id = idOf(run('start', 'finished', ...MARK).out);
    run('done', id, ...MARK);
    const on = (...a: string[]) => runEnv({ MAESTRO_SCRIPTS_DIR: shelfDir }, ...a);
    for (const cmd of ['roll', 'scratch']) {
        const r = on(cmd);
        assert.equal(r.code, 0, r.err);
        assert.match(r.out, /tally\.sh \| 20 \| 0 \| tally the rows \| delete-candidate/, cmd);
    }
    assert.ok(existsSync(f), 'proposals never delete');
    assert.doesNotMatch(runEnv({}, 'roll').out, /scratch:/);
    assert.match(runEnv({}, 'scratch').out, /scripts_dir is not set/);
});

test('root precedence: --vault beats LEDGER_ROOT beats VAULT_ROOT', () => {
    const ledgerRoot = mkdtempSync(join(tmpdir(), 'journal-ledger-root-'));
    const vaultRoot = mkdtempSync(join(tmpdir(), 'journal-vault-root-'));
    const explicitVault = mkdtempSync(join(tmpdir(), 'journal-explicit-vault-'));
    const writes = (base: string) => join(base, 'Projects', 'test-proj', 'Journal', 'ledger.jsonl');

    // Neither flag nor LEDGER_ROOT: falls back to VAULT_ROOT.
    let r = spawnSync(process.execPath, [SCRIPT, 'start', 'fallback to vault_root', ...MARK, '--project', 'test-proj'], {
        encoding: 'utf8',
        env: { ...process.env, VAULT_ROOT: vaultRoot, LEDGER_ROOT: '' },
    });
    assert.equal(r.status, 0, r.stderr);
    assert.ok(existsSync(writes(vaultRoot)));

    // LEDGER_ROOT set alongside VAULT_ROOT: LEDGER_ROOT wins.
    r = spawnSync(process.execPath, [SCRIPT, 'start', 'ledger_root wins', ...MARK, '--project', 'test-proj'], {
        encoding: 'utf8',
        env: { ...process.env, VAULT_ROOT: vaultRoot, LEDGER_ROOT: ledgerRoot },
    });
    assert.equal(r.status, 0, r.stderr);
    assert.ok(existsSync(writes(ledgerRoot)));
    assert.doesNotMatch(readFileSync(writes(ledgerRoot), 'utf8'), /fallback to vault_root/);

    // --vault beats both env vars.
    r = spawnSync(process.execPath, [SCRIPT, 'start', 'explicit vault wins', ...MARK, '--vault', explicitVault, '--project', 'test-proj'], {
        encoding: 'utf8',
        env: { ...process.env, VAULT_ROOT: vaultRoot, LEDGER_ROOT: ledgerRoot },
    });
    assert.equal(r.status, 0, r.stderr);
    assert.ok(existsSync(writes(explicitVault)));
});

// ── streams, facts, carry, retro, archive ───────────────────────────────────

const registryFile = () => join(vault, 'Projects', 'test-proj', 'streams.json');
interface RegistryFile { streams: Record<string, { aliases: string[]; status?: string }>; models: Record<string, { aliases: string[] }> }
const registry = (): RegistryFile => parse<RegistryFile>(readFileSync(registryFile(), 'utf8'));
function seedRegistry(streams: Record<string, { aliases: string[]; status: string }> = { Launch: { aliases: ['launch', 'launch-v2'], status: 'active' }, Maestro: { aliases: [], status: 'active' } }) {
    mkdirSync(join(vault, 'Projects', 'test-proj'), { recursive: true });
    writeFileSync(registryFile(), JSON.stringify({ streams }, null, 2));
}
const runT = (...args: string[]) => run(...args, '--tickets-vault', tv);
const statusJson = (...a: string[]) => parse(run('status', '--json', ...a).out);
const retroPath = (stream: string) => join(tv, 'Projects', 'dev-env', 'Archive', `${stream}-retro-${new Date().toISOString().slice(0, 10)}.md`);

test('write normalises case and aliases to the canonical stream', () => {
    seedRegistry();
    for (const [name, spelling] of [['a', 'launch'], ['b', 'LAUNCH'], ['c', 'launch-v2'], ['d', 'Launch']]) {
        const r = run('start', `item ${name}`, '--stream', spelling, ...MARK);
        assert.equal(r.code, 0, r.err);
        if (spelling !== 'Launch') assert.match(r.err, new RegExp(`normalised ${spelling} -> Launch`));
    }
    assert.deepEqual([...new Set(ledger().map((e) => e.stream))], ['Launch']);
    const id = idOf(run('start', 'to retag', ...MARK).out);
    assert.equal(run('tag', id, '--stream', 'maestro', ...MARK).code, 0);
    assert.equal(must(ledger().find((e) => e.kind === 'tag')).stream, 'Maestro');
    assert.equal(run('ask', 'q?', '--stream', 'launch', ...MARK).code, 0);
    assert.equal(run('log', 'n', '--stream', 'launch', ...MARK).code, 0);
    assert.ok(ledger().filter((e) => e.stream).every((e) => ['Launch', 'Maestro'].includes(String(e.stream))));
});

test('an unknown stream is rejected with a suggestion, and --new-stream registers it', () => {
    seedRegistry();
    const r = run('start', 'typo work', '--stream', 'Lanuch', ...MARK);
    assert.equal(r.code, 1);
    assert.match(r.err, /Did you mean "Launch"\?/);
    assert.match(r.err, /--new-stream/);
    assert.throws(() => ledger());   // nothing written
    const far = run('start', 'far work', '--stream', 'Zebra', ...MARK);
    assert.equal(far.code, 1);
    assert.doesNotMatch(far.err, /Did you mean/);
    assert.equal(run('start', 'fresh work', '--stream', 'Zebra', '--new-stream', ...MARK).code, 0);
    assert.deepEqual(registry().streams.Zebra, { aliases: [], status: 'active' });
    assert.equal(run('start', 'more', '--stream', 'zebra', ...MARK).code, 0);
    assert.equal(run('start', 'none stays reserved', '--stream', 'none', ...MARK).code, 0);
});

test('--stream none means no stream on start, ask and log, with or without a registry', () => {
    for (const seed of [false, true]) {
        if (seed) seedRegistry();
        const before = existsSync(join(vault, 'Projects', 'test-proj', 'Journal', 'ledger.jsonl')) ? ledger().length : 0;
        assert.equal(run('start', 'plain work', '--stream', 'none', ...MARK).code, 0);
        assert.equal(run('ask', 'plain q?', '--stream', 'None', ...MARK).code, 0);
        assert.equal(run('log', 'plain note', '--stream', 'none', ...MARK).code, 0);
        const added = ledger().slice(before);
        assert.equal(added.length, 3);
        assert.ok(added.every((e) => e.stream === undefined));
    }
    const footer = run('status', '--footer').out;
    assert.doesNotMatch(footer, /none/i);
    assert.match(footer, /\*\*Ledger:\*\*/);
    assert.equal(registry().streams.none, undefined);
});

test('tag --stream none clears a stream, and the footer drops it', () => {
    run('start', 'to clear', '--stream', 'Launch', ...MARK);
    const id = idOf(run('start', 'keeps stream', '--stream', 'Launch', ...MARK).out);
    assert.match(run('status', '--footer').out, /Ledger \(Launch\)/);
    assert.equal(run('tag', 'to clear', '--stream', 'none', ...MARK).code, 0);
    assert.equal(must(ledger().find((e) => e.kind === 'tag')).stream, undefined);
    const streams = statusJson().inflight.map((i) => i.stream);
    assert.deepEqual(streams.sort(), [undefined, 'Launch'].sort());
    assert.doesNotMatch(run('status', '--footer').out, /Ledger \(none\)/);
    assert.ok(id);
});

test('streams add none is rejected; fact and carry refuse none', () => {
    const r = run('streams', 'add', 'none');
    assert.equal(r.code, 1);
    assert.match(r.err, /reserved/);
    assert.equal(run('streams', 'add', 'None').code, 1);
    assert.equal(existsSync(registryFile()), false);
    assert.equal(run('fact', 'k=v', '--stream', 'none', ...MARK).code, 1);
});

test('existing rows that carry stream "none" read as unstreamed; the ledger is not rewritten', () => {
    const dir = join(vault, 'Projects', 'test-proj', 'Journal');
    mkdirSync(dir, { recursive: true });
    const file = join(dir, 'ledger.jsonl');
    const d = new Date().toISOString().slice(0, 10);
    writeFileSync(file, JSON.stringify({ id: 'old1', ts: `${d}T10:00:00.000Z`, date: d, kind: 'wip', text: 'legacy row', stream: 'none', refs: [] }) + '\n');
    const before = readFileSync(file, 'utf8');
    assert.deepEqual(statusJson().inflight.map((i) => i.stream), [undefined]);
    const footer = run('status', '--footer').out;
    assert.doesNotMatch(footer, /none/i);
    assert.doesNotMatch(run('streams', 'list').out, /none/);
    assert.equal(readFileSync(file, 'utf8'), before);
});

test('with no registry nothing is enforced', () => {
    assert.equal(run('start', 'free text', '--stream', 'Anything', ...MARK).code, 0);
    assert.equal(ledger()[0].stream, 'Anything');
    assert.equal(existsSync(registryFile()), false);
});

test('streams add is idempotent and refuses alias collisions; list shows counts', () => {
    assert.match(run('streams', 'add', 'Launch', '--alias', 'launch,launch-v2').out, /added\s+Launch/);
    assert.match(run('streams', 'add', 'Launch', '--alias', 'launch,launch-v2').out, /unchanged\s+Launch/);
    assert.deepEqual(registry().streams.Launch, { aliases: ['launch-v2'], status: 'active' });   // 'launch' is just a case variant of the name
    assert.equal(run('streams', 'add', 'Other', '--alias', 'launch').code, 1);
    assert.equal(run('streams', 'add', 'LAUNCH').code, 1);
    run('start', 'one', '--stream', 'launch', ...MARK);
    const l = parse(run('streams', 'list', '--json').out);
    assert.deepEqual(l.streams.map((r) => [r.stream, r.open, r.total]), [['Launch', 1, 1]]);
});

test('streams add and models add treat a registry entry without an aliases list as empty', () => {
    mkdirSync(join(vault, 'Projects', 'test-proj'), { recursive: true });
    writeFileSync(registryFile(), JSON.stringify({ streams: { Launch: { status: 'active' } }, models: { 'm-one': {} } }));
    const s = run('streams', 'add', 'Launch', '--alias', 'go');
    assert.equal(s.code, 0, s.err);
    assert.match(s.out, /updated\s+Launch\s+aliases: go/);
    assert.deepEqual(registry().streams.Launch, { status: 'active', aliases: ['go'] });
    const m = run('models', 'add', 'm-one', '--alias', 'mo');
    assert.equal(m.code, 0, m.err);
    assert.deepEqual(registry().models['m-one'].aliases, ['mo']);
});

test('read-time mapping heals the case split without touching the ledger', () => {
    run('start', 'lower', '--stream', 'launch', ...MARK);
    run('start', 'upper', '--stream', 'Launch', ...MARK);
    const before = readFileSync(join(vault, 'Projects', 'test-proj', 'Journal', 'ledger.jsonl'), 'utf8');
    assert.equal((run('status').out.match(/^== Launch ==$/gm) || []).length, 2);   // no registry: the split shows as a duplicate heading
    seedRegistry();
    const s = run('status').out;
    assert.equal((s.match(/^== /gm) || []).length, 1);
    assert.match(s, /== Launch ==/);
    assert.deepEqual(statusJson().inflight.map((i) => i.stream), ['Launch', 'Launch']);
    const c = run('streams', 'check');
    assert.match(c.out, /1 item\(s\) would change display stream/);
    assert.match(c.out, /launch -> Launch/);
    assert.equal(readFileSync(join(vault, 'Projects', 'test-proj', 'Journal', 'ledger.jsonl'), 'utf8'), before);
});

test('fact rows are not items and never show as open', () => {
    seedRegistry();
    const r = run('fact', 'v1_visits_full_min=79', '--stream', 'launch', ...MARK);
    assert.equal(r.code, 0, r.err);
    const row = must(ledger().find((e) => e.kind === 'fact'));
    assert.deepEqual([row.key, row.value, row.stream], ['v1_visits_full_min', '79', 'Launch']);
    const s = statusJson();
    assert.deepEqual([s.inflight, s.blocked, s.awaiting, s.done], [[], [], [], []]);
    assert.deepEqual(parse(run('streams', 'list', '--json').out).streams.map((r) => r.total), [0, 0]);   // registered, but no items
    assert.equal(run('fact', 'no-equals', '--stream', 'Launch', ...MARK).code, 1);
    assert.equal(run('fact', 'k=v', ...MARK).code, 1);
});

test('carry re-homes an item', () => {
    seedRegistry();
    const id = idOf(run('start', 'follow-up', '--stream', 'Launch', ...MARK).out);
    assert.equal(run('carry', id, '--to', 'maestro', ...MARK).code, 0);
    const c = must(ledger().find((e) => e.kind === 'carry'));
    assert.deepEqual([c.carries, c.from, c.stream], [id, 'Launch', 'Maestro']);
    assert.equal(statusJson().inflight[0].stream, 'Maestro');
    assert.equal(run('carry', id, '--to', 'Nope', ...MARK).code, 1);
});

/** A finished stream: one done item citing a PR, a learning, a fact. */
function finishedStream(name = 'Launch') {
    seedRegistry();
    const id = idOf(run('start', 'ship the widget', '--stream', name, '--ticket', 'p1-001', ...MARK).out);
    run('done', id, '--why', 'merged PR #1234 and released', ...MARK);
    run('log', 'learned the cause was a stale cache', '--stream', name, ...MARK);
    run('fact', 'visits_min=79', '--stream', name, ...MARK);
    return id;
}

test('retro writes the expected sections, front-matter status: draft, and will not overwrite', () => {
    mkdirSync(join(tv, 'Projects', 'p1', 'Tickets'), { recursive: true });
    writeFileSync(join(tv, 'Projects', 'p1', 'Tickets', 'p1-001.md'), '---\nid: "p1-001"\ntitle: "Widget ticket"\nstatus: "open"\n---\nbody\n');
    finishedStream();
    const before = ledger().length;
    const r = runT('retro', 'launch');
    assert.equal(r.code, 0, r.err);
    const path = retroPath('Launch');
    assert.match(r.out, /wrote /);
    const doc = readFileSync(path, 'utf8');
    assert.match(doc, /^---\nstatus: draft\n/);
    for (const h of ['Summary', 'Timeline', 'Facts', 'Shipped', 'Tickets referenced', 'Learnings', 'Open follow-ups', 'Promoted to']) {
        assert.match(doc, new RegExp(`^## ${h}$`, 'm'));
    }
    assert.match(doc, /Items done: 1/);
    assert.match(doc, /\| visits_min \| 79 \|/);
    assert.match(doc, /ship the widget.*#1234/);
    assert.match(doc, /\| p1-001 \| open \| Widget ticket \|/);
    assert.match(doc, /learned the cause was a stale cache/);
    assert.match(doc, /^- \[ \] learned the cause.*Promoted to: $/m);
    assert.equal(ledger().length, before);   // retro appends nothing
    const again = runT('retro', 'Launch');
    assert.equal(again.code, 1);
    assert.match(again.err, /--force/);
    assert.equal(runT('retro', 'Launch', '--force').code, 0);
    assert.equal(runT('retro', 'Nope').code, 1);
    const custom = join(tv, 'custom', 'x.md');
    assert.equal(runT('retro', 'Launch', '--out', custom).code, 0);
    assert.ok(existsSync(custom));
});

test('archive refuses on open items, a draft retro and unfilled promotions, then succeeds', () => {
    finishedStream();
    const openId = idOf(run('start', 'still going', '--stream', 'Launch', ...MARK).out);
    let r = runT('archive', 'Launch', ...MARK);
    assert.equal(r.code, 1);
    assert.match(r.err, new RegExp(`open item ${openId}`));
    assert.match(r.err, /no retro doc found/);

    run('done', openId, ...MARK);
    runT('retro', 'Launch');
    r = runT('archive', 'Launch', ...MARK);
    assert.equal(r.code, 1);
    assert.match(r.err, /status: draft/);
    assert.match(r.err, /1 "Promoted to" line/);

    const path = retroPath('Launch');
    const doc = readFileSync(path, 'utf8');
    writeFileSync(path, doc.replace('status: draft', 'status: reviewed'));
    r = runT('archive', 'Launch', ...MARK);
    assert.equal(r.code, 1);
    assert.doesNotMatch(r.err, /status: draft/);
    assert.match(r.err, /Promoted to/);

    writeFileSync(path, doc.replace('status: draft', 'status: reviewed').replace(/Promoted to: $/m, 'Promoted to: one-off'));
    const rowsBefore = ledger().length;
    r = runT('archive', 'Launch', ...MARK);
    assert.equal(r.code, 0, r.err);
    const rows = ledger();
    assert.equal(rows.length, rowsBefore + 1);   // one archive event, nothing deleted
    const ev = must(rows.at(-1));
    assert.equal(ev.kind, 'archive');
    assert.equal(ev.stream, 'Launch');
    assert.equal(ev.ids?.length, 3);
    assert.equal(ev.retro, path);
    assert.equal(registry().streams.Launch.status, 'archived');
    assert.equal(runT('archive', 'Launch', ...MARK).code, 1);   // already archived
    assert.equal(run('start', 'late', '--stream', 'Launch', ...MARK).code, 1);   // writes to an archived stream are refused
});

test('archive accepts open items that were carried to another stream', () => {
    finishedStream();
    const openId = idOf(run('start', 'follow-up', '--stream', 'Launch', ...MARK).out);
    runT('retro', 'Launch');
    const path = retroPath('Launch');
    writeFileSync(path, readFileSync(path, 'utf8').replace('status: draft', 'status: reviewed').replace(/Promoted to: $/m, 'Promoted to: one-off'));
    assert.equal(runT('archive', 'Launch', ...MARK).code, 1);
    run('carry', openId, '--to', 'Maestro', ...MARK);
    assert.equal(runT('archive', 'Launch', ...MARK).code, 0);
    assert.deepEqual(statusJson().inflight.map((i) => i.id), [openId]);   // the carried item stays on the board
});

test('archived items are hidden by default and shown with --include-archived; unarchive restores exactly', () => {
    finishedStream();
    const other = idOf(run('start', 'other stream work', '--stream', 'Maestro', ...MARK).out);
    const snap = () => ({
        status: run('status', '--json').out, standup: run('standup').out,
        streams: parse(run('streams', 'list', '--json').out).streams.map(({ stream, open, done, dropped, total }) => [stream, open, done, dropped, total]),
    });
    const before = snap();
    runT('retro', 'Launch');
    const path = retroPath('Launch');
    writeFileSync(path, readFileSync(path, 'utf8').replace('status: draft', 'status: reviewed').replace(/Promoted to: $/m, 'Promoted to: one-off'));
    assert.equal(runT('archive', 'Launch', ...MARK).code, 0);

    const hidden = snap();
    assert.doesNotMatch(hidden.standup, /ship the widget/);
    assert.equal(parse(hidden.status).done.length, 0);
    assert.deepEqual(parse(hidden.status).inflight.map((i) => i.id), [other]);
    const shown = run('status', '--json', '--include-archived').out;
    assert.equal(parse(shown).done.length, 1);
    assert.match(run('standup', '--include-archived').out, /ship the widget/);
    const current = () => readFileSync(join(vault, 'Projects', 'test-proj', 'Journal', 'CURRENT.md'), 'utf8');
    assert.doesNotMatch(current(), /ship the widget/);
    run('render', '--include-archived');
    assert.match(current(), /ship the widget/);

    assert.equal(run('unarchive', 'Launch', ...MARK).code, 0);
    assert.equal(registry().streams.Launch.status, 'active');
    assert.deepEqual(snap(), before);   // fold, standup and per-stream counts identical
    assert.equal(run('unarchive', 'Launch', ...MARK).code, 1);
});

// ── status --footer ─────────────────────────────────────────────────────────

const sessionNone = () => `**Session:** unavailable (no sessions in ${projects}; set projects_dir)`;

test('status --footer prints one Ledger line per active stream, registry names, and an other line', () => {
    seedRegistry();
    const a = idOf(run('start', 'launch one', '--stream', 'launch', ...MARK).out);
    run('start', 'launch two', '--stream', 'launch-v2', ...MARK);
    run('done', a, ...MARK);
    run('ask', 'which way?', '--stream', 'Maestro', ...MARK);
    run('log', 'stuck on x', '--kind', 'blocked', '--stream', 'Maestro', ...MARK);
    run('start', 'loose end', ...MARK);
    const r = run('status', '--footer');
    assert.equal(r.code, 0, r.err);
    assert.deepEqual(r.out.trim().split('\n'), [
        '**Ledger (Launch):** 1 done today · 1 in flight · 0 awaiting you',
        '**Ledger (Maestro):** 0 done today · 0 in flight · 1 awaiting you · 1 blocked',
        '**Ledger (other):** 0 done today · 1 in flight · 0 awaiting you',
        sessionNone(),
    ]);
});

test('status --footer ends with the Session line for the newest session, and says roll now past the thresholds', () => {
    const turn = (id: string, read: number) => JSON.stringify({ type: 'assistant', timestamp: '2026-10-02T10:00:00Z', message: { id, role: 'assistant', model: 'claude-opus-5-5', usage: { input_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: read, output_tokens: 1 } } });
    writeFileSync(join(projects, 'aaaaaaaa-old.jsonl'), `${turn('o1', 900000)}\n`);
    writeFileSync(join(projects, 'bbbbbbbb-new.jsonl'), `${[1, 2, 3, 4].map((n) => turn(`m${n}`, 100000)).join('\n')}\n`);
    utimesSync(join(projects, 'aaaaaaaa-old.jsonl'), new Date(Date.now() - 60000), new Date(Date.now() - 60000));
    const line = (extra = {}) => spawnSync(process.execPath, [SCRIPT, 'status', '--footer', '--vault', vault, '--project', 'test-proj'], {
        encoding: 'utf8', env: { ...process.env, VAULT_ROOT: '', MAESTRO_PROJECTS_DIR: projects, ...extra },
    }).stdout.trim().split('\n').pop();
    assert.equal(line(), '**Session:** 4 turns (2% of 180 roll) · 100k read/turn');
    assert.equal(line({ MAESTRO_ROLL_TURNS: '4' }), '**Session:** 4 turns (100% of 4 roll) · 100k read/turn · roll now');
    assert.equal(line({ MAESTRO_ROLL_READ_PER_TURN: '100000' }), '**Session:** 4 turns (2% of 180 roll) · 100k read/turn · roll now');
    assert.equal(line({ MAESTRO_ROLL_TURNS: '5' }), '**Session:** 4 turns (80% of 5 roll) · 100k read/turn · roll soon', '80% is past the 60% default');
    assert.equal(line({ MAESTRO_ROLL_READ_PER_TURN: '115000' }), '**Session:** 4 turns (2% of 180 roll) · 100k read/turn · roll soon', '100k is 87% of 115k');
    assert.equal(line({ MAESTRO_ROLL_READ_PER_TURN: '115000', MAESTRO_ROLL_WARN_PCT: '95', MAESTRO_ROLL_AT_PCT: '90' }), '**Session:** 4 turns (2% of 180 roll) · 100k read/turn · roll soon', 'warn >= roll is rejected, so the 60/90 defaults apply');
    assert.equal(line({ MAESTRO_ROLL_READ_PER_TURN: '115000', MAESTRO_ROLL_WARN_PCT: '88', MAESTRO_ROLL_AT_PCT: '95' }), '**Session:** 4 turns (2% of 180 roll) · 100k read/turn', 'configured percents are honoured by the footer');
});

test('status --json carries the footer numbers, and they match what status --footer prints', () => {
    seedRegistry();
    const a = idOf(run('start', 'launch one', '--stream', 'launch', ...MARK).out);
    run('done', a, ...MARK);
    run('ask', 'which way?', '--stream', 'Maestro', ...MARK);
    run('log', 'stuck on x', '--kind', 'blocked', '--stream', 'Maestro', ...MARK);
    run('start', 'loose end', ...MARK);
    const f = parse<{ footer: { ledger: unknown; session: unknown } }>(run('status', '--json').out).footer;
    assert.deepEqual(f.ledger, [
        { name: 'Maestro', done: 0, inflight: 0, queued: 0, awaiting: 1, paste: 0, blocked: 1 },
        { name: 'Launch', done: 1, inflight: 0, queued: 0, awaiting: 0, paste: 0, blocked: 0 },
        { name: 'other', done: 0, inflight: 1, queued: 0, awaiting: 0, paste: 0, blocked: 0 },
    ]);
    assert.deepEqual(f.session, { available: false, unavailable: `no sessions in ${projects}; set projects_dir` });
    const text = run('status', '--footer').out.trim().split('\n');
    assert.equal(text[0], '**Ledger (Maestro):** 0 done today · 0 in flight · 1 awaiting you · 1 blocked');
});

test('status --footer with no streams is the single plain Ledger line, and appends nothing', () => {
    run('start', 'plain', ...MARK);
    const before = readFileSync(join(vault, 'Projects', 'test-proj', 'Journal', 'ledger.jsonl'), 'utf8');
    assert.deepEqual(run('status', '--footer').out.trim().split('\n'), ['**Ledger:** 0 done today · 1 in flight · 0 awaiting you', sessionNone()]);
    assert.equal(readFileSync(join(vault, 'Projects', 'test-proj', 'Journal', 'ledger.jsonl'), 'utf8'), before);
});

// ── queued state ────────────────────────────────────────────────────────────

test('queue "<text>" writes a wip row marked queued with stream and marks, and start <id> promotes it with a promote row', () => {
    seedRegistry();
    const q = run('queue', 'later job', '--stream', 'launch', ...MARK);
    assert.equal(q.code, 0, q.err);
    assert.match(q.out, /^queued {2}\w{4} {2}later job/);
    const id = idOf(q.out);
    const row = must(ledger().find((e) => e.id === id));
    assert.deepEqual([row.kind, row.queued, row.stream, row.model], ['wip', true, 'Launch', 'Test Model']);

    const s = run('start', id, ...MARK);
    assert.equal(s.code, 0, s.err);
    assert.match(s.out, /promoted from queued/);
    const promote = must(ledger().find((e) => e.kind === 'promote'));
    assert.equal(promote.promotes, id);
    assert.equal(ledger().filter((e) => e.kind === 'wip').length, 1, 'promoting opens no new item');
    assert.equal(run('verify').code, 0);
});

test('queue <id> moves an in-flight item to queued, keeps its history, and is idempotent', () => {
    const id = idOf(run('start', 'running job', ...MARK).out);
    const first = run('queue', id, ...MARK);
    assert.equal(first.code, 0, first.err);
    const rows = ledger();
    assert.equal(must(rows.find((e) => e.kind === 'queue')).queues, id);
    assert.equal(must(rows.find((e) => e.id === id)).queued, undefined, 'the original row is not rewritten');
    const again = run('queue', id, ...MARK);
    assert.equal(again.code, 0);
    assert.match(again.out, /already queued/);
    assert.equal(ledger().length, rows.length, 'a second queue writes nothing');
    assert.equal(run('start', id, ...MARK).code, 0);
    const startAgain = run('start', id, ...MARK);
    assert.match(startAgain.out, /already in flight/);
    assert.equal(ledger().filter((e) => e.kind === 'promote').length, 1);
});

test('queue refuses a closed or non-wip item, an unknown id-shaped token, and --kind; --text queues such a word', () => {
    const done = idOf(run('start', 'finished', ...MARK).out);
    run('done', done, ...MARK);
    const ask = idOf(run('ask', 'which way?', ...MARK).out);
    const before = ledger().length;
    assert.equal(run('queue', done, ...MARK).code, 1);
    assert.equal(run('queue', ask, ...MARK).code, 1);
    const typo = run('queue', 'zz99', ...MARK);
    assert.equal(typo.code, 1);
    assert.match(typo.err, /No item with id zz99/);
    assert.equal(run('queue', 'a thing', '--kind', 'note', ...MARK).code, 1);
    assert.equal(run('start', done, ...MARK).code, 1, 'a closed item is not restarted by id');
    assert.equal(ledger().length, before);
    assert.equal(run('queue', '--text', 'zz99', ...MARK).code, 0);
    assert.equal(run('queue', 'docs', ...MARK).code, 0, 'a plain word is text');
});

test('verify flags a queue or promote row whose target does not exist', () => {
    run('queue', 'real', ...MARK);
    writeFileSync(ledgerFile(), `${readFileSync(ledgerFile(), 'utf8')}${JSON.stringify({ id: 'qq01', kind: 'queue', queues: 'nope', text: 'x' })}\n${JSON.stringify({ id: 'qq02', kind: 'promote', promotes: 'gone', text: 'x' })}\n`);
    const r = parse<Doc>(run('verify', '--json').out);
    assert.equal(r.problems.length, 2);
    assert.equal(run('verify').code, 1);
});

test('a queued item is never flagged stale by triage, an in-flight one a day old is', () => {
    const queued = idOf(run('queue', 'to do someday', '--allow-unmarked').out);
    const running = idOf(run('start', 'running', ...MARK).out);
    const rows = readFileSync(ledgerFile(), 'utf8').split('\n').filter(Boolean).map((l) => parse<Out>(l));
    writeFileSync(ledgerFile(), `${rows.map((r) => JSON.stringify({ ...r, date: '2020-01-01' })).join('\n')}\n`);
    const t = parse<Doc>(run('triage', '--json').out);
    const items = Object.values(t.byBox).flat().filter(Boolean) as Out[];
    assert.equal(must(items.find((i) => i.id === queued)).stale, false);
    assert.equal(must(items.find((i) => i.id === running)).stale, true);
});

test('status separates queued from in flight: --json, --footer and the plain text agree, and the to-run meaning is unchanged', () => {
    seedRegistry();
    run('start', 'running now', '--stream', 'launch', ...MARK);
    const parked = idOf(run('start', 'parked later', '--stream', 'launch', ...MARK).out);
    run('queue', parked, ...MARK);
    run('queue', 'never started', '--stream', 'maestro', ...MARK);
    run('queue', 'loose to-do', ...MARK);
    run('ask', 'run this', '--paste', ledgerFile(), '--stream', 'launch', ...MARK);
    const j = parse<Doc>(run('status', '--json').out);
    assert.deepEqual(j.inflight.map((i) => i.text), ['running now']);
    assert.deepEqual(j.queued.map((i) => i.text).sort(), ['loose to-do', 'never started', 'parked later']);
    assert.deepEqual(j.paste.map((i) => i.text), ['run this']);
    const footer = parse<{ footer: { ledger: { name: string; inflight: number; queued: number; paste: number }[] } }>(run('status', '--json').out).footer.ledger;
    assert.deepEqual(footer.map((r) => [r.name, r.inflight, r.queued, r.paste]), [['Launch', 1, 1, 1], ['Maestro', 0, 1, 0], ['other', 0, 1, 0]]);
    assert.deepEqual(run('status', '--footer').out.trim().split('\n').slice(0, 3), [
        '**Ledger (Launch):** 0 done today · 1 in flight · 1 queued · 0 awaiting you · 1 to run',
        '**Ledger (Maestro):** 0 done today · 0 in flight · 1 queued · 0 awaiting you',
        '**Ledger (other):** 0 done today · 0 in flight · 1 queued · 0 awaiting you',
    ]);
    const text = run('status').out;
    assert.match(text, /In flight\n {2}`\w+` running now/);
    assert.match(text, /Queued\n {2}`\w+` parked later/);
    assert.match(text, /1 in flight · 3 queued · 0 awaiting you · 1 to run/);
    run('start', parked, ...MARK);
    assert.deepEqual(parse<Doc>(run('status', '--json').out).inflight.map((i) => i.text).sort(), ['parked later', 'running now']);
});

test('roll keeps queued items open, archives only finished work, and says how many are queued', () => {
    const done = idOf(run('start', 'finished', ...MARK).out);
    run('done', done, ...MARK);
    const later = idOf(run('queue', 'later job', '--stream', 'Launch', ...MARK).out);
    const parked = idOf(run('start', 'parked job', ...MARK).out);
    run('queue', parked, ...MARK);
    const r = run('roll');
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /kept open: 0 in flight, 2 queued, 0 awaiting you/);
    assert.deepEqual(parse<Doc>(run('status', '--json').out).queued.map((i) => i.id).sort(), [later, parked].sort());
    const archive = readFileSync(join(vault, 'Projects', 'test-proj', 'Journal', `${new Date().toISOString().slice(0, 10)}.md`), 'utf8');
    assert.match(archive, /## Queued[^]*later job/, 'the dated note shows what was queued');
    assert.match(readFileSync(join(vault, 'Projects', 'test-proj', 'Journal', 'CURRENT.md'), 'utf8'), /## Queued\n\n- `\w+` later job/);
    assert.equal(run('roll').code, 0, 'a second roll changes nothing about the queue');
    assert.equal(parse<Doc>(run('status', '--json').out).queued.length, 2);
});

test('handoff carries queued items tagged queued, apart from in flight, and the delta reports one that moved', () => {
    seedRegistry();
    const running = idOf(run('start', 'running job', '--stream', 'Launch', ...MARK).out);
    const later = idOf(run('queue', 'later job', '--stream', 'Launch', ...MARK).out);
    assert.equal(run('handoff', '--stream', 'launch', '--delta').code, 0);
    const day = new Date().toISOString().slice(0, 10);
    const full = readFileSync(join(vault, 'Projects', 'test-proj', 'Journal', `HANDOFF-${day}-Launch.md`), 'utf8');
    assert.match(full, new RegExp(`\`${running}\` \\[in flight\\] running job`));
    assert.match(full, new RegExp(`\`${later}\` \\[queued\\] later job`));
    const until = Date.now() + 5; while (Date.now() < until) { /* spin past the marker ms */ }
    run('start', later, ...MARK);
    run('queue', running, ...MARK);
    assert.equal(run('handoff', '--stream', 'launch', '--delta').code, 0);
    const delta = readFileSync(join(vault, 'Projects', 'test-proj', 'Journal', `HANDOFF-${day}b-Launch.md`), 'utf8');
    assert.match(delta, new RegExp(`\`${later}\` \\[in flight\\] later job`));
    assert.match(delta, new RegExp(`\`${running}\` \\[queued\\] running job`));
});

test('triage marks a queued item as not started and keeps it out of the running-agent check; a queued-only stream gets a page', () => {
    run('start', 'running', ...MARK);
    const q = idOf(run('queue', 'to do later', '--stream', 'Solo', '--new-stream', ...MARK).out);
    const t = run('triage');
    assert.match(t.out, new RegExp(`${q} {2}to do later {2}\\[queued: not started\\]`));
    assert.match(t.out, /1 queued to-do\(s\) in box 7 have not started/);
    assert.equal(existsSync(join(vault, 'Projects', 'test-proj', 'Journal', 'Streams', 'Solo.md')), true);
});

// ── model-name registry ─────────────────────────────────────────────────────

const ledgerFile = () => join(vault, 'Projects', 'test-proj', 'Journal', 'ledger.jsonl');
const seedModels = () => {
    mkdirSync(join(vault, 'Projects', 'test-proj'), { recursive: true });
    writeFileSync(registryFile(), JSON.stringify({ models: { 'claude-opus-5-5': { aliases: ['Claude Opus 5.5', 'opus'] } } }));
};
const usedFlags = ['--used', 'skill:the-maestro'];

test('both spellings of a model are written as the canonical id; an unknown model warns and is kept', () => {
    seedModels();
    const a = run('start', 'one', '--model', 'Claude Opus 5.5', ...usedFlags);
    const b = run('start', 'two', '--model', 'opus', ...usedFlags);
    const c = run('start', 'three', '--model', 'claude-opus-5-5', ...usedFlags);
    assert.match(a.err, /normalised model Claude Opus 5\.5 -> claude-opus-5-5/);
    assert.match(b.err, /normalised model opus -> claude-opus-5-5/);
    assert.equal(c.err, '');
    const odd = run('start', 'four', '--model', 'Some Old Model', ...usedFlags);
    assert.equal(odd.code, 0);
    assert.match(odd.err, /unknown model "Some Old Model"/);
    assert.deepEqual(ledger().map((e) => e.model), ['claude-opus-5-5', 'claude-opus-5-5', 'claude-opus-5-5', 'Some Old Model']);
    assert.equal(run('start', 'five', '--model', 'unrecorded', ...usedFlags).err, '');   // sentinels never warn
});

test('usage counts a numeric mark and its string form as one row', () => {
    run('start', 'base', '--model', 'claude-opus-5-5', ...usedFlags);
    const hand = (id: string, used: unknown) => JSON.stringify({ id, kind: 'wip', ts: '2026-10-03T09:00:00Z', date: '2026-10-03', text: `hand ${id}`, used }) + '\n';
    writeFileSync(ledgerFile(), readFileSync(ledgerFile(), 'utf8') + hand('h001', 1) + hand('h002', '1') + hand('h003', [1, '1', 'tool:x']));
    const used = parse<{ used: Record<string, number> }>(run('usage', '--json').out).used;
    assert.equal(used['1'], 4);
    assert.equal(used['tool:x'], 1);
    assert.equal(Object.keys(used).filter((k) => k === '1').length, 1);
});

test('read-time mapping heals old rows without touching the ledger; models check is a dry run', () => {
    run('start', 'legacy', '--model', 'Claude Opus 5.5', ...usedFlags);
    run('start', 'modern', '--model', 'claude-opus-5-5', ...usedFlags);
    const before = readFileSync(ledgerFile(), 'utf8');
    assert.deepEqual(parse(run('usage', '--json').out).model, { 'Claude Opus 5.5': 1, 'claude-opus-5-5': 1 });   // no models section: nothing enforced
    seedModels();
    assert.deepEqual(parse(run('usage', '--json').out).model, { 'claude-opus-5-5': 2 });
    const c = parse(run('models', 'check', '--json').out);
    assert.equal(c.rows, 1);
    assert.deepEqual(c.models.map((m) => [m.model, m.status]).sort(), [['Claude Opus 5.5', 'alias'], ['claude-opus-5-5', 'canonical']]);
    assert.match(run('models', 'check').out, /1 row\(s\) would show under a different model name; nothing appended/);
    assert.equal(readFileSync(ledgerFile(), 'utf8'), before);
});

test('models add is idempotent, refuses alias collisions, and coexists with streams in the one file', () => {
    assert.match(run('models', 'add', 'claude-opus-5-5', '--alias', 'Claude Opus 5.5,opus').out, /added\s+claude-opus-5-5/);
    assert.match(run('models', 'add', 'claude-opus-5-5', '--alias', 'Claude Opus 5.5,opus').out, /unchanged/);
    assert.equal(run('models', 'add', 'other', '--alias', 'opus').code, 1);
    assert.equal(existsSync(registryFile()), true);
    assert.equal(run('start', 'free stream still fine', '--stream', 'Anything', '--model', 'opus', ...usedFlags).code, 0);   // models-only registry does not enforce streams
    assert.equal(run('streams', 'add', 'Launch').code, 0);
    assert.deepEqual(Object.keys(registry()).sort(), ['models', 'streams']);
    assert.deepEqual(registry().models['claude-opus-5-5'].aliases, ['Claude Opus 5.5', 'opus']);
    assert.equal(run('start', 'x', '--stream', 'Nope', '--model', 'opus', ...usedFlags).code, 1);   // now streams are enforced
    assert.match(run('models', 'list').out, /claude-opus-5-5\s+rows 1/);
});

// ── handoff and resume ──────────────────────────────────────────────────────

const runEnvIn = (cwd: string, env: Record<string, string>, ...args: string[]): Run => {
    const r = spawnSync(process.execPath, [SCRIPT, ...args, '--vault', vault, '--project', 'test-proj'], {
        encoding: 'utf8', cwd, env: { ...process.env, VAULT_ROOT: '', MAESTRO_RESUME_GH: 'off', MAESTRO_CONTAINER_ROOT: '', ...env },
    });
    return { code: r.status, out: r.stdout, err: r.stderr };
};
const runEnv = (env: Record<string, string>, ...args: string[]) => runEnvIn(emptyCwd, env, ...args);
const handoffFile = (stream: string) => join(vault, 'Projects', 'test-proj', 'Journal', `HANDOFF-${new Date().toISOString().slice(0, 10)}-${stream}.md`);
const section = (text: string, n: number | string) => text.split(new RegExp(`^## ${n}\\. .*$`, 'm'))[1].split(/^## /m)[0];

function seedHandoff() {
    seedRegistry();
    const wip = idOf(run('start', 'port the fix, see scripts/foo.mjs:12 and PR #123', '--stream', 'Launch', '--repo', 'api', '--ticket', 'api-014', ...MARK).out);
    run('log', 'blocked on the vendor key', '--kind', 'blocked', '--stream', 'Launch', ...MARK);
    const done = idOf(run('start', 'wire the flag', '--stream', 'Launch', ...MARK).out);
    run('done', done, ...MARK);
    run('log', 'lesson: the cause was a stale cache, ruled out the queue', '--stream', 'Launch', ...MARK);
    run('ask', 'ship on Friday?', '--stream', 'Launch', ...MARK);
    run('start', 'other stream work', '--stream', 'Maestro', ...MARK);
    return { wip, done };
}

test('handoff scaffolds the five parts from the ledger for one stream only', () => {
    const { wip } = seedHandoff();
    const r = run('handoff', '--stream', 'launch');
    assert.equal(r.code, 0, r.err);
    const text = readFileSync(handoffFile('Launch'), 'utf8');
    assert.match(text, /^status: draft$/m);
    const s1 = section(text, 1);
    assert.match(s1, new RegExp(`\`${wip}\` \\[in flight\\] port the fix`));
    assert.match(s1, /\[blocked\] blocked on the vendor key/);
    assert.match(s1, /\[done \d{4}-\d\d-\d\d\] wire the flag/);
    assert.doesNotMatch(text, /other stream work/);
    assert.match(section(text, 2), /stale cache, ruled out the queue/);
    const s3 = section(text, 3);
    assert.match(s3, /PRs: #123/);
    assert.match(s3, /Tickets: api-014/);
    assert.match(s3, /Paths: scripts\/foo\.mjs:12/);
    assert.match(section(text, 4), /\[question\] ship on Friday\?/);
    assert.match(section(text, 5), /Author: one concrete first step/);
    assert.match(text, /^## Cleanup candidates\n\n_Run `node scripts\/branch-sweep\.ts`/m);
});

test('handoff --delta: first roll is the full handoff; later rolls write b, c with only what changed since the previous marker', () => {
    const { wip } = seedHandoff();
    const day = new Date().toISOString().slice(0, 10);
    const file = (suffix: string) => join(vault, 'Projects', 'test-proj', 'Journal', `HANDOFF-${day}${suffix}-Launch.md`);
    assert.equal(run('handoff', '--stream', 'launch', '--delta').code, 0);
    const first = readFileSync(file(''), 'utf8');
    assert.match(first, /^generated_at: \d{4}-/m, 'a full handoff carries the marker');
    assert.match(first, /^type: handoff$/m);
    // Work after the first roll: one new item, one completion, one ask. Ledger timestamps are ISO ms, so wait a tick.
    const until = Date.now() + 5; while (Date.now() < until) { /* spin past the marker ms */ }
    const late = idOf(run('start', 'late work after the roll, PR #456', '--stream', 'Launch', ...MARK).out);
    run('done', wip, ...MARK);
    run('log', 'direct done after the roll', '--kind', 'done', '--stream', 'Launch', ...MARK);
    const asked = run('ask', 'merge order after the roll?', '--stream', 'Launch', ...MARK);
    assert.equal(asked.code, 0, asked.err);
    assert.equal(run('handoff', '--stream', 'launch', '--delta').code, 0);
    const second = readFileSync(file('b'), 'utf8');
    assert.match(second, /^type: handoff-delta$/m);
    assert.match(second, new RegExp(`^delta_of: HANDOFF-${day}-Launch$`, 'm'));
    assert.match(second, new RegExp(`\`${late}\` \\[in flight\\] late work after the roll`));
    assert.match(second, new RegExp(`Completed since the previous roll\\n\\n- \`${wip}\` \\[done\\] port the fix`));
    assert.match(second, /Completed since the previous roll[\s\S]*direct done after the roll/);
    assert.match(second, /merge order after the roll\?/);
    assert.match(second, /PRs mentioned\n\n#456/);
    assert.doesNotMatch(second, /wire the flag|ship on Friday/, 'nothing from before the marker is repeated');
    assert.equal(readFileSync(file(''), 'utf8'), first, 'the first handoff is left alone');
    assert.equal(run('handoff', '--stream', 'launch', '--delta', '--next', 'x').code, 1, 'flags a delta would drop are refused');
    // A third roll with nothing new is a delta of the delta: empty sections, suffix c.
    assert.equal(run('handoff', '--stream', 'launch', '--delta').code, 0);
    const third = readFileSync(file('c'), 'utf8');
    assert.match(third, new RegExp(`^delta_of: HANDOFF-${day}b-Launch$`, 'm'));
    assert.doesNotMatch(third, /late work after the roll/);
    // Without --delta the existing refusal to overwrite stands.
    assert.equal(run('handoff', '--stream', 'launch').code, 1);
});

test('handoff --all covers every stream, tags each item with its stream, and writes a draft named all', () => {
    const { wip } = seedHandoff();
    const r = run('handoff', '--all');
    assert.equal(r.code, 0, r.err);
    const text = readFileSync(handoffFile('all'), 'utf8');
    assert.match(text, /^status: draft$/m);
    assert.match(text, /^stream: all$/m);
    assert.match(text, /^# All streams handoff, /m);
    const s1 = section(text, 1);
    assert.match(s1, new RegExp(`\`${wip}\` \\[in flight\\] port the fix.*stream: Launch`));
    assert.match(s1, /other stream work.*stream: Maestro/);
    assert.match(section(text, 4), /\[question\] ship on Friday\?/);
    assert.equal(run('handoff', '--all').code, 1, 'still never overwrites without --force');
    assert.equal(run('handoff', '--all', '--stream', 'Nope', '--force').code, 0, '--all wins over --stream');
});

test('handoff --learn and --next fill sections 2 and 5 on one line each, and leave the placeholders when absent', () => {
    seedHandoff();
    const r = run('handoff', '--all', '--learn', 'ruled out the queue,\nit was the cache', '--next', 'rerun the sweep from the container root');
    assert.equal(r.code, 0, r.err);
    const text = readFileSync(handoffFile('all'), 'utf8');
    const s2 = section(text, 2);
    assert.match(s2, /^- ruled out the queue, it was the cache$/m);
    assert.match(s2, /stale cache, ruled out the queue/, 'ledger matches still follow it');
    assert.equal(section(text, 5).trim(), 'rerun the sweep from the container root');
    run('handoff', '--stream', 'Maestro', '--learn', 'only this');
    const bare = readFileSync(handoffFile('Maestro'), 'utf8');
    assert.equal(section(bare, 2).trim(), '- only this', 'no placeholder once the author wrote one');
    assert.match(section(bare, 5), /Author: one concrete first step/);
});

test('handoff fills Session metrics from the newest session, and says so when there is none', () => {
    seedHandoff();
    assert.match(section2(run('handoff', '--all', '--dry-run').out, 'Session metrics'), /unavailable \(no sessions in /);
    const turn = (id: string) => JSON.stringify({ type: 'assistant', timestamp: '2026-10-02T10:00:00Z', message: { id, role: 'assistant', model: 'claude-opus-5-5', usage: { input_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 100000, output_tokens: 1 } } });
    writeFileSync(join(projects, 'cccccccc-now.jsonl'), `${[1, 2, 3].map((n) => turn(`t${n}`)).join('\n')}\n`);
    assert.match(section2(run('handoff', '--all', '--dry-run').out, 'Session metrics'), /\*\*Session:\*\* 3 turns \(1% of 180 roll\) · 100k read\/turn/);
});

test('handoff --update-context points CONTEXT.md at the new handoff once, replacing an old link, and touches nothing else', () => {
    seedHandoff();
    const ctx = join(tv, 'CONTEXT.md');
    writeFileSync(ctx, '# test-proj\n\nGoals stay as they are.\n');
    const day = new Date().toISOString().slice(0, 10);
    const r = run('handoff', '--all', '--update-context', '--context-file', ctx);
    assert.equal(r.code, 0, r.err);
    assert.equal(readFileSync(ctx, 'utf8'), `# test-proj\n\nLatest handoff: [[HANDOFF-${day}-all]] (${day})\n\nGoals stay as they are.\n`);
    assert.match(run('handoff', '--all', '--force', '--update-context', '--context-file', ctx).out, /already linked/);
    run('handoff', '--stream', 'Maestro', '--update-context', '--context-file', ctx);
    assert.equal(readFileSync(ctx, 'utf8').match(/^Latest handoff:.*$/gm)?.length, 1, 'replaced, not added');
    assert.match(readFileSync(ctx, 'utf8'), /Latest handoff: \[\[HANDOFF-.*-Maestro\]\]/);
    const dry = run('handoff', '--all', '--force', '--dry-run', '--update-context', '--context-file', ctx);
    assert.match(dry.out, /would point/);
    assert.match(readFileSync(ctx, 'utf8'), /-Maestro\]\]/, 'a dry run writes nothing');
    const missing = run('handoff', '--all', '--force', '--update-context', '--context-file', join(tv, 'nope.md'));
    assert.equal(missing.code, 1);
    assert.match(missing.err, /does not exist; the handoff was written/);
    assert.equal(run('handoff', '--all', '--force').code, 0, 'no flag, no link');
    const fm = join(tv, 'FM.md');
    writeFileSync(fm, '---\ntitle: x\n---\nPlain body, no heading.\n');
    run('handoff', '--all', '--force', '--update-context', '--context-file', fm);
    assert.equal(readFileSync(fm, 'utf8'), `---\ntitle: x\n---\nLatest handoff: [[HANDOFF-${day}-all]] (${day})\n\nPlain body, no heading.\n`, 'frontmatter stays first');
});

test('handoff never overwrites without --force, honours --out, and appends nothing to the ledger', () => {
    seedHandoff();
    const before = readFileSync(ledgerFile(), 'utf8');
    assert.equal(run('handoff', '--stream', 'Launch').code, 0);
    writeFileSync(handoffFile('Launch'), 'hand edited');
    const again = run('handoff', '--stream', 'Launch');
    assert.equal(again.code, 1);
    assert.match(again.err, /already exists/);
    assert.equal(readFileSync(handoffFile('Launch'), 'utf8'), 'hand edited');
    assert.equal(run('handoff', '--stream', 'Launch', '--force').code, 0);
    assert.match(readFileSync(handoffFile('Launch'), 'utf8'), /^type: handoff$/m);
    const out = join(vault, 'custom', 'h.md');
    assert.equal(run('handoff', '--stream', 'Launch', '--out', out).code, 0);
    assert.ok(existsSync(out));
    assert.equal(run('handoff', '--stream', 'Nope').code, 1);
    assert.equal(readFileSync(ledgerFile(), 'utf8'), before);
});

test('resume reports missing loops, found loops, gh off or unavailable, and the ListAgents reminder', () => {
    run('start', 'something open', ...MARK);
    const marker = `maestro-resume-marker-${process.pid}`;
    const proc = spawnSync(process.execPath, ['-e', `const {spawn}=require('child_process');const c=spawn(process.execPath,['-e','setTimeout(()=>{},30000)','${marker}'],{detached:true,stdio:'ignore'});c.unref();console.log(c.pid)`], { encoding: 'utf8' });
    const loopPid = Number(proc.stdout.trim());
    try {
        const r = runEnv({ MAESTRO_LOOP_PATTERNS: `${marker}, definitely-not-running-${process.pid}` }, 'resume');
        assert.equal(r.code, 0, r.err);
        assert.match(r.out, /1 in flight/);
        assert.match(r.out, new RegExp(`ok\\s+${marker} \\(pid ${loopPid}`));
        assert.match(r.out, /MISSING\s+definitely-not-running/);
        assert.match(r.out, /skipped: resume_gh is off/);
        assert.match(r.out, /ListAgents is a harness tool, not a shell command/);
    } finally {
        try { process.kill(loopPid); } catch { /* already gone */ }
    }
    const noGh = runEnv({ MAESTRO_RESUME_GH: 'on', PATH: '/nonexistent' }, 'resume');
    assert.equal(noGh.code, 0, noGh.err);
    assert.match(noGh.out, /gh: unavailable/);
    assert.match(noGh.out, /none configured/);
});

// ── backfill ────────────────────────────────────────────────────────────────

function seedBackfill() {
    seedRegistry({ Launch: { aliases: ['launch-v2'], status: 'active' }, Maestro: { aliases: ['orchestrator'], status: 'active' } });
    const day = new Date().toISOString().slice(0, 10);
    const at = (h: number, m = 0) => `${day}T${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:00.000Z`;
    const row = (id: string, h: number, m: number, o: Record<string, unknown>) => JSON.stringify({ id, ts: at(h, m), date: day, kind: 'wip', refs: [], model: 'm', used: ['x'], ...o });
    const rows = [
        // evidence: five tagged Launch items in billing (two on ticket api-1), two tagged Maestro items in one session
        row('t001', 1, 0, { text: 'tagged one', stream: 'Launch', repo: 'billing', ticket: 'api-1' }),
        row('t002', 1, 1, { text: 'tagged two', stream: 'Launch', repo: 'billing', ticket: 'api-1' }),
        row('t003', 1, 2, { text: 'tagged three', stream: 'Launch', repo: 'billing' }),
        row('t004', 1, 3, { text: 'tagged four', stream: 'Launch', repo: 'billing' }),
        row('t005', 1, 4, { text: 'tagged five', stream: 'Launch', repo: 'billing' }),
        row('m001', 5, 0, { text: 'maestro one', stream: 'Maestro', repo: 'tools' }),
        row('m002', 5, 1, { text: 'maestro two', stream: 'Maestro', repo: 'tools' }),
        // untagged items
        row('u001', 3, 0, { text: 'ticket only', ticket: 'api-1' }),                                   // ticket, unanimous: high
        row('u002', 3, 30 + 1, { text: 'launch-v2 rollout note', repo: 'billing' }),                   // keyword + repo: high
        row('u003', 8, 0, { text: 'billing tweak', repo: 'billing' }),                                 // repo alone: medium
        row('u004', 10, 0, { text: 'orchestrator follow-up' }),                                        // keyword alone: medium
        row('u005', 12, 0, { text: 'nothing to go on' }),                                              // no proposal
        row('u006', 5, 10, { text: 'same run as the earlier two' }),                                       // neighbours alone: low
        row('u007', 14, 0, { text: 'launch-v2 but in tools', repo: 'tools' }),                         // keyword Launch vs repo Maestro: conflict, low
    ];
    mkdirSync(join(vault, 'Projects', 'test-proj', 'Journal'), { recursive: true });
    writeFileSync(ledgerFile(), rows.join('\n') + '\n');
}
const bfJson = (...a: string[]) => parse(run('backfill', '--json', ...a).out);

test('backfill dry run proposes streams with confidence levels and appends nothing', () => {
    seedBackfill();
    const before = readFileSync(ledgerFile(), 'utf8');
    const j = bfJson();
    assert.equal(j.untagged, 7);
    assert.equal(j.noProposal, 1);
    assert.deepEqual(j.byConfidence, { high: 2, medium: 2, low: 2 });
    assert.deepEqual(j.byStream.map((s) => [s.stream, s.high, s.medium, s.low]).sort(), [['Launch', 2, 1, 1], ['Maestro', 0, 1, 1]]);
    const text = run('backfill').out;
    assert.match(text, /7 untagged item\(s\); 6 with a proposal, 1 with none\. Nothing appended/);
    assert.match(text, /Launch {2}high 2 · medium 1 · low 1/);
    assert.match(text, /u001 {2}ticket only/);
    assert.equal(run('backfill', '--dry-run').code, 0);
    assert.equal(readFileSync(ledgerFile(), 'utf8'), before);
});

test('backfill --out writes a review table; --apply --min-confidence high appends only high tag events, once', () => {
    seedBackfill();
    const report = join(vault, 'report.md');
    run('backfill', '--out', report);
    const table = readFileSync(report, 'utf8');
    assert.match(table, /\| u001 \|.*\| Launch \| high \| ticket \|/);
    assert.match(table, /\| u002 \|.*\| Launch \| high \| keyword\+repo \|/);
    assert.match(table, /\| u005 \|.*\| {2}\| {2}\| {2}\|/);

    const dry = run('backfill', '--apply', '--min-confidence', 'high', '--dry-run', ...MARK);
    assert.match(dry.out, /2 tag row\(s\).*\(dry-run\)/);
    assert.equal(ledger().length, 14);

    const r = run('backfill', '--apply', '--min-confidence', 'high', ...MARK);
    assert.equal(r.code, 0, r.err);
    const added = ledger().slice(14);
    assert.deepEqual(added.map((e) => [e.kind, e.tags, e.stream, e.confidence, e.prev]), [['tag', 'u001', 'Launch', 'high', null], ['tag', 'u002', 'Launch', 'high', null]]);
    assert.equal(new Set(added.map((e) => e.backfill)).size, 1);
    assert.match(String(added[0]?.backfill), /^bf-/);
    assert.equal(new Set(ledger().map((e) => e.id)).size, ledger().length);
    assert.equal(bfJson().untagged, 5);
    assert.match(run('backfill', '--apply', '--min-confidence', 'high', ...MARK).out, /0 tag row\(s\)/);   // idempotent
    assert.equal(ledger().length, 16);
    assert.equal(run('backfill', '--apply', '--min-confidence', 'bogus', ...MARK).code, 1);
    assert.equal(run('backfill', '--apply', ...['--min-confidence', 'medium']).code, 1);   // apply needs usage marks
});

// ── claims and concurrent writers ───────────────────────────────────────────

const claimsDirPath = () => join(vault, 'Projects', 'test-proj', 'Claims');
const lockFile = (repo: string) => join(claimsDirPath(), `${repo}.lock`);

/** Runs journal.ts asynchronously so several can genuinely overlap. */
const runAsync = (args: string[], extraEnv: Record<string, string> = {}) => new Promise<Run>((resolve) => {
    const p = spawn(process.execPath, [SCRIPT, ...args, '--vault', vault, '--project', 'test-proj'], {
        env: { ...process.env, VAULT_ROOT: '', ...extraEnv }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    let err = '';
    p.stdout.on('data', (d) => { out += d; });
    p.stderr.on('data', (d) => { err += d; });
    p.on('close', (code) => resolve({ code, out, err }));
});

test('concurrent claims on one repo: exactly one wins, the rest name the holder', async () => {
    const results = await Promise.all(Array.from({ length: 8 }, (_, i) => runAsync(['claim', 'repo-x', '--desk', `desk${i}`, ...MARK])));
    const winners = results.map((r, i) => ({ r, i })).filter(({ r }) => r.code === 0);
    assert.equal(winners.length, 1, results.map((r) => r.err).join('\n'));
    const lock = parse(readFileSync(lockFile('repo-x'), 'utf8'));
    assert.equal(lock.desk, `desk${winners[0].i}`);
    for (const r of results.filter((x) => x.code !== 0)) assert.match(r.err, new RegExp(`already claimed by desk ${lock.desk},`));
    assert.equal(ledger().filter((e) => e.kind === 'claim').length, 1);
    assert.equal(must(ledger().find((e) => e.kind === 'claim')).desk, lock.desk);
    assert.deepEqual(readdirSync(claimsDirPath()).filter((n) => n !== 'repo-x.lock'), [], 'losers leave no temp files');
});

test('release is for the holding desk only; --force overrides; both leave a ledger row', () => {
    assert.equal(run('claim', 'repo-y', '--desk', 'alpha', '--branch', 'feat/x', ...MARK).code, 0);
    assert.equal(run('claim', 'repo-y', '--desk', 'beta', ...MARK).code, 1);
    const other = run('release', 'repo-y', '--desk', 'beta', ...MARK);
    assert.equal(other.code, 1);
    assert.match(other.err, /held by desk alpha/);
    assert.equal(run('release', 'repo-y', ...MARK).code, 1);   // no desk, no force
    assert.ok(existsSync(lockFile('repo-y')));
    assert.equal(run('release', 'repo-y', '--desk', 'alpha', ...MARK).code, 0);
    assert.equal(existsSync(lockFile('repo-y')), false);
    assert.equal(run('release', 'repo-y', '--desk', 'alpha', ...MARK).code, 1);   // not claimed any more
    assert.equal(run('claim', 'repo-y', '--desk', 'beta', ...MARK).code, 0);
    assert.equal(run('release', 'repo-y', '--force', ...MARK).code, 0);
    assert.deepEqual(ledger().filter((e) => e.kind === 'claim' || e.kind === 'released').map((e) => [e.kind, e.desk]),
        [['claim', 'alpha'], ['released', 'alpha'], ['claim', 'beta'], ['released', 'beta']]);
    assert.equal(run('claim', '../evil', '--desk', 'alpha', ...MARK).code, 1);
    assert.equal(run('claim', 'repo-z', ...MARK).code, 1);   // needs --desk
});

test('claims lists claims and flags a dead pid and an old claim as stale; claim rows are not items', () => {
    const dead = spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], { encoding: 'utf8' });
    assert.equal(run('claim', 'live', '--desk', 'alpha', '--pid', String(process.pid), ...MARK).code, 0);
    assert.equal(run('claim', 'gone', '--desk', 'alpha', '--pid', dead.stdout, ...MARK).code, 0);
    assert.equal(run('claim', 'nopid', '--desk', 'beta', ...MARK).code, 0);
    const old = parse(readFileSync(lockFile('nopid'), 'utf8'));
    writeFileSync(lockFile('nopid'), JSON.stringify({ ...old, time: new Date(Date.now() - 30 * 36e5).toISOString() }));
    const byRepo = Object.fromEntries(parse(run('claims', '--json').out).claims.map((c) => [c.repo, c]));
    assert.equal(byRepo.live.stale, false);
    assert.equal(byRepo.gone.stale, true);
    assert.match(byRepo.gone.reason, /is not running/);
    assert.equal(byRepo.nopid.stale, true);
    assert.match(byRepo.nopid.reason, /older than 12h/);
    assert.equal(must(parse(run('claims', '--json', '--stale-hours', '48').out).claims.find((c) => c.repo === 'nopid')).stale, false);
    assert.match(run('claims').out, /gone {2}desk alpha.*STALE \(pid \d+ is not running\)/);
    assert.deepEqual([statusJson().inflight, statusJson().awaiting], [[], []]);
    assert.equal(run('claims', '--vault', mkdtempSync(join(tmpdir(), 'empty-'))).out.trim(), 'No claims.');
});

test('concurrent appends: N processes x M rows all parse, with unique ids and the full count', async () => {
    const N = 4;
    const M = 25;
    const workers = Array.from({ length: N }, (_, w) => new Promise<{ code: number | null; err: string }>((resolve) => {
        const script = `const {spawnSync}=require('child_process');for(let i=0;i<${M};i++){const r=spawnSync(process.execPath,[${JSON.stringify(SCRIPT)},'log','w${w}-'+i,'--vault',${JSON.stringify(vault)},'--project','test-proj','--model','m','--used','tool:t'],{encoding:'utf8',env:{...process.env,VAULT_ROOT:''}});if(r.status!==0){console.error(r.stderr);process.exit(1)}}`;
        const p = spawn(process.execPath, ['-e', script], { stdio: ['ignore', 'ignore', 'pipe'] });
        let err = '';
        p.stderr.on('data', (d) => { err += d; });
        p.on('close', (code) => resolve({ code, err }));
    }));
    const results = await Promise.all(workers);
    results.forEach((r) => assert.equal(r.code, 0, r.err));
    const lines = readFileSync(ledgerFile(), 'utf8').split('\n').filter(Boolean);
    assert.equal(lines.length, N * M);
    const rows = lines.map((l) => parse(l));   // throws on any torn or interleaved line
    assert.equal(new Set(rows.map((r) => r.id)).size, N * M);
    assert.equal(new Set(rows.map((r) => r.text)).size, N * M);
});

// ── verify and the roll auto-commit ─────────────────────────────────────────

test('verify passes a clean ledger and reports every kind of problem with a non-zero exit', () => {
    const a = idOf(run('start', 'one', ...MARK).out);
    run('done', a, ...MARK);
    const clean = run('verify');
    assert.equal(clean.code, 0);
    assert.match(clean.out, /verify: 2 row\(s\), 0 problem\(s\)/);
    const rows = [
        { id: 'zzz1', ts: 't', date: 'd', kind: 'done', closes: 'nope', text: 'closes a ghost' },
        { id: a, ts: 't', date: 'd', kind: 'note', text: 'duplicate id' },
        { id: 'zzz2', ts: 't', date: 'd', kind: 'carry', carries: 'ghost2', stream: 'S', text: 'x' },
        { id: 'zzz3', ts: 't', date: 'd', kind: 'archive', stream: 'S', ids: [a, 'ghost3'], text: 'x' },
    ];
    writeFileSync(ledgerFile(), readFileSync(ledgerFile(), 'utf8') + rows.map((r) => JSON.stringify(r)).join('\n') + '\nnot json at all\n');
    const bad = run('verify');
    assert.equal(bad.code, 1);
    assert.match(bad.out, /5 problem\(s\)/);
    assert.match(bad.out, /closes refers to nope, which does not exist/);
    assert.match(bad.out, new RegExp(`duplicate id \\(first on line 1\\)`));
    assert.match(bad.out, /carries refers to ghost2/);
    assert.match(bad.out, /archive ids refers to ghost3/);
    assert.match(bad.out, /line 7: line does not parse/);
    const j = parse(run('verify', '--json').out);
    assert.equal(j.problems.length, 5);
    assert.equal(run('verify', '--vault', mkdtempSync(join(tmpdir(), 'empty-'))).code, 0);   // no ledger yet is not a problem
});

const gitEnv = { GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null', GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.com' };
const git = (cwd: string, ...a: string[]) => spawnSync('git', ['-C', cwd, ...a], { encoding: 'utf8', env: { ...process.env, ...gitEnv } });

test('roll commits the changed ledger files when ledger_git_autocommit is on, by explicit path, and honours .gitignore', () => {
    git(vault, 'init', '-q');
    writeFileSync(join(vault, '.gitignore'), '**/Index/*.sqlite\n');
    mkdirSync(join(vault, 'Projects', 'test-proj', 'Index'), { recursive: true });
    writeFileSync(join(vault, 'Projects', 'test-proj', 'Index', 'maestro.sqlite'), 'binary');
    const id = idOf(run('start', 'ship it', ...MARK).out);
    run('done', id, ...MARK);
    const r = runEnv({ ...gitEnv, MAESTRO_LEDGER_GIT_AUTOCOMMIT: 'on' }, 'roll');
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /ledger git: committed \d+ path\(s\)/);
    const day = new Date().toISOString().slice(0, 10);
    assert.equal(git(vault, 'log', '-1', '--format=%s').stdout.trim(), `chore(ledger): roll ${day}`);
    const files = git(vault, 'show', '--name-only', '--format=', 'HEAD').stdout.trim().split('\n').sort();
    assert.deepEqual(files, [
        '.gitignore', `Projects/test-proj/Journal/${day}.md`, 'Projects/test-proj/Journal/CURRENT.md', 'Projects/test-proj/Journal/ledger.jsonl',
    ].sort());
    assert.equal(git(vault, 'status', '--porcelain').stdout.trim(), '');
    assert.match(runEnv({ ...gitEnv, MAESTRO_LEDGER_GIT_AUTOCOMMIT: 'on' }, 'roll').out, /committed \d+ path\(s\)/);   // a re-roll appends a row, so it commits again
    assert.equal(git(vault, 'rev-list', '--count', 'HEAD').stdout.trim(), '2');
});

test('roll does not commit when the config is off, the root is not a repo, or verify fails', () => {
    const id = idOf(run('start', 'a', ...MARK).out);
    run('done', id, ...MARK);
    // off (the default): a repo exists but nothing is committed
    git(vault, 'init', '-q');
    assert.equal(runEnv(gitEnv, 'roll').code, 0);
    assert.notEqual(git(vault, 'rev-parse', '--verify', '-q', 'HEAD').status, 0);
    // on, but verify fails: no commit, non-zero exit
    writeFileSync(ledgerFile(), readFileSync(ledgerFile(), 'utf8') + 'garbage\n');
    const bad = runEnv({ ...gitEnv, MAESTRO_LEDGER_GIT_AUTOCOMMIT: 'on' }, 'roll', '--date', new Date().toISOString().slice(0, 10));
    assert.equal(bad.code, 1);
    assert.match(bad.err, /Not committing: verify found 1 problem/);
    assert.notEqual(git(vault, 'rev-parse', '--verify', '-q', 'HEAD').status, 0);
    // on, but the ledger root is not a git repo (a plain dir inside another repo does not count either)
    const plain = mkdtempSync(join(tmpdir(), 'plain-'));
    const p = spawnSync(process.execPath, [SCRIPT, 'start', 'x', '--vault', plain, '--project', 'test-proj', ...MARK], { encoding: 'utf8', env: { ...process.env, VAULT_ROOT: '' } });
    const pid = p.stdout.trim().split(/\s+/)[1];
    spawnSync(process.execPath, [SCRIPT, 'done', pid, '--vault', plain, '--project', 'test-proj', ...MARK], { encoding: 'utf8', env: { ...process.env, VAULT_ROOT: '' } });
    const nr = spawnSync(process.execPath, [SCRIPT, 'roll', '--vault', plain, '--project', 'test-proj'], { encoding: 'utf8', env: { ...process.env, VAULT_ROOT: '', ...gitEnv, MAESTRO_LEDGER_GIT_AUTOCOMMIT: 'on' } });
    assert.equal(nr.status, 0, nr.stderr);
    assert.match(nr.stderr, /not a git repository root; not committing/);
});

// ── per-stream views ────────────────────────────────────────────────────────

const streamPage = (name: string) => join(vault, 'Projects', 'test-proj', 'Journal', 'Streams', `${name}.md`);
const currentMd = () => readFileSync(join(vault, 'Projects', 'test-proj', 'Journal', 'CURRENT.md'), 'utf8');

test('render writes one page per active stream and CURRENT.md stays the combined board, linking each page', () => {
    seedRegistry({ Launch: { aliases: [], status: 'active' }, Maestro: { aliases: [], status: 'active' }, Quiet: { aliases: [], status: 'active' } });
    const a = idOf(run('start', 'launch work', '--stream', 'Launch', ...MARK).out);
    run('start', 'launch two', '--stream', 'Launch', ...MARK);
    run('log', 'launch blocker', '--kind', 'blocked', '--stream', 'Launch', ...MARK);
    const d = idOf(run('start', 'finished thing', '--stream', 'Launch', ...MARK).out);
    run('done', d, ...MARK);
    run('ask', 'maestro question?', '--stream', 'Maestro', ...MARK);
    run('start', 'loose', ...MARK);
    const r = run('render');
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /3 stream page\(s\)/);

    const launch = readFileSync(streamPage('Launch'), 'utf8');
    assert.match(launch, /^stream: Launch$/m);
    assert.match(section2(launch, 'In flight'), new RegExp(`\`${a}\` launch work`));
    assert.match(section2(launch, 'In flight'), /launch two/);
    assert.match(section2(launch, 'Blocked'), /launch blocker/);
    assert.match(section2(launch, 'Done today'), /finished thing/);
    assert.match(section2(launch, 'Awaiting you'), /_none_/);
    assert.doesNotMatch(launch, /maestro question|loose/);
    assert.match(section2(readFileSync(streamPage('Maestro'), 'utf8'), 'Awaiting you'), /maestro question\?/);
    assert.match(readFileSync(streamPage('Quiet'), 'utf8'), /## In flight\n\n_none_/);

    const cur = currentMd();   // still the whole board, grouped by stream, with links
    assert.match(cur, /# Launch\n\nStream page: \[\[Streams\/Launch\]\]/);
    assert.match(cur, /# Maestro\n\nStream page: \[\[Streams\/Maestro\]\]/);
    assert.match(cur, /launch work/);
    assert.match(cur, /maestro question\?/);
    assert.match(cur, /loose/);
    assert.equal(existsSync(join(vault, 'Projects', 'test-proj', 'Journal', 'Streams', 'Other.md')), false);
});
const section2 = (text: string, title: string) => text.split(new RegExp(`^## ${title}.*$`, 'm'))[1].split(/^## /m)[0];

test('an archived stream gets a page that links its retro; the ledger stays one file', () => {
    seedRegistry();
    const id = idOf(run('start', 'the work', '--stream', 'Launch', ...MARK).out);
    run('done', id, ...MARK);
    runT('retro', 'Launch');
    const path = retroPath('Launch');
    writeFileSync(path, readFileSync(path, 'utf8').replace('status: draft', 'status: reviewed').replace(/Promoted to: $/gm, 'Promoted to: one-off'));
    assert.equal(runT('archive', 'Launch', ...MARK).code, 0);
    const page = readFileSync(streamPage('Launch'), 'utf8');
    assert.match(page, /\*\*archived\*\*/);
    assert.match(page, new RegExp(`Retro: \\[\\[Launch-retro-\\d{4}-\\d\\d-\\d\\d\\]\\] \\(${path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\)`));
    assert.doesNotMatch(page, /the work/);
    assert.match(currentMd(), /## Archived streams\n\n- \[\[Streams\/Launch\]\]/);
    assert.equal(runT('unarchive', 'Launch', ...MARK).code, 0);
    assert.doesNotMatch(readFileSync(streamPage('Launch'), 'utf8'), /archived\*\*/);
    assert.deepEqual(readdirSync(join(vault, 'Projects', 'test-proj', 'Journal')).filter((n) => n.endsWith('.jsonl')), ['ledger.jsonl']);
});

// ── approvals ───────────────────────────────────────────────────────────────

test('log --approval records the field, scope and ref on a decision row', () => {
    const r = run('log', 'may resolve declined bot threads', '--kind', 'decision', '--approval', 'standing', '--scope', 'bot threads only', '--ref', 'memory/bot-threads.md', ...MARK);
    assert.equal(r.code, 0);
    const row = must(ledger().find((e) => e.id === idOf(r.out)));
    assert.equal(row.approval, 'standing');
    assert.equal(row.scope, 'bot threads only');
    assert.deepEqual(row.refs, ['memory/bot-threads.md']);
});

test('log rejects an invalid --approval value and writes nothing', () => {
    const r = run('log', 'x', '--kind', 'decision', '--approval', 'forever', ...MARK);
    assert.equal(r.code, 1);
    assert.match(r.err, /standing, one-off/);
    assert.throws(() => ledger());
    assert.equal(run('log', 'x', '--kind', 'decision', '--approval', ...MARK).code, 1);
    assert.equal(run('log', 'x', '--kind', 'decision', '--scope', 'orphan', ...MARK).code, 1);
});

test('resolve accepts --approval when the user answers an ask with one', () => {
    const q = idOf(run('ask', 'retarget #3934?', ...MARK).out);
    assert.equal(run('resolve', q, '--answer', 'yes, retarget #3934', '--approval', 'one-off', ...MARK).code, 0);
    assert.equal(must(ledger().find((e) => e.closes === q)).approval, 'one-off');
    const q2 = idOf(run('ask', 'another?', ...MARK).out);
    assert.equal(run('resolve', q2, '--approval', 'bogus', ...MARK).code, 1);
});

test('approve-tag marks an existing decision without rewriting the ledger', () => {
    const id = idOf(run('log', 'merge base into my branches', '--kind', 'decision', ...MARK).out);
    const before = readFileSync(join(vault, 'Projects', 'test-proj', 'Journal', 'ledger.jsonl'), 'utf8');
    const r = run('approve-tag', id, '--approval', 'standing', '--scope', 'own branches', '--ref', 'memory/x.md', ...MARK);
    assert.equal(r.code, 0);
    const after = readFileSync(join(vault, 'Projects', 'test-proj', 'Journal', 'ledger.jsonl'), 'utf8');
    assert.ok(after.startsWith(before));   // append-only
    const tag = must(ledger().find((e) => e.kind === 'approval-tag'));
    assert.deepEqual([tag.approves, tag.approval, tag.scope, tag.refs], [id, 'standing', 'own branches', ['memory/x.md']]);
    assert.equal(run('approve-tag', 'nope00', '--approval', 'standing', ...MARK).code, 1);
    assert.equal(run('approve-tag', id, '--approval', 'sometimes', ...MARK).code, 1);
    assert.equal(run('approve-tag', id, ...MARK).code, 1);
    assert.doesNotMatch(run('status').out, /approval standing/);   // a tag row is not a work item
});

test('approve-tag only accepts decision, resolved and question rows', () => {
    const wip = idOf(run('log', 'building', '--kind', 'wip', ...MARK).out);
    const done = idOf(run('log', 'shipped', '--kind', 'done', ...MARK).out);
    const dropped = idOf(run('log', 'gave up', '--kind', 'dropped', ...MARK).out);
    const q = idOf(run('ask', 'retarget?', ...MARK).out);
    const decision = idOf(run('log', 'use sqlite', '--kind', 'decision', ...MARK).out);
    const resolved = idOf(run('resolve', q, '--answer', 'yes', ...MARK).out);
    for (const id of [decision, resolved]) assert.equal(run('approve-tag', id, '--approval', 'one-off', ...MARK).code, 0, id);
    const tag = must(ledger().find((e) => e.kind === 'approval-tag')).id;
    for (const id of [wip, done, dropped, tag].map(String)) {
        const r = run('approve-tag', id, '--approval', 'one-off', ...MARK);
        assert.equal(r.code, 1, id);
        assert.match(r.err, /can be approved/);
    }
    const q2 = idOf(run('ask', 'still open?', ...MARK).out);
    assert.equal(run('approve-tag', q2, '--approval', 'one-off', ...MARK).code, 0);
});

test('verify flags an approval-tag that points at a kind that cannot be approved', () => {
    const done = idOf(run('log', 'shipped', '--kind', 'done', ...MARK).out);
    const path = join(vault, 'Projects', 'test-proj', 'Journal', 'ledger.jsonl');
    writeFileSync(path, `${readFileSync(path, 'utf8')}${JSON.stringify({ id: 'bad3', kind: 'approval-tag', approves: done, approval: 'standing' })}\n`);
    const v = run('verify');
    assert.equal(v.code, 1);
    assert.match(v.out, /approves .*a done row/);
});

test('--approval is rejected on every kind except decision and resolved', () => {
    for (const kind of ['note', 'wip', 'done', 'question', 'blocked', 'dropped']) {
        assert.equal(run('log', 'x', '--kind', kind, '--approval', 'standing', ...MARK).code, 1, kind);
    }
    assert.throws(() => ledger());
    const w = idOf(run('log', 'task', '--kind', 'wip', ...MARK).out);
    assert.equal(run('done', w, '--approval', 'one-off', ...MARK).code, 1);
    assert.equal(run('drop', w, '--approval', 'one-off', ...MARK).code, 1);
    assert.equal(run('log', 'x', '--kind', 'decision', '--approval', 'standing', ...MARK).code, 0);
});

test('verify accepts approval rows and flags a bad value or a dangling approves', () => {
    const id = idOf(run('log', 'ok', '--kind', 'decision', '--approval', 'one-off', ...MARK).out);
    run('approve-tag', id, '--approval', 'standing', ...MARK);
    assert.equal(run('verify').code, 0);
    const path = join(vault, 'Projects', 'test-proj', 'Journal', 'ledger.jsonl');
    writeFileSync(path, `${readFileSync(path, 'utf8')}${JSON.stringify({ id: 'bad1', kind: 'decision', text: 't', approval: 'forever' })}\n${JSON.stringify({ id: 'bad2', kind: 'approval-tag', approves: 'ghost', approval: 'standing' })}\n`);
    const v = run('verify');
    assert.equal(v.code, 1);
    assert.match(v.out, /approval "forever" is not one of/);
    assert.match(v.out, /approves refers to ghost/);
});

// ── approvals digest ────────────────────────────────────────────────────────

const daysAgo = (n: number): string => new Date(Date.now() - n * 86400000).toISOString().slice(0, 10);
const digestPath = join(tmpdir(), `approvals-${process.pid}.md`);
const digest = (...a: string[]) => run('approvals', '--tickets-vault', tv, ...a);
const jsonDigest = (...a: string[]) => parse(digest('--json', ...a).out);

function seedApprovals() {
    const mk = (text: string, date: string, ...extra: string[]) => idOf(run('log', text, '--kind', 'decision', '--date', date, ...extra, ...MARK).out);
    const standing = mk('may resolve declined bot threads', daysAgo(1), '--approval', 'standing', '--scope', 'bot threads', '--ref', 'memory/bot.md');
    const oneOff = mk('yes, retarget #3934', daysAgo(1), '--approval', 'one-off');
    const untagged = mk('use sqlite for the index', daysAgo(1));
    const old = mk('old standing grant', daysAgo(30), '--approval', 'standing');
    return { standing, oneOff, untagged, old };
}

test('approvals groups standing, one-off and untagged decisions, including retro-tags', () => {
    const ids = seedApprovals();
    const retro = idOf(run('log', 'merge base into my branches', '--kind', 'decision', '--date', daysAgo(2), ...MARK).out);
    run('approve-tag', retro, '--approval', 'standing', '--scope', 'own branches', ...MARK);
    const g = jsonDigest('--days', '7');
    assert.deepEqual(g.standing.map((a) => a.id).sort(), [ids.standing, retro].sort());
    assert.deepEqual(g.oneOff.map((a) => a.id), [ids.oneOff]);
    assert.deepEqual(g.untagged.map((a) => a.id), [ids.untagged]);
    assert.equal(must(g.standing.find((a) => a.id === retro)).scope, 'own branches');
    assert.deepEqual(must(g.standing.find((a) => a.id === ids.standing)).refs, ['memory/bot.md']);
});

test('a decision closed with an approval is not also listed as untagged', () => {
    const d = idOf(run('log', 'retarget #3934?', '--kind', 'decision', '--date', daysAgo(1), ...MARK).out);
    assert.equal(run('resolve', d, '--approval', 'one-off', ...MARK).code, 0);
    const closer = must(ledger().find((e) => e.closes === d));
    assert.equal(closer.approval, 'one-off');
    const g = jsonDigest('--days', '7');
    assert.deepEqual(g.oneOff.map((a) => a.id), [closer.id]);
    assert.ok(!g.untagged.some((a) => a.id === d));
});

test('a later tag overrides only the fields it sets', () => {
    const id = idOf(run('log', 'merge base into my branches', '--kind', 'decision', '--date', daysAgo(1), ...MARK).out);
    run('approve-tag', id, '--approval', 'standing', '--scope', 'own branches', '--ref', 'memory/a.md', ...MARK);
    run('approve-tag', id, '--approval', 'one-off', ...MARK);
    let row = must(jsonDigest('--days', '7').oneOff.find((a) => a.id === id));
    assert.deepEqual([row.scope, row.refs], ['own branches', ['memory/a.md']]);
    run('approve-tag', id, '--approval', 'one-off', '--scope', 'only this PR', '--ref', 'memory/b.md', ...MARK);
    row = must(jsonDigest('--days', '7').oneOff.find((a) => a.id === id));
    assert.deepEqual([row.scope, row.refs], ['only this PR', ['memory/b.md']]);
});

test('approvals --days and --since set the window; an old row that is retro-tagged now comes in', () => {
    const ids = seedApprovals();
    assert.ok(!jsonDigest('--days', '7').standing.some((a) => a.id === ids.old));
    assert.ok(jsonDigest('--days', '60').standing.some((a) => a.id === ids.old));
    assert.ok(jsonDigest('--since', daysAgo(40)).standing.some((a) => a.id === ids.old));
    assert.equal(digest('--days', '0').code, 1);
    const oldDecision = idOf(run('log', 'ancient decision', '--kind', 'decision', '--date', daysAgo(90), ...MARK).out);
    run('approve-tag', oldDecision, '--approval', 'one-off', ...MARK);
    assert.ok(jsonDigest('--days', '7').oneOff.some((a) => a.id === oldDecision));
    assert.equal(digest('--since', 'yesterday').code, 1);
    assert.equal(digest('--days', 'x').code, 1);
});

test('--days N covers exactly N days ending today, so weekly digests do not overlap', () => {
    const mk = (n: number) => idOf(run('log', `grant ${n} days ago`, '--kind', 'decision', '--date', daysAgo(n), '--approval', 'one-off', ...MARK).out);
    const [today0, six, seven] = [mk(0), mk(6), mk(7)];
    const ids = jsonDigest('--days', '7').oneOff.map((a) => a.id);
    assert.ok(ids.includes(today0) && ids.includes(six));
    assert.ok(!ids.includes(seven));
    assert.deepEqual(jsonDigest('--days', '1').oneOff.map((a) => a.id), [today0]);
    assert.equal(jsonDigest('--days', '7').since, daysAgo(6));
});

test('approvals names the digest after the ISO week of the window end, not today', () => {
    const r = digest('--since', '2026-01-05', '--until', '2026-01-11');
    assert.equal(r.code, 0);
    assert.deepEqual(readdirSync(join(tv, 'Projects', 'test-proj', 'Reviews')), ['approvals-2026-W02.md']);
    assert.match(readFileSync(join(tv, 'Projects', 'test-proj', 'Reviews', 'approvals-2026-W02.md'), 'utf8'), /week: 2026-W02\n/);
    assert.equal(jsonDigest('--since', '2025-12-22', '--until', '2025-12-28').week, '2025-W52');
    assert.equal(digest('--until', 'soon').code, 1);
});

test('approvals writes the review doc with frontmatter and review lines, and never overwrites without --force', () => {
    const ids = seedApprovals();
    const before = ledger().length;
    const r = digest('--days', '7', '--out', digestPath);
    assert.equal(r.code, 0);
    const doc = readFileSync(digestPath, 'utf8');
    assert.match(doc, /^---\ntype: review\nstatus: draft\nweek: \d{4}-W\d{2}\n/);
    assert.match(doc, /## Standing approvals/);
    assert.match(doc, /may resolve declined bot threads/);
    assert.match(doc, /- Scope: bot threads/);
    assert.match(doc, /- Ref: memory\/bot\.md/);
    assert.ok(doc.includes(`- Source row: \`${ids.standing}\``));
    assert.match(doc, /- \[ \] keep {2}- \[ \] narrow {2}- \[ \] revoke/);
    assert.match(doc, /## One-off approvals[\s\S]*yes, retarget #3934/);
    assert.match(doc, /## Untagged decisions[\s\S]*use sqlite for the index/);
    assert.doesNotMatch(doc, /old standing grant/);
    assert.equal(ledger().length, before);   // the digest appends nothing
    const again = digest('--days', '7', '--out', digestPath);
    assert.equal(again.code, 1);
    assert.match(again.err, /already exists/);
    assert.equal(digest('--days', '7', '--out', digestPath, '--force').code, 0);
});

test('approvals default path is Projects/<project>/Reviews/approvals-<ISO week>.md under the tickets vault', () => {
    seedApprovals();
    const r = digest('--days', '7');
    assert.equal(r.code, 0);
    const files = readdirSync(join(tv, 'Projects', 'test-proj', 'Reviews'));
    assert.equal(files.length, 1);
    assert.match(files[0], /^approvals-\d{4}-W\d{2}\.md$/);
});

test('approvals rejects a window whose --since is after --until', () => {
    const r = digest('--since', '2026-01-11', '--until', '2026-01-05');
    assert.equal(r.code, 1);
    assert.match(r.out + (r.err || ''), /after --until/);
    assert.equal(digest('--since', '2026-01-05', '--until', '2026-01-05').code, 0);
});

const IMPOSSIBLE_DATES = [['--since', '2026-02-30'], ['--since', '2026-02-31'], ['--until', '2026-02-30'], ['--until', '2026-04-31']];
for (const [flag, value] of IMPOSSIBLE_DATES) {
    test(`approvals rejects the impossible date ${flag} ${value}`, () => {
        assert.equal(digest(flag, value).code, 1);
    });
}

test('approvals rejects a bare --until instead of meaning today', () => {
    assert.equal(digest('--days', '7', '--until').code, 1);
    assert.equal(digest('--until').code, 1);
});

test('a grant that is both resolved with --approval and approve-tagged is listed once, latest approval winning', () => {
    const q = idOf(run('log', 'retarget #3934?', '--kind', 'question', '--date', daysAgo(1), ...MARK).out);
    assert.equal(run('resolve', q, '--approval', 'one-off', '--scope', 'this PR', ...MARK).code, 0);
    assert.equal(run('approve-tag', q, '--approval', 'standing', ...MARK).code, 0);
    const g = jsonDigest('--days', '7');
    const all = [...g.standing, ...g.oneOff];
    assert.equal(all.length, 1);
    assert.equal(g.standing.length, 1);
    assert.equal(g.standing[0].scope, 'this PR');
});

// ── roll sweeps stale worktrees ─────────────────────────────────────────────

/** A container holding one repo cloned from a bare origin, with a clean and a dirty detached worktree outside the container. */
function sweepWorld(ignoreFiles = '') {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'roll-sweep-')));
    const git = (cwd: string, ...a: string[]) => { const r = spawnSync('git', ['-C', cwd, '-c', 'user.email=me@example.com', '-c', 'user.name=T', '-c', 'core.hooksPath=/dev/null', ...a], { encoding: 'utf8' }); assert.equal(r.status, 0, r.stderr); return r.stdout.trim(); };
    git(root, 'init', '-q', '--bare', '-b', 'main', 'origin.git');
    mkdirSync(join(root, 'box'));
    git(root, 'clone', '-q', join(root, 'origin.git'), join(root, 'box', 'proj'));
    const repo = join(root, 'box', 'proj');
    writeFileSync(join(repo, 'a.txt'), 'a\n'); git(repo, 'add', 'a.txt'); git(repo, 'commit', '-q', '-m', 'init');
    if (ignoreFiles) { writeFileSync(join(repo, '.gitignore'), ignoreFiles); git(repo, 'add', '.gitignore'); git(repo, 'commit', '-q', '-m', 'chore: ignore'); }
    git(repo, 'branch', 'develop'); git(repo, 'push', '-q', 'origin', 'main', 'develop'); git(repo, 'remote', 'set-head', 'origin', 'main');
    const clean = join(root, 'clean'); const dirty = join(root, 'dirty');
    git(repo, 'worktree', 'add', '-q', '--detach', clean, 'origin/develop');
    git(repo, 'worktree', 'add', '-q', '--detach', dirty, 'origin/develop');
    writeFileSync(join(dirty, 'wip.txt'), 'unsaved\n');
    // Past the idle window (60 min by default), so only the rules under test decide.
    const old = new Date(Date.now() - 3 * 36e5);
    for (const wt of [clean, dirty]) {
        const gd = git(wt, 'rev-parse', '--absolute-git-dir');
        for (const p of [wt, join(gd, 'HEAD'), join(gd, 'index'), join(gd, 'logs', 'HEAD')]) if (existsSync(p)) utimesSync(p, old, old);
    }
    return { container: join(root, 'box'), clean, dirty };
}

test('roll removes a stale worktree without asking, keeps dirty ones with the reason, and a second roll is a no-op', () => {
    const w = sweepWorld();
    const env = { MAESTRO_CONTAINER_ROOT: w.container };
    const first = runEnvIn(w.container, env, 'roll');
    assert.equal(first.code, 0, first.err);
    assert.match(first.out, new RegExp(`removed +${w.clean}`));
    assert.match(first.out, /kept +1  untracked files/);
    assert.match(runEnvIn(w.container, env, 'roll', '--verbose').out, new RegExp(`kept +${w.dirty} .*untracked files`));
    assert.match(first.out, /worktrees: 1 removed, 0 pruned, 1 kept\./);
    assert.deepEqual([existsSync(w.clean), existsSync(w.dirty)], [false, true]);
    assert.match(runEnvIn(w.container, env, 'roll').out, /worktrees: 0 removed, 0 pruned, 1 kept\./);
});

test('roll asks once to move a real env file into the store, names only, and removes the worktree after it is a store link', () => {
    const w = sweepWorld('.env*\n');
    const store = join(dirname(w.container), 'env-store'); mkdirSync(join(store, 'proj', 'alpha'), { recursive: true });
    const envFile = join(w.clean, '.env'); writeFileSync(envFile, 'FAKE_SENTINEL=sentinel-not-a-secret\n');
    const aged = new Date(Date.now() - 3 * 36e5); utimesSync(w.clean, aged, aged); // writing the file touched the directory; only the env file may keep it
    const env = { MAESTRO_CONTAINER_ROOT: w.container, MAESTRO_ENV_STORE_ROOT: store };
    const first = runEnvIn(w.container, env, 'roll');
    assert.equal(first.code, 0, first.err);
    assert.match(first.out, new RegExp(`asked +${w.clean}: move \\.env into the env store`));
    const asks = ledger().filter((e) => e.kind === 'question');
    assert.equal(asks.length, 1);
    assert.match(asks[0].text ?? '', new RegExp(`Env files stop the sweep: proj worktree ${w.clean} holds real env file\\(s\\) \\.env, .*env-store-move\\.ts' '${w.clean}' '\\.env' PROJECT`));
    assert.equal(asks[0].repo, 'proj');
    assert.doesNotMatch(readFileSync(join(vault, 'Projects', 'test-proj', 'Journal', 'ledger.jsonl'), 'utf8'), /sentinel-not-a-secret/);
    assert.equal(existsSync(w.clean), true);
    runEnvIn(w.container, env, 'roll');
    assert.equal(ledger().filter((e) => e.kind === 'question').length, 1, 'the same question is not raised twice');
    // the user moves it: the worktree now holds a link into the store
    const target = join(store, 'proj', 'alpha', '.env'); writeFileSync(target, 'FAKE_KEY=not-a-secret\n');
    rmSync(envFile); symlinkSync(target, envFile);
    const old = new Date(Date.now() - 3 * 36e5); utimesSync(w.clean, old, old); // the move touched the directory; let the idle window pass again
    assert.match(runEnvIn(w.container, env, 'roll').out, new RegExp(`removed +${w.clean}`));
    assert.equal(existsSync(w.clean), false);
    assert.equal(readFileSync(target, 'utf8'), 'FAKE_KEY=not-a-secret\n');
});

test('roll sweeps the configured root even when run from a subdirectory of it', () => {
    const w = sweepWorld();
    const r = runEnvIn(join(w.container, 'proj'), { MAESTRO_CONTAINER_ROOT: w.container }, 'roll');
    assert.match(r.out, new RegExp(`removed +${w.clean}`));
    assert.equal(existsSync(w.clean), false);
});

test('roll refuses to sweep from a directory outside the configured root, and still rolls', () => {
    const w = sweepWorld();
    run('start', 'finished thing', ...MARK);
    const r = runEnvIn(emptyCwd, { MAESTRO_CONTAINER_ROOT: w.container }, 'roll');
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /worktree sweep refused: .* is outside container_root/);
    assert.doesNotMatch(r.out, /worktrees:/);
    assert.deepEqual([existsSync(w.clean), existsSync(w.dirty)], [true, true]);
    const viaFlag = runEnvIn(w.container, { MAESTRO_CONTAINER_ROOT: w.container }, 'roll', '--container', emptyCwd);
    assert.match(viaFlag.out, /worktree sweep refused: .* is outside container_root/);
    assert.equal(existsSync(w.clean), true);
});

test('roll refuses to sweep when no container root is configured, and still rolls', () => {
    const w = sweepWorld();
    const r = runEnvIn(w.container, {}, 'roll');
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /worktree sweep refused: container_root is not set/);
    assert.doesNotMatch(r.out, /worktrees:/);
    assert.deepEqual([existsSync(w.clean), existsSync(w.dirty)], [true, true]);
});

test('roll --dry-run and --no-worktree-sweep leave every worktree in place', () => {
    const w = sweepWorld();
    const env = { MAESTRO_CONTAINER_ROOT: w.container };
    assert.match(runEnvIn(w.container, env, 'roll', '--dry-run').out, /would remove +\S+clean/);
    assert.doesNotMatch(runEnvIn(w.container, env, 'roll', '--no-worktree-sweep').out, /worktrees:|refused/);
    assert.deepEqual([existsSync(w.clean), existsSync(w.dirty)], [true, true]);
});

test('roll archives and commits the ledger before it sweeps, and a --fast roll sweeps nothing', () => {
    const w = sweepWorld();
    git(vault, 'init', '-q');
    run('done', idOf(run('start', 'ship it', ...MARK).out), ...MARK);
    const env = { ...gitEnv, MAESTRO_CONTAINER_ROOT: w.container, MAESTRO_LEDGER_GIT_AUTOCOMMIT: 'on' };
    const fast = runEnvIn(w.container, env, 'roll', '--fast');
    assert.equal(fast.code, 0, fast.err);
    assert.match(fast.out, /archived 1 finished item/);
    assert.doesNotMatch(fast.out, /worktrees:|removed +/);
    assert.deepEqual([existsSync(w.clean), existsSync(w.dirty)], [true, true]);
    const full = runEnvIn(w.container, env, 'roll');
    const at = (re: RegExp) => full.out.search(re);
    assert.ok(at(/archived|Nothing finished/) >= 0 && at(/ledger git:/) >= 0 && at(/worktrees:/) >= 0, full.out);
    assert.ok(at(/archived|Nothing finished/) < at(/ledger git:/) && at(/ledger git:/) < at(/removed +/), full.out);
    assert.equal(existsSync(w.clean), false);
});

test('roll --fast skips the scratch review too', () => {
    const shelf = mkdtempSync(join(tmpdir(), 'journal-shelf-'));
    mkdirSync(join(shelf, 'scratch'));
    writeFileSync(join(shelf, 'scratch', 'tally.sh'), '# tally the rows\n');
    assert.match(runEnv({ MAESTRO_SCRIPTS_DIR: shelf }, 'roll').out, /tally\.sh/);
    assert.doesNotMatch(runEnv({ MAESTRO_SCRIPTS_DIR: shelf }, 'roll', '--fast').out, /tally\.sh/);
});

test('handoff --all summarises the sweep as counts by reason, and --verbose lists each kept worktree', () => {
    const w = sweepWorld();
    run('start', 'port the fix', ...MARK, '--stream', 'Launch', '--new-stream');
    const env = { MAESTRO_CONTAINER_ROOT: w.container };
    const counts = runEnvIn(w.container, env, 'handoff', '--all', '--dry-run').out;
    assert.match(counts, /Worktree sweep \(dry run\): 1 would be removed, 0 pruned, 1 kept\./);
    assert.match(counts, /^- untracked files: 1$/m);
    assert.doesNotMatch(counts, new RegExp(w.dirty));
    assert.match(runEnvIn(w.container, env, 'handoff', '--all', '--verbose', '--dry-run').out, new RegExp(`- \`${w.dirty}\` \\(proj\\): .*untracked files`));
    assert.match(runEnvIn(w.container, env, 'handoff', '--stream', 'Launch', '--dry-run').out, new RegExp(`- \`${w.dirty}\``), 'one stream keeps the per-worktree list');
    assert.deepEqual([existsSync(w.clean), existsSync(w.dirty)], [true, true]);
});

test('handoff lists the worktrees a sweep would keep under Cleanup candidates, and removes nothing', () => {
    const w = sweepWorld();
    run('start', 'port the fix', ...MARK, '--stream', 'Launch', '--new-stream');
    const r = runEnvIn(w.container, { MAESTRO_CONTAINER_ROOT: w.container }, 'handoff', '--stream', 'Launch', '--dry-run');
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, new RegExp(`## Cleanup candidates[^]*- \`${w.dirty}\` \\(proj\\): .*untracked files`));
    assert.doesNotMatch(r.out, new RegExp(`- \`${w.clean}\``));
    assert.deepEqual([existsSync(w.clean), existsSync(w.dirty)], [true, true]);
});

// ── rules, pending decisions and the status header (MAESTRO-13) ─────────────

test('a decision is a record: log --kind decision never shows as awaiting', () => {
    assert.equal(run('log', 'Jack rule: always squash', '--kind', 'decision', ...MARK).code, 0);
    assert.deepEqual(statusJson().awaiting, []);
    assert.doesNotMatch(run('status').out, /Awaiting you/);
    assert.deepEqual(run('status', '--footer').out.split('\n')[0], '**Ledger:** 0 done today · 0 in flight · 0 awaiting you');
});

test('ask --kind decision is pending: it shows as awaiting until resolved', () => {
    const r = run('ask', 'ship on Friday or Monday?', '--kind', 'decision', ...MARK);
    assert.equal(r.code, 0, r.err);
    const id = idOf(r.out);
    assert.deepEqual(statusJson().awaiting.map((i) => i.id), [id]);
    assert.equal(must(ledger().find((e) => e.id === id)).pending, true);
    run('resolve', id, '--answer', 'Monday', ...MARK);
    assert.deepEqual(statusJson().awaiting, []);
});

test('ask takes only question or decision', () => {
    const r = run('ask', 'misfiled', '--kind', 'note', ...MARK);
    assert.equal(r.code, 1);
    assert.match(r.err, /ask takes --kind question/);
    assert.throws(() => ledger());
});

// ── ask fields: recommend, default, door, decide-by, class (the-maestro-094, 098) ──

test('ask stores its decision fields on the row and the fold exposes them', () => {
    const r = run('ask', 'use the nightly window?', '--recommend', 'Yes, 01:00 to 03:00', '--door', 'two-way', '--default', 'apply the window', '--decide-by', '2d', '--class', 'intangible', ...MARK);
    assert.equal(r.code, 0, r.err);
    assert.equal(r.err, '', 'a complete ask warns about nothing');
    const row = must(ledger().find((e) => e.id === idOf(r.out)));
    assert.deepEqual([row.recommend, row.door, row.default, row.class], ['Yes, 01:00 to 03:00', 'two-way', 'apply the window', 'intangible']);
    assert.match(String(row.by), /^\d{4}-\d{2}-\d{2}$/);
    const item = must(statusJson().awaiting.find((i) => i.id === row.id));
    assert.equal(item.door, 'two-way');
    assert.equal(item.default, 'apply the window');
});

test('ask without --recommend or --door warns naming each flag, still writes, and defaults the class to standard', () => {
    const r = run('ask', 'which way?', ...MARK);
    assert.equal(r.code, 0);
    assert.match(r.err, /no --recommend/);
    assert.match(r.err, /no --door/);
    const row = must(ledger().find((e) => e.id === idOf(r.out)));
    assert.equal(row.class, 'standard');
    assert.equal(row.door, undefined);
});

test('a one-way ask can never carry a default: refused with nothing written', () => {
    for (const args of [['--door', 'one-way', '--default', 'merge it'], ['--default', 'merge it']]) {
        const r = run('ask', 'merge to staging?', '--recommend', 'wait', ...args, ...MARK);
        assert.equal(r.code, 1, args.join(' '));
        assert.match(r.err, /default/);
    }
    assert.throws(() => ledger(), 'no ledger file: nothing was written');
});

test('ask refuses a bad door, class or decide-by, and a decide-by in the past', () => {
    for (const args of [['--door', 'sideways'], ['--class', 'urgent'], ['--decide-by', 'someday'], ['--decide-by', '2020-01-01'], ['--decide-by', '-1d']]) {
        const r = run('ask', 'q?', '--recommend', 'r', ...(args[0] === '--door' ? [] : ['--door', 'two-way']), ...args, ...MARK);
        assert.equal(r.code, 1, args.join(' '));
    }
    assert.throws(() => ledger());
});

test('--by is an alias of --decide-by, and relative hours store an instant', () => {
    const r = run('ask', 'q?', '--recommend', 'r', '--door', 'two-way', '--by', '6h', ...MARK);
    assert.equal(r.code, 0, r.err);
    assert.match(String(must(ledger()[0]).by), /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
});

test('a paste ask takes no decision fields and warns about none', () => {
    const block = join(vault, 'block.txt');
    mkdirSync(vault, { recursive: true });
    writeFileSync(block, 'echo hi\n');
    const bad = run('ask', 'run this', '--paste', block, '--recommend', 'r', ...MARK);
    assert.equal(bad.code, 1);
    assert.match(bad.err, /run-this block/);
    const ok = run('ask', 'run this', '--paste', block, ...MARK);
    assert.equal(ok.code, 0);
    assert.equal(ok.err, '');
    assert.equal(must(ledger()[0]).class, undefined);
});

test('the decision flags are refused on any command but ask', () => {
    const r = run('log', 'a note', '--door', 'two-way', ...MARK);
    assert.equal(r.code, 1);
    assert.match(r.err, /only go on `ask`/);
    assert.equal(run('start', 'work', '--recommend', 'x', ...MARK).code, 1);
});

test('ask --help prints the usage and needs no ledger', () => {
    const r = run('ask', '--help');
    assert.equal(r.code, 0);
    for (const flag of ['--recommend', '--door', '--default', '--decide-by', '--class']) assert.match(r.out, new RegExp(flag));
    assert.throws(() => ledger());
});

test('ask rows written before the fields existed still read, resolve and verify', () => {
    mkdirSync(join(vault, 'Projects', 'test-proj', 'Journal'), { recursive: true });
    writeFileSync(join(vault, 'Projects', 'test-proj', 'Journal', 'ledger.jsonl'), `${JSON.stringify({ id: 'oldq', ts: '2026-09-01T10:00:00.000Z', date: '2026-09-01', kind: 'question', text: 'old style ask?', model: 'x', used: ['x'] })}\n`);
    const item = must(statusJson().awaiting.find((i) => i.id === 'oldq'));
    assert.equal(item.door, undefined);
    assert.match(run('status').out, /old style ask\? — model: x · used: x/);
    assert.equal(run('verify').code, 0);
    assert.equal(run('resolve', 'oldq', '--answer', 'fine', ...MARK).code, 0);
    assert.deepEqual(statusJson().awaiting, []);
});

test('rule with an existing ref file writes a closed-off decision carrying the absolute ref', () => {
    const memo = join(tv, 'memory.md');
    writeFileSync(memo, '# rule\n');
    const r = run('rule', 'always branch from staging', '--ref', memo, ...MARK);
    assert.equal(r.code, 0, r.err);
    const row = ledger()[0];
    assert.deepEqual([row.kind, row.refs, row.pending], ['decision', [memo], undefined]);
    assert.deepEqual(statusJson().awaiting, []);
});

test('rule refuses, writing nothing, when the ref is missing, absent, or not a file', () => {
    const missing = run('rule', 'a rule', '--ref', join(tv, 'nope.md'), ...MARK);
    assert.equal(missing.code, 1);
    assert.match(missing.err, /not an existing file/);
    const absent = run('rule', 'a rule', ...MARK);
    assert.equal(absent.code, 1);
    assert.match(absent.err, /needs --ref/);
    const dirRef = run('rule', 'a rule', '--ref', tv, ...MARK);
    assert.equal(dirRef.code, 1);
    const urlRef = run('rule', 'a rule', '--ref', 'https://example.com/x', ...MARK);
    assert.equal(urlRef.code, 1);
    assert.throws(() => ledger(), 'no ledger file was created');
});

test('rule needs every ref to exist, not just the first', () => {
    const memo = join(tv, 'memory.md');
    writeFileSync(memo, 'x');
    assert.equal(run('rule', 'a rule', '--ref', `${memo},${join(tv, 'gone.md')}`, ...MARK).code, 1);
    assert.throws(() => ledger());
});

test('rule can carry an approval, and the approvals digest sees it', () => {
    const memo = join(tv, 'memory.md');
    writeFileSync(memo, 'x');
    assert.equal(run('rule', 'may delete merged branches', '--ref', memo, '--approval', 'standing', '--scope', 'merged only', ...MARK).code, 0);
    const d = parse(run('approvals', '--json').out);
    assert.equal(d.standing.length, 1);
    assert.equal(d.untagged.length, 0);
});

test('status names the unstreamed section "other" once streams exist, and the total line counts blocked', () => {
    run('start', 'streamed work', ...MARK, '--stream', 'Launch', '--new-stream');
    run('start', 'loose work', ...MARK);
    run('log', 'waiting on a deploy', '--kind', 'blocked', ...MARK);
    const out = run('status').out;
    assert.match(out, /== Launch ==[^]*== other ==[^]*loose work/);
    assert.match(out, /0 done · 2 in flight · 0 awaiting you · 1 blocked/);
    assert.ok(out.indexOf('streamed work') < out.indexOf('== other =='));
});

test('status prints no "other" heading when there are no streams, and no blocked count when none are blocked', () => {
    run('start', 'plain work', ...MARK);
    const out = run('status').out;
    assert.doesNotMatch(out, /== other ==/);
    assert.match(out, /0 done · 1 in flight · 0 awaiting you\n?$/);
});

test('rule resolves a relative ref against the cwd, and the digest leaves pending decisions out of "untagged"', () => {
    writeFileSync(join(emptyCwd, 'rel-memory.md'), 'x');
    assert.equal(run('rule', 'relative ref rule', '--ref', 'rel-memory.md', ...MARK).code, 0);
    assert.equal(ledger()[0]?.refs?.[0], join(realpathSync(emptyCwd), 'rel-memory.md'));
    run('ask', 'still open?', '--kind', 'decision', ...MARK);
    const untagged = parse(run('approvals', '--json').out).untagged.map((u) => u.text);
    assert.deepEqual(untagged, ['relative ref rule']);
});

// ── boxes, triage, roll --strict, ask --paste (MAESTRO-14) ──────────────────

const blockFile = (name = 'block.sh') => { const f = join(tv, name); writeFileSync(f, 'echo hi\n'); return f; };
const triageJson = (...a: string[]) => parse(run('triage', '--json', ...a).out);
const boxIds = (t: Doc, box: number) => (t.byBox[box] || []).map((i) => i.text);

function triageWorld() {
    const memo = blockFile('memory.md');
    run('rule', 'Jack rule: branch from staging', '--ref', memo, ...MARK);
    run('log', 'Jack rule: no merge on red', '--kind', 'decision', ...MARK);
    run('log', 'may delete merged branches', '--kind', 'decision', '--approval', 'standing', ...MARK);
    run('log', 'close one PR', '--kind', 'decision', '--approval', 'one-off', '--ref', memo, ...MARK);
    run('ask', 'Ship Friday or Monday, which one?', ...MARK);
    run('ask', 'run the read-only count query', '--paste', blockFile(), ...MARK);
    run('start', 'building the thing', ...MARK);
    run('log', 'waiting on a deploy', '--kind', 'blocked', ...MARK);
    run('log', 'follow-up: fix the cwd default next session', ...MARK);
    run('log', 'follow-up: tracked in the-maestro-016', ...MARK);
    run('log', 'learned that the cause was the cwd', ...MARK);
    run('log', 'posted reply', ...MARK);
    return { memo };
}

test('triage boxes every item by kind, text and approval, and says what it would do', () => {
    triageWorld();
    const t = triageJson();
    assert.deepEqual(boxIds(t, 1), ['Jack rule: branch from staging', 'Jack rule: no merge on red']);
    assert.deepEqual(boxIds(t, 2), ['may delete merged branches']);
    assert.deepEqual(boxIds(t, 3), ['close one PR']);
    assert.deepEqual(boxIds(t, 4), ['Ship Friday or Monday, which one?']);
    assert.deepEqual(boxIds(t, 5), ['run the read-only count query']);
    assert.deepEqual([boxIds(t, 6), boxIds(t, 7)], [['waiting on a deploy'], ['building the thing']]);
    assert.deepEqual(boxIds(t, 8), ['follow-up: fix the cwd default next session']);
    assert.deepEqual(boxIds(t, 9), ['learned that the cause was the cwd']);
    assert.deepEqual(boxIds(t, 11), ['follow-up: tracked in the-maestro-016', 'posted reply']);
    const text = run('triage').out;
    assert.match(text, /Box 4 Needs Jack \(1\)/);
    assert.match(text, /Box 1 Decisions \/ rules \(2\)[^]*NO REF/);
    assert.match(text, /Don't-miss checklist[^]*\[ \] Every rule or approval/);
});

test('triage blockers are unpromoted rules and unticketed findings, and triage itself writes nothing', () => {
    triageWorld();
    const before = ledger().length;
    const t = triageJson();
    assert.deepEqual(t.blockers.map((b) => b.why).sort(), ['finding with no ticket', 'not promoted: no --ref that is an existing file', 'not promoted: no --ref that is an existing file']);
    assert.equal(run('triage').code, 0);
    assert.equal(ledger().length, before);
});

test('a pending decision is Needs Jack, not a rule', () => {
    run('ask', 'adopt the new schema?', '--kind', 'decision', ...MARK);
    assert.deepEqual(boxIds(triageJson(), 4), ['adopt the new schema?']);
});

test('triage --apply closes only the rules and approvals whose ref is an existing file, by appending resolved rows', () => {
    const { memo } = triageWorld();
    const before = ledger();
    const r = run('triage', '--apply');
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /closed 2 recorded item\(s\); 2 still need a ref file/);
    const added = ledger().slice(before.length);
    assert.equal(added.length, 2);
    assert.ok(added.every((e) => e.kind === 'resolved' && e.text === `recorded → ${memo}` && e.refs?.[0] === memo));
    assert.deepEqual(before, ledger().slice(0, before.length), 'append-only: existing rows untouched');
    const t = triageJson();
    assert.deepEqual(boxIds(t, 1), ['Jack rule: no merge on red']);
    assert.deepEqual(boxIds(t, 3), []);
    assert.deepEqual(boxIds(t, 2), ['may delete merged branches']);
});

test('triage --apply is idempotent and --dry-run writes nothing', () => {
    triageWorld();
    const before = ledger().length;
    assert.equal(run('triage', '--apply', '--dry-run').code, 0);
    assert.equal(ledger().length, before);
    run('triage', '--apply');
    const after = ledger().length;
    assert.match(run('triage', '--apply').out, /closed 0 recorded/);
    assert.equal(ledger().length, after);
});

test('a ref that stops existing is not a promotion: triage --apply leaves the item open', () => {
    const memo = blockFile('gone-soon.md');
    run('rule', 'a rule', '--ref', memo, ...MARK);
    rmSync(memo);
    assert.match(run('triage', '--apply').out, /closed 0 recorded item\(s\); 1 still need/);
});

test('roll --strict refuses before changing anything; plain roll warns and carries on', () => {
    triageWorld();
    const id = idOf(run('start', 'finished work', ...MARK).out);
    run('done', id, ...MARK);
    const rows = ledger().length;
    const strict = run('roll', '--strict');
    assert.equal(strict.code, 1);
    assert.match(strict.err, /roll --strict refused: triage has 3 blocker/);
    assert.equal(ledger().length, rows, 'no rolled row');
    assert.equal(existsSync(join(vault, 'Projects', 'test-proj', 'Journal', `${new Date().toISOString().slice(0, 10)}.md`)), false);
    const plain = run('roll');
    assert.equal(plain.code, 0, plain.err);
    assert.match(plain.out, /warning: triage has 3 blocker\(s\)/);
    assert.ok(ledger().some((e) => e.kind === 'rolled'));
});

test('roll --strict passes once the blockers are fixed', () => {
    const memo = blockFile('memory.md');
    run('rule', 'Jack rule: x', '--ref', memo, ...MARK);
    const id = idOf(run('start', 'finished work', ...MARK).out);
    run('done', id, ...MARK);
    assert.equal(run('roll', '--strict').code, 0);
});

test('ask --paste needs an existing block file and writes nothing otherwise', () => {
    const missing = run('ask', 'run this', '--paste', join(tv, 'nope.sh'), ...MARK);
    assert.equal(missing.code, 1);
    assert.match(missing.err, /not an existing file/);
    assert.equal(run('ask', 'run this', '--paste', ...MARK).code, 1);
    assert.equal(run('ask', 'decide', '--kind', 'decision', '--paste', blockFile(), ...MARK).code, 1);
    assert.throws(() => ledger());
});

test('paste asks show apart from the questions in status, the footer and CURRENT.md', () => {
    const f = blockFile();
    run('ask', 'which way?', ...MARK);
    run('ask', 'run the count', '--paste', f, ...MARK);
    const s = run('status').out;
    assert.match(s, /Awaiting you\n  `\w+` which way\?[^]*Paste blocks for you\n  `\w+` run the count .*block: /);
    assert.doesNotMatch(s.split('Paste blocks for you')[0], /run the count/);
    assert.match(s, /0 done · 0 in flight · 1 awaiting you · 1 to run/);
    assert.match(run('status', '--footer').out.split('\n')[0], /1 awaiting you · 1 to run/);
    const j = statusJson();
    assert.deepEqual([j.awaiting.length, j.paste.length, j.paste[0].paste], [1, 1, f]);
    const cur = readFileSync(join(vault, 'Projects', 'test-proj', 'Journal', 'CURRENT.md'), 'utf8');
    assert.match(cur, /## Paste blocks for you\n\n- `\w+` run the count/);
});

test('handoff section 4 is generated from the Needs-Jack and paste boxes, text plus options and the block file', () => {
    const f = blockFile();
    run('ask', 'Ship Friday or Monday?', '--stream', 'Launch', '--new-stream', ...MARK);
    run('ask', 'run the count query', '--paste', f, '--stream', 'Launch', ...MARK);
    run('rule', 'a rule that is not awaiting', '--ref', f, '--stream', 'Launch', ...MARK);
    const out = run('handoff', '--stream', 'Launch', '--dry-run', '--no-worktree-sweep').out;
    const sec = out.split('## 4. Decisions awaiting')[1].split('## 5.')[0];
    assert.match(sec, /\*\*Needs Jack\*\*[^]*Ship Friday or Monday\?/);
    assert.match(sec, new RegExp(`\\*\\*Paste blocks for Jack\\*\\*[^]*run the count query.*block: ${f.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
    assert.doesNotMatch(sec, /not awaiting/);
});

test('triage --apply never closes a question on its wording, even with a ref file', () => {
    const memo = blockFile('plan.md');
    const id = idOf(run('ask', 'Jack: which branch ships first, A or B', '--ref', memo, ...MARK).out);
    assert.deepEqual(boxIds(triageJson(), 4), ['Jack: which branch ships first, A or B']);
    assert.match(run('triage', '--apply').out, /closed 0 recorded/);
    assert.deepEqual(statusJson().awaiting.map((i) => i.id), [id]);
});

test('triage --apply only closes decisions dated on --date, whatever --since says', () => {
    const memo = blockFile('memory.md');
    run('rule', 'an old rule', '--ref', memo, '--date', '2020-01-01', ...MARK);
    assert.match(run('triage', '--apply', '--since', '2019-01-01').out, /closed 0 recorded/);
    assert.deepEqual(boxIds(triageJson('--since', '2019-01-01'), 1), ['an old rule']);
});

test('handoff section 4 keeps every open question: one boxed as a rule by its approval still appears under Needs Jack', () => {
    const id = idOf(run('ask', 'Jack: pick a stream name', '--stream', 'Launch', '--new-stream', ...MARK).out);
    run('approve-tag', id, '--approval', 'one-off');
    const sec = run('handoff', '--stream', 'Launch', '--dry-run', '--no-worktree-sweep').out.split('## 4. Decisions awaiting')[1].split('## 5.')[0];
    assert.match(sec, /\*\*Needs Jack\*\*[^]*pick a stream name/);
});

// ── prime, gates, defer (MAESTRO-15) ────────────────────────────────────────

const inDays = (n: number): string => new Date(Date.now() + n * 864e5).toISOString().slice(0, 10);

/** A fake `gh` on PATH answering `pr view <n> --repo <r> --json ...` from the env var STUB_STATE (a bare state, or 'fail'). */
function ghStubDir() {
    const dir = mkdtempSync(join(tmpdir(), 'journal-gh-'));
    writeFileSync(join(dir, 'gh'), `#!${process.execPath}\nconst s = process.env.STUB_STATE || 'OPEN';\nif (process.argv[2] === 'pr' && process.argv[3] === 'list') { console.log('[]'); process.exit(0); }\nif (s === 'fail') { console.error('boom'); process.exit(1); }\nconsole.log(JSON.stringify({ state: s, mergedAt: s === 'MERGED' ? '2026-10-02T00:00:00Z' : null, args: process.argv.slice(2) }));\n`, { mode: 0o755 });
    return dir;
}

test('--gate is validated before anything is written, and only goes on blocked rows', () => {
    for (const bad of ['gh:pr:repo', 'gh:pr:repo#x', 'date:2026-02-30', 'date:tomorrow', 'ticket:', 'nope', 'ticket:a b']) {
        const r = run('log', 'waiting', '--kind', 'blocked', '--gate', bad, ...MARK);
        assert.equal(r.code, 1, bad);
        assert.match(r.err, /--gate/);
    }
    assert.equal(run('log', 'waiting', '--kind', 'note', '--gate', 'date:2099-01-01', ...MARK).code, 1);
    assert.equal(run('log', 'waiting', '--kind', 'blocked', '--gate', ...MARK).code, 1);
    assert.throws(() => ledger(), 'nothing was written');
    for (const ok of ['gh:pr:owner/repo#12', 'gh:pr:repo#3', 'date:2099-01-01', 'ticket:the-maestro-013']) {
        assert.equal(run('log', 'waiting', '--kind', 'blocked', '--gate', ok, ...MARK).code, 0, ok);
    }
    assert.equal(ledger().length, 4);
    assert.match(run('status').out, /waiting .*gate: ticket:the-maestro-013/);
});

test('resume reports date gates as waiting or cleared, and never writes', () => {
    const past = idOf(run('log', 'wait for the date', '--kind', 'blocked', '--gate', `date:${inDays(-1)}`, ...MARK).out);
    const future = idOf(run('log', 'wait longer', '--kind', 'blocked', '--gate', `date:${inDays(5)}`, ...MARK).out);
    const none = idOf(run('log', 'no gate here', '--kind', 'blocked', ...MARK).out);
    const before = readFileSync(join(vault, 'Projects', 'test-proj', 'Journal', 'ledger.jsonl'), 'utf8');
    const out = runEnv({}, 'resume').out;
    assert.match(out, new RegExp(`CLEARED\\s+${past} .*has arrived`));
    assert.match(out, new RegExp(`waiting\\s+${future} .*until ${inDays(5)}`));
    assert.match(out, new RegExp(`resolve ${past} --answer`));
    assert.doesNotMatch(out, new RegExp(`(CLEARED|waiting|UNKNOWN)\\s+${none}`));
    assert.equal(readFileSync(join(vault, 'Projects', 'test-proj', 'Journal', 'ledger.jsonl'), 'utf8'), before);
});

test('resume checks gh pr gates through gh pr view: merged clears, open waits, closed or failing is unknown', () => {
    const id = idOf(run('log', 'hold for the PR', '--kind', 'blocked', '--gate', 'gh:pr:owner/repo#42', ...MARK).out);
    const dir = ghStubDir();
    const env = (state: string) => ({ MAESTRO_RESUME_GH: 'on', PATH: `${dir}:${process.env.PATH}`, STUB_STATE: state });
    assert.match(runEnv(env('MERGED'), 'resume').out, new RegExp(`CLEARED\\s+${id} .*owner/repo#42 merged`));
    assert.match(runEnv(env('OPEN'), 'resume').out, new RegExp(`waiting\\s+${id} .*owner/repo#42 is open`));
    assert.match(runEnv(env('CLOSED'), 'resume').out, new RegExp(`UNKNOWN\\s+${id} .*closed without merging`));
    assert.match(runEnv(env('fail'), 'resume').out, new RegExp(`UNKNOWN\\s+${id} .*gh could not say`));
    assert.match(runEnv({ ...env('MERGED'), MAESTRO_RESUME_GH: 'off' }, 'resume').out, new RegExp(`UNKNOWN\\s+${id}`), 'resume_gh off makes no gh call');
    assert.match(runEnv({ MAESTRO_RESUME_GH: 'on', PATH: '/nonexistent' }, 'resume').out, new RegExp(`UNKNOWN\\s+${id}`));
});

test('resume checks ticket gates against the tickets vault', () => {
    mkdirSync(join(tv, 'Projects', 'p1', 'Tickets'), { recursive: true });
    const ticket = (id: string, status: string) => writeFileSync(join(tv, 'Projects', 'p1', 'Tickets', `${id}.md`), `---\nid: "${id}"\ntitle: "T"\nstatus: "${status}"\n---\nbody\n`);
    ticket('p1-001', 'closed');
    ticket('p1-002', 'open');
    const a = idOf(run('log', 'wait on 001', '--kind', 'blocked', '--gate', 'ticket:p1-001', ...MARK).out);
    const b = idOf(run('log', 'wait on 002', '--kind', 'blocked', '--gate', 'ticket:p1-002', ...MARK).out);
    const c = idOf(run('log', 'wait on 003', '--kind', 'blocked', '--gate', 'ticket:p1-003', ...MARK).out);
    const out = runEnv({}, 'resume', '--tickets-vault', tv).out;
    assert.match(out, new RegExp(`CLEARED\\s+${a} .*p1-001 is closed`));
    assert.match(out, new RegExp(`waiting\\s+${b} .*p1-002 is open`));
    assert.match(out, new RegExp(`UNKNOWN\\s+${c} .*status unavailable`));
    assert.match(runEnv({}, 'resume').out, new RegExp(`UNKNOWN\\s+${a}`), 'no tickets vault: unknown, not a crash');
});

test('defer hides an open item from status, the footer and prime until its date, and refuses bad input', () => {
    const id = idOf(run('start', 'after the push', ...MARK).out);
    run('start', 'still on the board', ...MARK);
    assert.equal(run('defer', id, '--until', inDays(-1), ...MARK).code, 1);
    assert.equal(run('defer', id, '--until', 'soon', ...MARK).code, 1);
    assert.equal(run('defer', id, ...MARK).code, 1);
    assert.equal(run('defer', 'zzzz', '--until', inDays(3), ...MARK).code, 1);
    const done = idOf(run('start', 'finished', ...MARK).out);
    run('done', done, ...MARK);
    assert.equal(run('defer', done, '--until', inDays(3), ...MARK).code, 1);
    const rows = ledger().length;
    const r = run('defer', id, '--until', inDays(3), ...MARK);
    assert.equal(r.code, 0, r.err);
    assert.equal(ledger().length, rows + 1);
    assert.equal(ledger().at(-1)?.kind, 'defer');
    assert.deepEqual(statusJson().inflight.map((i) => i.text), ['still on the board']);
    assert.match(run('status', '--footer').out.split('\n')[0], /1 in flight/);
    assert.doesNotMatch(run('prime').out, /after the push/);
    assert.match(run('prime').out, /1 deferred item\(s\) hidden/);
    assert.match(run('triage').out, new RegExp(`${id} .*deferred until ${inDays(3)}`));
    assert.equal(run('verify').code, 0);
});

test('a deferral that has reached its date no longer hides the item, and a later defer moves the date', () => {
    const id = idOf(run('start', 'comes back', ...MARK).out);
    const file = join(vault, 'Projects', 'test-proj', 'Journal', 'ledger.jsonl');
    writeFileSync(file, `${readFileSync(file, 'utf8')}${JSON.stringify({ id: 'dd01', ts: new Date().toISOString(), date: '2020-01-01', kind: 'defer', defers: id, until: inDays(0), text: 'old', model: 'm', used: ['x'] })}\n`);
    assert.deepEqual(statusJson().inflight.map((i) => i.id), [id], 'until today is not in the future: shown');
    run('defer', id, '--until', inDays(2), ...MARK);
    assert.deepEqual(statusJson().inflight, []);
    run('defer', id, '--until', inDays(1), ...MARK);
    assert.deepEqual(statusJson().inflight, [], 'latest defer wins, still in the future');
    run('done', id, ...MARK);
    assert.equal(run('verify').code, 0);
});

test('prime is at most 40 lines however much is open, shares lines between boxes, and writes nothing', () => {
    const f = blockFile();
    run('ask', 'Ship Friday or Monday?', '--stream', 'Launch', '--new-stream', ...MARK);
    run('ask', 'run the count', '--paste', f, ...MARK);
    run('log', 'wait on deploy', '--kind', 'blocked', '--gate', 'date:2099-01-01', ...MARK);
    const small = run('prime');
    assert.equal(small.code, 0, small.err);
    assert.match(small.out, /Today's streams: Launch/);
    assert.match(small.out, /Needs Jack \(1\)\n  \w+ Ship Friday or Monday\? \(Launch\)/);
    assert.match(small.out, /Paste blocks for Jack \(1\)\n  \w+ run the count \[block: /);
    assert.match(small.out, /Blocked \/ gated \(1\)\n  \w+ wait on deploy \[gate: date:2099-01-01\]/);
    for (let i = 0; i < 60; i++) run('start', `work item number ${i} with a fairly long description to clip`, ...MARK);
    for (let i = 0; i < 30; i++) run('ask', `question ${i}, which way?`, ...MARK);
    const before = readFileSync(join(vault, 'Projects', 'test-proj', 'Journal', 'ledger.jsonl'), 'utf8');
    const big = run('prime');
    const lines = big.out.trimEnd().split('\n');
    assert.ok(lines.length <= 40, `${lines.length} lines`);
    assert.match(big.out, /Needs Jack \(31\)/);
    assert.match(big.out, /In flight \(60\)/);
    assert.match(big.out, /… \+\d+ more/);
    assert.match(big.out, /Paste blocks for Jack \(1\)\n  \w+ run the count/, 'a short section is not starved');
    assert.equal(readFileSync(join(vault, 'Projects', 'test-proj', 'Journal', 'ledger.jsonl'), 'utf8'), before);
});

test('prime says when a supervisor is set up and not running, with the board still under 40 lines, and is silent otherwise', () => {
    run('log', 'an open item', '--kind', 'inflight', '--stream', 'S', '--new-stream', ...MARK);
    assert.doesNotMatch(run('prime').out, /Loop supervisor/);
    mkdirSync(join(vault, 'Events'), { recursive: true });
    writeFileSync(join(vault, 'Events', 'supervisor.json'), JSON.stringify({ pid: process.pid, startedAt: '2026-10-06T10:00:00Z' }));
    assert.doesNotMatch(run('prime').out, /Loop supervisor/);
    writeFileSync(join(vault, 'Events', 'supervisor.json'), JSON.stringify({ pid: 2 ** 22 + 12345, startedAt: '2026-10-06T10:00:00Z' }));
    const dead = run('prime').out;
    assert.match(dead, /^Loop supervisor: DEAD \(pid \d+, started 2026-10-06T10:00:00Z\)\./m);
    assert.ok(dead.trimEnd().split('\n').length <= 40);
    rmSync(join(vault, 'Events', 'supervisor.json'));
    mkdirSync(join(vault, 'LaunchAgents'), { recursive: true });
    writeFileSync(join(vault, 'LaunchAgents', 'com.jackreichert.the-maestro-loop.plist'), '<plist/>');
    assert.match(run('prime').out, /^Loop supervisor: NOT RUNNING \(installed at .*never seen alive\)/m);
});

test('the Loop line: silent with nothing set up, NOT INSTALLED when required, then ok, STALLED and DOWN from the heartbeat, in the footer and in prime', () => {
    run('log', 'an open item', '--kind', 'inflight', '--stream', 'S', '--new-stream', ...MARK);
    const events = join(vault, 'Events');
    const beat = (pid: number, ageMin: number, over = {}) => writeFileSync(join(events, 'heartbeat.json'), JSON.stringify({ pid, at: new Date(Date.now() - ageMin * 60_000).toISOString(), tick: 1, watchesLive: 1, sleepingUntil: null, mode: 'run', lastError: '', ...over }));
    const required = { MAESTRO_LOOP_SUPERVISOR: 'required', MAESTRO_EVENT_DIR: events, MAESTRO_PROJECTS_DIR: projects, MAESTRO_UPDATE_CHECK: 'off', MAESTRO_LAUNCH_AGENTS_DIR: join(vault, 'LaunchAgents') };
    assert.doesNotMatch(run('status', '--footer').out, /Loop:/);
    assert.doesNotMatch(run('prime').out, /^Loop:/m);
    assert.match(runEnv(required, 'status', '--footer').out, /^\*\*Loop:\*\* NOT INSTALLED/m);
    mkdirSync(events, { recursive: true });
    writeFileSync(join(events, 'loop.lock'), String(process.pid));
    beat(process.pid, 2);
    assert.match(runEnv(required, 'status', '--footer').out, /^\*\*Loop:\*\* ok 2 min$/m);
    assert.match(runEnv(required, 'prime').out, /^Loop: ok 2 min$/m);
    beat(process.pid, 30);
    assert.match(runEnv(required, 'status', '--footer').out, /^\*\*Loop:\*\* STALLED 30 min/m);
    rmSync(join(events, 'loop.lock'));
    beat(2 ** 22 + 12345, 30);
    writeFileSync(join(events, 'supervisor.json'), JSON.stringify({ pid: 2 ** 22 + 12345, startedAt: '2026-10-06T10:00:00Z' }));
    assert.match(runEnv(required, 'status', '--footer').out, /^\*\*Loop:\*\* DOWN since /m);
    assert.match(runEnv(required, 'prime').out, /^Loop: DOWN since /m);
});

test('prime on an empty ledger says so and creates nothing', () => {
    const out = run('prime');
    assert.equal(out.code, 0, out.err);
    assert.match(out.out, /\(nothing open\)/);
    assert.equal(existsSync(join(vault, 'Projects', 'test-proj', 'Journal')), false);
});

test('handoff section 1 shows the gate of a blocked item', () => {
    run('log', 'hold for the PR', '--kind', 'blocked', '--gate', 'gh:pr:owner/repo#7', '--stream', 'Launch', '--new-stream', ...MARK);
    const out = run('handoff', '--stream', 'Launch', '--dry-run', '--no-worktree-sweep').out;
    assert.match(out, /\[blocked\] hold for the PR.* gate: gh:pr:owner\/repo#7/);
});

test('prime stays within 40 lines even when stream names, block paths and the project carry newlines', () => {
    for (let s = 0; s < 30; s++) run('start', `w${s}`, '--stream', `st${s}\nx\ny`, '--new-stream', ...MARK);
    for (let i = 0; i < 30; i++) run('ask', `q${i}, which?`, ...MARK);
    for (let i = 0; i < 30; i++) run('log', `b${i}`, '--kind', 'blocked', ...MARK);
    const lines = run('prime').out.trimEnd().split('\n');
    assert.ok(lines.length <= 40, `${lines.length} lines`);
    assert.match(String(lines.at(-1)), /journal\.ts/);
});

test('deferring the last open item of a stream empties its page, and an expired deferral shows again in CURRENT.md on the next read', () => {
    const id = idOf(run('start', 'only item', '--stream', 'Solo', '--new-stream', ...MARK).out);
    const journal = join(vault, 'Projects', 'test-proj', 'Journal');
    assert.match(readFileSync(join(journal, 'Streams', 'Solo.md'), 'utf8'), /only item/);
    run('defer', id, '--until', inDays(2), ...MARK);
    assert.doesNotMatch(readFileSync(join(journal, 'Streams', 'Solo.md'), 'utf8'), /only item/);
    assert.doesNotMatch(readFileSync(join(journal, 'CURRENT.md'), 'utf8'), /only item/);
    // The date passes: the deferral now ends today, and CURRENT.md was last written on an earlier day.
    const file = join(journal, 'ledger.jsonl');
    writeFileSync(file, readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => { const r = parse(l); return r.kind === 'defer' ? JSON.stringify({ ...r, until: inDays(0) }) : l; }).join('\n') + '\n');
    writeFileSync(join(journal, 'CURRENT.md'), readFileSync(join(journal, 'CURRENT.md'), 'utf8').replace(/updated: .*/, 'updated: 2020-01-01'));
    run('prime');
    assert.match(readFileSync(join(journal, 'CURRENT.md'), 'utf8'), /only item/);
    assert.match(readFileSync(join(journal, 'Streams', 'Solo.md'), 'utf8'), /only item/);
});

// ── pending tracker transitions ─────────────────────────────────────────────

function seedPending() {
    const done = (text: string, ...more: string[]) => run('done', idOf(run('start', text, ...more, ...MARK).out), ...MARK);
    done('ship the retry cap ABC-12');
    done('wire the flag', '--ticket', 'XYZ-7');
    done('tidy the readme');
    done('already moved ABC-30');
    run('log', 'moved ABC-30 to In Staging', '--transitioned', 'ABC-30', ...MARK);
    run('start', 'still open ABC-99', ...MARK);
}

test('tickets --pending lists done items with a tracker key and no recorded transition, once per key', () => {
    seedPending();
    run('done', idOf(run('start', 'second pass at ABC-12', ...MARK).out), ...MARK);
    const r = run('tickets', '--pending');
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /ABC-12 .*ship the retry cap/);
    assert.match(r.out, /XYZ-7 .*wire the flag/, 'a key in the --ticket field counts');
    assert.equal(r.out.split('\n').filter((l) => l.startsWith('  ABC-12')).length, 1, 'one line per key');
    assert.doesNotMatch(r.out, /ABC-30|ABC-99|tidy the readme/, 'recorded, open and keyless items are not pending');
    const json = parse(run('tickets', '--pending', '--json').out);
    assert.deepEqual(json.pending.map((p) => p.key).sort(), ['ABC-12', 'XYZ-7']);
    assert.match(run('tickets', '--pending', '--since', '2999-01-01').out, /No pending tracker transitions/);
    assert.equal(run('tickets').code, 1);
});

test('recording a transition with log --transitioned clears the key; a value that is not a key is refused and writes nothing', () => {
    seedPending();
    const before = ledger().length;
    const bad = run('log', 'moved it', '--transitioned', 'not a key', ...MARK);
    assert.equal(bad.code, 1);
    assert.match(bad.err, /--transitioned needs tracker keys/);
    assert.equal(ledger().length, before);
    assert.equal(run('log', 'moved it', '--transitioned', ...MARK).code, 1, 'a bare flag is refused, not silently dropped');
    assert.equal(ledger().length, before);
    assert.equal(run('log', 'moved both', '--transitioned', 'ABC-12, XYZ-7', ...MARK).code, 0);
    assert.deepEqual(ledger().at(-1)?.transitioned, ['ABC-12', 'XYZ-7']);
    assert.match(run('tickets', '--pending').out, /No pending tracker transitions/);
});

test('the key pattern is configurable, so an overlay can narrow what counts as a tracker key', () => {
    seedPending();
    const narrow = runEnv({ MAESTRO_TRACKER_KEY_PATTERN: '\\bXYZ-\\d+\\b' }, 'tickets', '--pending').out;
    assert.match(narrow, /XYZ-7/);
    assert.doesNotMatch(narrow, /ABC-12/);
});

test('prime and triage flag pending transitions when there are some, and say nothing when there are none', () => {
    assert.doesNotMatch(run('prime').out, /Pending tracker transitions/);
    assert.match(run('triage').out, /\[x\] Every done item with a tracker key has a recorded transition$/m);
    seedPending();
    assert.match(run('prime').out, /Pending tracker transitions \(2\): ABC-12, XYZ-7\. `journal\.ts tickets --pending`/);
    const t = run('triage');
    assert.match(t.out, /\[ \] Every done item with a tracker key has a recorded transition \(2 pending: ABC-12, XYZ-7/);
    assert.deepEqual(parse(run('triage', '--json').out).pendingTransitions.map((p) => p.key).sort(), ['ABC-12', 'XYZ-7']);
    assert.equal(run('triage').code, 0, 'a warning, never a roll blocker');
    run('log', 'moved all', '--transitioned', 'ABC-12,XYZ-7', ...MARK);
    assert.doesNotMatch(run('prime').out, /Pending tracker transitions/);
});

// ── --project from the local config (MAESTRO-3) ─────────────────────────────

test('--project defaults to the configured project; an explicit one wins; with neither it refuses', () => {
    const cfgHome = mkdtempSync(join(tmpdir(), 'journal-cfg-'));
    const cfgFile = join(cfgHome, 'config.md');
    writeFileSync(cfgFile, '```maestro-config\nproject: cfg-proj\n```\n');
    const go = (cfg: string, ...args: string[]) => {
        const r = spawnSync(process.execPath, [SCRIPT, ...args, '--vault', vault, ...MARK], {
            encoding: 'utf8', cwd: emptyCwd,
            env: (({ MAESTRO_PROJECT: _drop, ...rest }) => ({ ...rest, VAULT_ROOT: '', MAESTRO_LOCAL_CONFIG: cfg }))(process.env),
        });
        return { code: r.status, out: r.stdout, err: r.stderr };
    };
    const viaConfig = go(cfgFile, 'start', 'from config');
    assert.equal(viaConfig.code, 0, viaConfig.err);
    assert.ok(existsSync(join(vault, 'Projects', 'cfg-proj', 'Journal', 'ledger.jsonl')), 'wrote under the configured project');
    const explicit = go(cfgFile, 'start', 'explicit', '--project', 'flag-proj');
    assert.equal(explicit.code, 0, explicit.err);
    assert.ok(existsSync(join(vault, 'Projects', 'flag-proj', 'Journal', 'ledger.jsonl')), 'the flag wins over the config');
    const none = go('', 'start', 'nothing');
    assert.equal(none.code, 1);
    assert.match(none.err, /Pass --project/);
});

/** A copy of the scripts inside a git checkout that has an upstream, so `prime` has a real skill repo to check. */
function skillCheckout(): string {
    const root = mkdtempSync(join(tmpdir(), 'journal-skill-'));
    const git = (cwd: string, ...a: string[]) => {
        const r = spawnSync('git', ['-c', 'user.email=t@example.com', '-c', 'user.name=T', '-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null', ...a], { cwd, encoding: 'utf8' });
        assert.equal(r.status, 0, r.stderr);
    };
    const skill = join(root, 'skill');
    git(root, 'init', '-q', '--bare', '-b', 'main', join(root, 'origin.git'));
    git(root, 'clone', '-q', join(root, 'origin.git'), skill);
    cpSync(new URL('.', import.meta.url).pathname, join(skill, 'scripts'), { recursive: true });
    git(skill, 'add', 'scripts');
    git(skill, 'commit', '-q', '-m', 'seed');
    git(skill, 'push', '-q', '-u', 'origin', 'HEAD:main');
    return skill;
}

function primeIn(skill: string, env: Record<string, string | undefined>): string {
    const r = spawnSync(process.execPath, [join(skill, 'scripts', 'journal.ts'), 'prime', '--vault', vault, '--project', 'test-proj'], {
        encoding: 'utf8', cwd: emptyCwd,
        env: Object.fromEntries(Object.entries({ ...process.env, VAULT_ROOT: '', MAESTRO_PROJECTS_DIR: projects, MAESTRO_CONTAINER_ROOT: '', MAESTRO_UPDATE_CHECK: 'on', ...env }).filter(([, v]) => v !== undefined)),
    });
    assert.equal(r.status, 0, r.stderr);
    return r.stdout;
}

test('prime asks once per session about an unset auto_pull, after the update line and before the board; on or off silences it', () => {
    const skill = skillCheckout();
    const nudge = /^the-maestro: auto_pull is not set\. .*Set "auto_pull: off" to silence this\.$/m;
    const unset = primeIn(skill, { MAESTRO_AUTO_PULL: undefined });
    assert.equal(unset.match(/auto_pull is not set/g)?.length, 1);
    assert.match(unset, nudge);
    assert.ok(unset.indexOf('auto_pull is not set') < unset.indexOf('Board '), 'above the board, like the update line');
    assert.match(primeIn(skill, { MAESTRO_AUTO_PULL: undefined }), nudge, 'repeats until answered');
    assert.doesNotMatch(primeIn(skill, { MAESTRO_AUTO_PULL: 'on' }), /auto_pull is not set/);
    assert.doesNotMatch(primeIn(skill, { MAESTRO_AUTO_PULL: 'off' }), /auto_pull is not set/);
    assert.doesNotMatch(primeIn(skill, { MAESTRO_AUTO_PULL: undefined, MAESTRO_UPDATE_CHECK: 'off' }), /auto_pull is not set/);
});

test('prime is silent about auto_pull when the skill is not a git checkout or its branch has no upstream', () => {
    const plain = mkdtempSync(join(tmpdir(), 'journal-plain-'));
    cpSync(new URL('.', import.meta.url).pathname, join(plain, 'scripts'), { recursive: true });
    const unset = { MAESTRO_AUTO_PULL: undefined };
    assert.doesNotMatch(primeIn(plain, unset), /auto_pull is not set/);
    const skill = skillCheckout();
    assert.equal(spawnSync('git', ['checkout', '-q', '-b', 'topic'], { cwd: skill }).status, 0);
    assert.doesNotMatch(primeIn(skill, unset), /auto_pull is not set/);
});

test('priorities set and show round-trip through the status dir, with a stream suffix', () => {
    const sd = join(vault, 'Status');
    assert.match(run('priorities', 'show', '--status-dir', sd).out, /Priorities not set for today — orchestrator will ask/);
    const set = run('priorities', 'set', 'Ship the widget | Alpha', 'Second thing', '--status-dir', sd);
    assert.equal(set.code, 0, set.err);
    const shown = parse<{ state: string; items: { text: string; stream?: string }[] }>(run('priorities', 'show', '--json', '--status-dir', sd).out);
    assert.equal(shown.state, 'ok');
    assert.deepEqual(shown.items, [{ text: 'Ship the widget', stream: 'Alpha' }, { text: 'Second thing' }]);
    assert.equal(run('priorities', 'set', '--status-dir', sd).code, 1, 'no priorities is refused');
    assert.match(run('priorities', 'show', '--status-dir', sd).out, /^Priorities for \d{4}-\d{2}-\d{2}:\n1\. Ship the widget \[Alpha\]\n2\. Second thing\n/);
});

test('start-here prints the Start view as text with no server, as data with --json, and one stream with --stream', () => {
    seedRegistry();
    const sd = join(vault, 'Status');
    run('week', 'set', 'Ship the widget | Maestro', '--status-dir', sd);
    run('ask', 'which way?', '--stream', 'Maestro', ...MARK);
    run('start', 'building it', '--stream', 'Maestro', ...MARK);
    run('start', 'elsewhere', '--stream', 'launch', ...MARK);
    const r = run('start-here', '--status-dir', sd);
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /^## Start here\n/);
    assert.match(r.out, /### This week\n1\. Ship the widget \[Maestro\]/);
    assert.match(r.out, /### Needs Jack \(1: Maestro 1\)\n- `\w+` \[Maestro\] which way\?/);
    assert.match(r.out, /Notes not read: vault_root is not set/);
    assert.ok(r.out.trim().split('\n').length <= 80);
    const data = parse<{ needs: { total: number }; inFlight: unknown[] }>(run('start-here', '--json', '--status-dir', sd).out);
    assert.deepEqual([data.needs.total, data.inFlight.length], [1, 2]);
    const one = run('start-here', '--stream', 'maestro', '--status-dir', sd).out;
    assert.ok(one.includes('building it') && !one.includes('elsewhere'));
});

test('week set and show round-trip through the status dir; a missing file prints the not-set line', () => {
    const sd = join(vault, 'Status');
    assert.match(run('week', 'show', '--status-dir', sd).out, /^Week goals not set/);
    const set = run('week', 'set', 'Ship the widget | Alpha', 'Second goal', '--date', '2026-10-07', '--status-dir', sd);
    assert.equal(set.code, 0, set.err);
    assert.match(run('week', 'show', '--date', '2026-10-09', '--status-dir', sd).out, /^Goals for the week of 2026-10-05:\n1\. Ship the widget \[Alpha\]\n2\. Second goal\n/);
    assert.match(run('week', 'show', '--date', '2026-10-12', '--status-dir', sd).out, /^Week goals not set.*week of 2026-10-05/);
    assert.equal(run('week', 'set', '--status-dir', sd).code, 1, 'no goals is refused');
});

test('priorities set refuses more than priorities_max and the error names the cap; the env setting moves it', () => {
    const sd = join(vault, 'Status');
    const six = ['a', 'b', 'c', 'd', 'e', 'f'];
    const over = run('priorities', 'set', ...six, '--status-dir', sd);
    assert.equal(over.code, 1);
    assert.match(over.err, /at most 5 priorities \(priorities_max\); got 6/);
    assert.equal(run('priorities', 'set', ...six.slice(0, 5), '--status-dir', sd).code, 0);
    const r = spawnSync(process.execPath, [SCRIPT, 'priorities', 'set', ...six, '--status-dir', sd, '--vault', vault, '--project', 'test-proj'], { encoding: 'utf8', cwd: emptyCwd, env: { ...process.env, VAULT_ROOT: '', MAESTRO_PRIORITIES_MAX: '6' } });
    assert.equal(r.status, 0, r.stderr);
});

test('prime prints the not-set line when a status dir exists and today\'s priorities are missing or stale, and not otherwise', () => {
    const sd = join(vault, 'Status');
    const line = 'Priorities not set for today — orchestrator will ask';
    assert.doesNotMatch(run('prime', '--status-dir', sd).out, /Priorities not set/, 'no status dir: not nagged');
    mkdirSync(sd, { recursive: true });
    assert.match(run('prime', '--status-dir', sd).out, new RegExp(line));
    writeFileSync(join(sd, 'priorities.md'), 'date: 2001-01-01\n- old\n');
    assert.match(run('prime', '--status-dir', sd).out, new RegExp(line), 'stale');
    assert.equal(run('priorities', 'set', 'today thing', '--status-dir', sd).code, 0);
    assert.doesNotMatch(run('prime', '--status-dir', sd).out, /Priorities not set/);
});

// ── review queue gate (MAESTRO-90) ──────────────────────────────────────────

test('review-queue: exit 0 with room, 1 when full, --cap overrides, and a failed read falls back to the snapshot or exits 2', () => {
    const gh = (nodes: unknown[]) => installGhStub({ pages: [nodes] });
    const gate = (env: NodeJS.ProcessEnv, ...args: string[]) => {
        const r = spawnSync(process.execPath, [SCRIPT, 'review-queue', ...args, '--vault', vault, '--project', 'test-proj'], {
            encoding: 'utf8', cwd: emptyCwd, env: { ...env, VAULT_ROOT: '', MAESTRO_PROJECTS_DIR: projects, MAESTRO_CONTAINER_ROOT: '', MAESTRO_UPDATE_CHECK: 'off', MAESTRO_PROJECT: 'test-proj' },
        });
        return { code: r.status, out: r.stdout, err: r.stderr };
    };
    const open = (n: number, isDraft = false) => prNode(n, { isDraft });
    const three = gh([open(1), open(2), open(3), open(4, true)]);
    const ok = gate(three);
    assert.equal(ok.code, 0, ok.err);
    assert.match(ok.out, /review queue: 3 of 4 \(live\)/);
    const full = gate(gh([open(1), open(2), open(3), open(4), open(5, true)]));
    assert.equal(full.code, 1);
    assert.match(full.out, /review queue: 4 of 4 \(full\) \(live\)[\s\S]*fixes to PRs already open/);
    assert.equal(gate(three, '--cap', '3').code, 1, '--cap overrides the configured cap');
    assert.equal(gate(three, '--cap', '0').code, 2, 'a bad cap is refused as unanswerable, not as full');
    assert.equal(gate(three, '--cap', '--json').code, 2, 'a cap flag with no value is refused');
    assert.equal(parse<{ ok: boolean; queue: { count: number } }>(gate(three, '--json').out).queue.count, 3);
    const broken = installGhStub({ pages: [[]], failOnPage: 0 });
    const unknown = gate(broken);
    assert.equal(unknown.code, 2, 'no live read and no snapshot is unknown, not empty');
    assert.match(unknown.out, /Treat the queue as full/);
    const snap = join(vault, 'Projects', 'test-proj', 'Journal');
    mkdirSync(snap, { recursive: true });
    writeFileSync(join(snap, 'prs-snapshot.json'), JSON.stringify({ takenAt: '2026-01-01T00:00:00Z', prs: [open(1), open(2), open(3), open(4)] }));
    assert.equal(gate(broken).code, 2, 'an old snapshot is not an answer');
    const takenAt = new Date().toISOString();
    writeFileSync(join(snap, 'prs-snapshot.json'), JSON.stringify({ takenAt, prs: [open(1), open(2), open(3), open(4)] }));
    const fallback = gate(broken);
    assert.equal(fallback.code, 1);
    assert.match(fallback.out, new RegExp(`stored snapshot ${takenAt}; live read failed`));
});

test('status and status --footer show the review queue from the stored snapshot, and stay as they were without one', () => {
    const before = run('status');
    assert.doesNotMatch(before.out, /review queue/);
    const journalDir = join(vault, 'Projects', 'test-proj', 'Journal');
    mkdirSync(journalDir, { recursive: true });
    const snapshot = (takenAt: string, ...drafts: boolean[]) => writeFileSync(join(journalDir, 'prs-snapshot.json'), JSON.stringify({ takenAt, prs: drafts.map((isDraft) => ({ isDraft })) }));
    const status = (args: string[], env: NodeJS.ProcessEnv = {}) => spawnSync(process.execPath, [SCRIPT, 'status', ...args, '--vault', vault, '--project', 'test-proj'], {
        encoding: 'utf8', cwd: emptyCwd, env: { ...process.env, VAULT_ROOT: '', MAESTRO_PROJECTS_DIR: projects, MAESTRO_CONTAINER_ROOT: '', MAESTRO_UPDATE_CHECK: 'off', MAESTRO_PROJECT: 'test-proj', MAESTRO_EVENT_DIR: join(vault, 'Events'), MAESTRO_LAUNCH_AGENTS_DIR: join(vault, 'LaunchAgents'), ...env },
    }).stdout;
    snapshot(new Date().toISOString(), false, false, true);
    assert.match(status([]), /\n {2}review queue: 2 of 4\n$/);
    assert.match(status(['--footer']), /^\*\*Review queue:\*\* 2 of 4\n\*\*Session:\*\*/m);
    snapshot(new Date().toISOString(), false, false, false, false);
    assert.match(status([], { MAESTRO_REVIEW_QUEUE_CAP: '4' }), /review queue: 4 of 4 \(full\)/);
    assert.match(status([], { MAESTRO_REVIEW_QUEUE_CAP: '6' }), /review queue: 4 of 6\n/);
    snapshot('2020-01-01T00:00:00Z', false);
    assert.match(status([]), /review queue: 1 of 4 \(snapshot \d+d old\)/);
});

// ── learned ─────────────────────────────────────────────────────────────────

const LEARNED = ['--kind', 'how-it-works', '--applies-to', 'fake-repo:fake-api:staging', '--evidence', 'docs/spec.md:12', '--verified-at', '2026-10-08 read the spec', '--confidence', 'observed'];
/** The learned rows; none when nothing was ever written, which is the point of the refusal tests. */
const learnedRows = () => (existsSync(ledgerFile()) ? ledger().filter((r) => r.kind === 'learned') : []);
/** `LEARNED` with one flag's value replaced, or the flag removed when `value` is null. */
function without(flag: string, value: string | null = null): string[] {
    const out = [...LEARNED];
    const i = out.indexOf(flag);
    if (value === null) out.splice(i, 2); else out[i + 1] = value;
    return out;
}

test('learned writes one validated row carrying every field', () => {
    const r = run('learned', 'The fake page count is the page length.', ...LEARNED, ...MARK);
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /^learned {2}\w{4} {2}The fake page count/);
    const [row] = learnedRows();
    assert.deepEqual(
        [row?.text, row?.learnedKind, row?.appliesTo, row?.evidence, row?.verifiedAt, row?.confidence],
        ['The fake page count is the page length.', 'how-it-works', 'fake-repo:fake-api:staging', 'docs/spec.md:12', '2026-10-08 read the spec', 'observed'],
    );
});

test('learned refuses a row with no evidence or no applies-to, and writes nothing', () => {
    for (const flag of ['--evidence', '--applies-to', '--verified-at', '--confidence', '--kind']) {
        const r = run('learned', 'A claim.', ...without(flag), ...MARK);
        assert.equal(r.code, 1, flag);
        assert.match(r.err, new RegExp(`${flag} is required|${flag} is required and must be`), flag);
        assert.equal(learnedRows().length, 0, `${flag}: a row was written`);
    }
});

test('learned refuses a claim, evidence or location with a secret shape, never echoes it, and writes nothing', () => {
    const sentinel = 'hunter2-sentinel-value';
    const secret = ['pass', `word=${sentinel}`].join('');
    for (const args of [
        [`The login is ${secret}`, ...LEARNED],
        ['A claim.', ...without('--evidence', `ran it with ${secret}`)],
        ['A claim.', ...without('--evidence', ['postgres', `://svc:${sentinel}@db.internal.test/app`].join(''))],
    ]) {
        const r = run('learned', ...args, ...MARK);
        assert.equal(r.code, 1, args.join(' '));
        assert.match(r.err, /refused, nothing written.*looks like a secret/s);
        assert.ok(!r.err.includes(sentinel) && !r.out.includes(sentinel), 'the sentinel was echoed');
    }
    assert.equal(run('learned', 'The patient SSN is 123-45-6789.', ...LEARNED, ...MARK).code, 1);
    assert.equal(existsSync(ledgerFile()), false, 'a refusal must not create or touch the ledger');
    assert.equal(learnedRows().length, 0);
});

test('learned is idempotent: the same fact, location and evidence is reported, not written twice', () => {
    run('learned', 'A claim.', ...LEARNED, ...MARK);
    const again = run('learned', 'A claim.', ...LEARNED, ...MARK);
    assert.equal(again.code, 0);
    assert.match(again.out, /already recorded/);
    assert.equal(learnedRows().length, 1);
});

test('learned --supersedes must name a learned row on the ledger', () => {
    const first = idOf(run('learned', 'Old claim.', ...LEARNED, ...MARK).out);
    assert.equal(run('learned', 'New claim.', ...LEARNED, '--supersedes', 'zz99', ...MARK).code, 1);
    assert.equal(run('learned', 'New claim.', ...LEARNED, '--supersedes', first, ...MARK).code, 0);
    assert.equal(learnedRows()[1]?.supersedes, first);
});

test('learned checks the repo against the container root when one is set', () => {
    const container = mkdtempSync(join(tmpdir(), 'journal-container-'));
    mkdirSync(join(container, 'fake-repo'));
    const inContainer = (...args: string[]) => spawnSync(process.execPath, [SCRIPT, ...args, '--vault', vault, '--project', 'test-proj'], {
        encoding: 'utf8', cwd: emptyCwd, env: { ...process.env, VAULT_ROOT: '', MAESTRO_CONTAINER_ROOT: container, MAESTRO_UPDATE_CHECK: 'off', MAESTRO_EVENT_DIR: join(vault, 'Events') },
    });
    assert.equal(inContainer('learned', 'A claim.', ...LEARNED, ...MARK).status, 0);
    const bad = inContainer('learned', 'A claim.', ...without('--applies-to', 'no-such-repo:thing'), ...MARK);
    assert.equal(bad.status, 1);
    assert.match(bad.stderr, /not a known repo/);
});

test('log --kind learned is refused: only `learned` writes the kind', () => {
    const r = run('log', 'an unchecked fact', '--kind', 'learned', ...MARK);
    assert.equal(r.code, 1);
    assert.match(r.err, /only by `journal.ts learned`/);
    assert.equal(learnedRows().length, 0);
});

test('verify flags a learned row that was hand-edited past the write-time rules', () => {
    run('learned', 'A claim.', ...LEARNED, ...MARK);
    assert.equal(run('verify').code, 0);
    const path = join(vault, 'Projects', 'test-proj', 'Journal', 'ledger.jsonl');
    const row = JSON.parse(readFileSync(path, 'utf8').trim());
    delete row.evidence;
    writeFileSync(path, `${JSON.stringify(row)}\n`);
    const r = run('verify');
    assert.equal(r.code, 1);
    assert.match(r.out + r.err, /learned: --evidence is required/);
});

test('learned --help prints its usage and writes nothing', () => {
    const r = run('learned', '--help');
    assert.equal(r.code, 0);
    assert.match(r.out, /journal\.ts learned "<claim>"/);
    assert.equal(learnedRows().length, 0);
});
