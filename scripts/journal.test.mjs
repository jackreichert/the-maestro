// Run: node --test scripts/journal.test.mjs
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Hermetic: never read the user's config file (see local-config.mjs).
process.env.MAESTRO_LOCAL_CONFIG = '';

const SCRIPT = new URL('./journal.mjs', import.meta.url).pathname;
const MARK = ['--model', 'Test Model', '--used', 'skill:the-maestro,tool:journal.mjs'];
let vault;
let tv;

function run(...args) {
    const r = spawnSync(process.execPath, [SCRIPT, ...args, '--vault', vault, '--project', 'test-proj'], {
        encoding: 'utf8',
        env: { ...process.env, VAULT_ROOT: '' },
    });
    return { code: r.status, out: r.stdout, err: r.stderr };
}
const ledger = () => readFileSync(join(vault, 'Projects', 'test-proj', 'Journal', 'ledger.jsonl'), 'utf8')
    .split('\n').filter(Boolean).map((l) => JSON.parse(l));
const idOf = (out) => out.trim().split(/\s+/)[1];

beforeEach(() => {
    vault = mkdtempSync(join(tmpdir(), 'journal-test-'));
    tv = mkdtempSync(join(tmpdir(), 'journal-tickets-'));
});

test('start without --model fails and writes nothing', () => {
    const r = run('start', 'unmarked work', '--used', 'tool:journal.mjs');
    assert.equal(r.code, 1);
    assert.match(r.err, /--model/);
    assert.throws(() => ledger());
});

test('start with model and used shows the marks in status', () => {
    assert.equal(run('start', 'marked work', ...MARK).code, 0);
    const s = run('status');
    assert.equal(s.code, 0);
    assert.match(s.out, /marked work .*model: Test Model · used: skill:the-maestro, tool:journal\.mjs/);
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
    const stamp = ledger().find((e) => e.annotates === id);
    assert.deepEqual([stamp.model, stamp.used, stamp.tokens], ['unrecorded', ['unrecorded'], 'unmeasured']);
    assert.match(run('status').out, /legacy work .*model: unrecorded · used: unrecorded · tokens: unmeasured/);
    assert.match(run('stamp-missing').out, /stamped 0 entries/);
});

test('fold does not duplicate a stamped item', () => {
    const id = idOf(run('start', 'only once', '--allow-unmarked').out);
    run('stamp', id, ...MARK);
    run('stamp-missing');
    const s = JSON.parse(run('status', '--json').out);
    assert.equal(s.inflight.length, 1);
    assert.equal(s.inflight[0].model, 'Test Model');
});

test('roll appends a marked row without needing --model', () => {
    const id = idOf(run('start', 'finished', ...MARK).out);
    run('done', id, ...MARK);
    const r = run('roll');
    assert.equal(r.code, 0, r.err);
    const rolled = ledger().find((e) => e.kind === 'rolled');
    assert.deepEqual([rolled.model, rolled.used, rolled.tokens], ['n/a', ['tool:journal.mjs'], 'n/a']);
});

test('root precedence: --vault beats LEDGER_ROOT beats VAULT_ROOT', () => {
    const ledgerRoot = mkdtempSync(join(tmpdir(), 'journal-ledger-root-'));
    const vaultRoot = mkdtempSync(join(tmpdir(), 'journal-vault-root-'));
    const explicitVault = mkdtempSync(join(tmpdir(), 'journal-explicit-vault-'));
    const writes = (base) => join(base, 'Projects', 'test-proj', 'Journal', 'ledger.jsonl');

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
const registry = () => JSON.parse(readFileSync(registryFile(), 'utf8'));
function seedRegistry(streams = { Launch: { aliases: ['launch', 'launch-v2'], status: 'active' }, Maestro: { aliases: [], status: 'active' } }) {
    mkdirSync(join(vault, 'Projects', 'test-proj'), { recursive: true });
    writeFileSync(registryFile(), JSON.stringify({ streams }, null, 2));
}
const runT = (...args) => run(...args, '--tickets-vault', tv);
const statusJson = (...a) => JSON.parse(run('status', '--json', ...a).out);
const retroPath = (stream) => join(tv, 'Projects', 'dev-env', 'Archive', `${stream}-retro-${new Date().toISOString().slice(0, 10)}.md`);

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
    assert.equal(ledger().find((e) => e.kind === 'tag').stream, 'Maestro');
    assert.equal(run('ask', 'q?', '--stream', 'launch', ...MARK).code, 0);
    assert.equal(run('log', 'n', '--stream', 'launch', ...MARK).code, 0);
    assert.ok(ledger().filter((e) => e.stream).every((e) => ['Launch', 'Maestro'].includes(e.stream)));
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
    const l = JSON.parse(run('streams', 'list', '--json').out);
    assert.deepEqual(l.streams.map((r) => [r.stream, r.open, r.total]), [['Launch', 1, 1]]);
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
    const row = ledger().find((e) => e.kind === 'fact');
    assert.deepEqual([row.key, row.value, row.stream], ['v1_visits_full_min', '79', 'Launch']);
    const s = statusJson();
    assert.deepEqual([s.inflight, s.blocked, s.awaiting, s.done], [[], [], [], []]);
    assert.deepEqual(JSON.parse(run('streams', 'list', '--json').out).streams.map((r) => r.total), [0, 0]);   // registered, but no items
    assert.equal(run('fact', 'no-equals', '--stream', 'Launch', ...MARK).code, 1);
    assert.equal(run('fact', 'k=v', ...MARK).code, 1);
});

