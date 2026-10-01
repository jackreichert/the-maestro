// Run: node --test scripts/journal.test.mjs
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync, spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
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
    assert.equal(ledger().find((e) => e.kind === 'tag').stream, undefined);
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

// ── backfill ────────────────────────────────────────────────────────────────

function seedBackfill() {
    seedRegistry({ Launch: { aliases: ['launch-v2'], status: 'active' }, Maestro: { aliases: ['orchestrator'], status: 'active' } });
    const day = new Date().toISOString().slice(0, 10);
    const at = (h, m = 0) => `${day}T${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:00.000Z`;
    const row = (id, h, m, o) => JSON.stringify({ id, ts: at(h, m), date: day, kind: 'wip', refs: [], model: 'm', used: ['x'], ...o });
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
const bfJson = (...a) => JSON.parse(run('backfill', '--json', ...a).out);

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
    assert.match(added[0].backfill, /^bf-/);
    assert.equal(new Set(ledger().map((e) => e.id)).size, ledger().length);
    assert.equal(bfJson().untagged, 5);
    assert.match(run('backfill', '--apply', '--min-confidence', 'high', ...MARK).out, /0 tag row\(s\)/);   // idempotent
    assert.equal(ledger().length, 16);
    assert.equal(run('backfill', '--apply', '--min-confidence', 'bogus', ...MARK).code, 1);
    assert.equal(run('backfill', '--apply', ...['--min-confidence', 'medium']).code, 1);   // apply needs usage marks
});

// ── claims and concurrent writers ───────────────────────────────────────────

const claimsDirPath = () => join(vault, 'Projects', 'test-proj', 'Claims');
const lockFile = (repo) => join(claimsDirPath(), `${repo}.lock`);

/** Runs journal.mjs asynchronously so several can genuinely overlap. */
const runAsync = (args, extraEnv = {}) => new Promise((resolve) => {
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
    const lock = JSON.parse(readFileSync(lockFile('repo-x'), 'utf8'));
    assert.equal(lock.desk, `desk${winners[0].i}`);
    for (const r of results.filter((x) => x.code !== 0)) assert.match(r.err, new RegExp(`already claimed by desk ${lock.desk},`));
    assert.equal(ledger().filter((e) => e.kind === 'claim').length, 1);
    assert.equal(ledger().find((e) => e.kind === 'claim').desk, lock.desk);
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
    const old = JSON.parse(readFileSync(lockFile('nopid'), 'utf8'));
    writeFileSync(lockFile('nopid'), JSON.stringify({ ...old, time: new Date(Date.now() - 30 * 36e5).toISOString() }));
    const byRepo = Object.fromEntries(JSON.parse(run('claims', '--json').out).claims.map((c) => [c.repo, c]));
    assert.equal(byRepo.live.stale, false);
    assert.equal(byRepo.gone.stale, true);
    assert.match(byRepo.gone.reason, /is not running/);
    assert.equal(byRepo.nopid.stale, true);
    assert.match(byRepo.nopid.reason, /older than 12h/);
    assert.equal(JSON.parse(run('claims', '--json', '--stale-hours', '48').out).claims.find((c) => c.repo === 'nopid').stale, false);
    assert.match(run('claims').out, /gone {2}desk alpha.*STALE \(pid \d+ is not running\)/);
    assert.deepEqual([statusJson().inflight, statusJson().awaiting], [[], []]);
    assert.equal(run('claims', '--vault', mkdtempSync(join(tmpdir(), 'empty-'))).out.trim(), 'No claims.');
});

test('concurrent appends: N processes x M rows all parse, with unique ids and the full count', async () => {
    const N = 4;
    const M = 25;
    const workers = Array.from({ length: N }, (_, w) => new Promise((resolve) => {
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
    const rows = lines.map((l) => JSON.parse(l));   // throws on any torn or interleaved line
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
    const j = JSON.parse(run('verify', '--json').out);
    assert.equal(j.problems.length, 5);
    assert.equal(run('verify', '--vault', mkdtempSync(join(tmpdir(), 'empty-'))).code, 0);   // no ledger yet is not a problem
});

const gitEnv = { GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null', GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.com' };
const git = (cwd, ...a) => spawnSync('git', ['-C', cwd, ...a], { encoding: 'utf8', env: { ...process.env, ...gitEnv } });

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

const streamPage = (name) => join(vault, 'Projects', 'test-proj', 'Journal', 'Streams', `${name}.md`);
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
const section2 = (text, title) => text.split(new RegExp(`^## ${title}.*$`, 'm'))[1].split(/^## /m)[0];

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
    const row = ledger().find((e) => e.id === idOf(r.out));
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
    assert.equal(ledger().find((e) => e.closes === q).approval, 'one-off');
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
    const tag = ledger().find((e) => e.kind === 'approval-tag');
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
    const tag = ledger().find((e) => e.kind === 'approval-tag').id;
    for (const id of [wip, done, dropped, tag]) {
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

const daysAgo = (n) => new Date(Date.now() - n * 86400000).toISOString().slice(0, 10);
const digestPath = join(tmpdir(), `approvals-${process.pid}.md`);
const digest = (...a) => run('approvals', '--tickets-vault', tv, ...a);
const jsonDigest = (...a) => JSON.parse(digest('--json', ...a).out);

function seedApprovals() {
    const mk = (text, date, ...extra) => idOf(run('log', text, '--kind', 'decision', '--date', date, ...extra, ...MARK).out);
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
    assert.equal(g.standing.find((a) => a.id === retro).scope, 'own branches');
    assert.deepEqual(g.standing.find((a) => a.id === ids.standing).refs, ['memory/bot.md']);
});

test('approvals --days and --since set the window; an old row that is retro-tagged now comes in', () => {
    const ids = seedApprovals();
    assert.ok(!jsonDigest('--days', '7').standing.some((a) => a.id === ids.old));
    assert.ok(jsonDigest('--days', '60').standing.some((a) => a.id === ids.old));
    assert.ok(jsonDigest('--since', daysAgo(40)).standing.some((a) => a.id === ids.old));
    assert.equal(jsonDigest('--days', '0').standing.length, 0);
    const oldDecision = idOf(run('log', 'ancient decision', '--kind', 'decision', '--date', daysAgo(90), ...MARK).out);
    run('approve-tag', oldDecision, '--approval', 'one-off', ...MARK);
    assert.ok(jsonDigest('--days', '7').oneOff.some((a) => a.id === oldDecision));
    assert.equal(digest('--since', 'yesterday').code, 1);
    assert.equal(digest('--days', 'x').code, 1);
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