test('carry re-homes an item', () => {
    seedRegistry();
    const id = idOf(run('start', 'follow-up', '--stream', 'Launch', ...MARK).out);
    assert.equal(run('carry', id, '--to', 'maestro', ...MARK).code, 0);
    const c = ledger().find((e) => e.kind === 'carry');
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
    const ev = rows.at(-1);
    assert.equal(ev.kind, 'archive');
    assert.equal(ev.stream, 'Launch');
    assert.equal(ev.ids.length, 3);
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
        streams: JSON.parse(run('streams', 'list', '--json').out).streams.map(({ stream, open, done, dropped, total }) => [stream, open, done, dropped, total]),
    });
    const before = snap();
    runT('retro', 'Launch');
    const path = retroPath('Launch');
    writeFileSync(path, readFileSync(path, 'utf8').replace('status: draft', 'status: reviewed').replace(/Promoted to: $/m, 'Promoted to: one-off'));
    assert.equal(runT('archive', 'Launch', ...MARK).code, 0);

    const hidden = snap();
    assert.doesNotMatch(hidden.standup, /ship the widget/);
    assert.equal(JSON.parse(hidden.status).done.length, 0);
    assert.deepEqual(JSON.parse(hidden.status).inflight.map((i) => i.id), [other]);
    const shown = run('status', '--json', '--include-archived').out;
    assert.equal(JSON.parse(shown).done.length, 1);
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
    ]);
});

test('status --footer with no streams is the single plain Ledger line, and appends nothing', () => {
    run('start', 'plain', ...MARK);
    const before = readFileSync(join(vault, 'Projects', 'test-proj', 'Journal', 'ledger.jsonl'), 'utf8');
    assert.equal(run('status', '--footer').out.trim(), '**Ledger:** 0 done today · 1 in flight · 0 awaiting you');
    assert.equal(readFileSync(join(vault, 'Projects', 'test-proj', 'Journal', 'ledger.jsonl'), 'utf8'), before);
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

test('read-time mapping heals old rows without touching the ledger; models check is a dry run', () => {
    run('start', 'legacy', '--model', 'Claude Opus 5.5', ...usedFlags);
    run('start', 'modern', '--model', 'claude-opus-5-5', ...usedFlags);
    const before = readFileSync(ledgerFile(), 'utf8');
    assert.deepEqual(JSON.parse(run('usage', '--json').out).model, { 'Claude Opus 5.5': 1, 'claude-opus-5-5': 1 });   // no models section: nothing enforced
    seedModels();
    assert.deepEqual(JSON.parse(run('usage', '--json').out).model, { 'claude-opus-5-5': 2 });
    const c = JSON.parse(run('models', 'check', '--json').out);
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

const runEnv = (env, ...args) => {
    const r = spawnSync(process.execPath, [SCRIPT, ...args, '--vault', vault, '--project', 'test-proj'], {
        encoding: 'utf8', env: { ...process.env, VAULT_ROOT: '', MAESTRO_RESUME_GH: 'off', ...env },
    });
    return { code: r.status, out: r.stdout, err: r.stderr };
};
const handoffFile = (stream) => join(vault, 'Projects', 'test-proj', 'Journal', `HANDOFF-${new Date().toISOString().slice(0, 10)}-${stream}.md`);
const section = (text, n) => text.split(new RegExp(`^## ${n}\\. .*$`, 'm'))[1].split(/^## /m)[0];

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
