// Run: node --test scripts/ledger-index.test.mjs
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, appendFileSync, rmSync, existsSync, utimesSync, readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const SCRIPT = new URL('./ledger-index.mjs', import.meta.url).pathname;
const JOURNAL = new URL('./journal.mjs', import.meta.url).pathname;
const TODAY = new Date().toISOString().slice(0, 10);
let root, tickets, jdir, dbFile;

const run = (...args) => {
    const r = spawnSync(process.execPath, [SCRIPT, ...args, '--vault', root, '--tickets-vault', tickets], {
        encoding: 'utf8', env: { ...process.env, LEDGER_ROOT: '', VAULT_ROOT: '' },
    });
    return { code: r.status, out: r.stdout, err: r.stderr };
};
const row = (o) => JSON.stringify({ ts: `${TODAY}T10:00:00.000Z`, date: TODAY, refs: [], ...o }) + '\n';
const q = (sql) => { const db = new DatabaseSync(dbFile, { readOnly: true }); try { return db.prepare(sql).all(); } finally { db.close(); } };

beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'lidx-ledger-'));
    tickets = mkdtempSync(join(tmpdir(), 'lidx-vault-'));
    jdir = join(root, 'Projects', 'dev-env', 'Journal');
    dbFile = join(root, 'Projects', 'dev-env', 'Index', 'maestro.sqlite');
    mkdirSync(jdir, { recursive: true });
    mkdirSync(join(tickets, 'Projects', 'p1', 'Tickets', 'Archive'), { recursive: true });
    writeFileSync(join(jdir, 'ledger.jsonl'), [
        row({ id: 'aaaa', kind: 'wip', text: 'build zebrafish widget', stream: 'Alpha' }),
        row({ id: 'bbbb', kind: 'wip', text: 'second job untagged' }),
        row({ id: 'cccc', kind: 'question', text: 'which quokka policy?', stream: 'Beta' }),
        row({ id: 'dddd', kind: 'done', text: 'widget shipped', closes: 'aaaa' }),
        row({ id: 'eeee', kind: 'tag', tags: 'bbbb', stream: 'Beta', text: 'stream Beta' }),
        row({ id: 'ffff', kind: 'note', text: 'plain note' }),
        row({ id: 'gggg', kind: 'stamp', annotates: 'bbbb', model: 'm', used: ['x'], text: 'stamp bbbb' }),
    ].join(''));
    writeFileSync(join(jdir, 'HANDOFF-2026-01-01.md'), '# Handoff\n\nintro\n\n## First\n\nalpha text\n\n## Second\n\nplanted-handoff-term here\n');
    writeFileSync(join(tickets, 'Projects', 'p1', 'Tickets', 'p1-001.md'),
        '---\nid: "p1-001"\ntitle: "Fix thing"\nstatus: "open"\nreviewed: false\ntype: "bug"\npriority: 3\nlabels: ["a", "b"]\nexternal: "jira-KEY-1"\n---\n\n# body\n\nplanted-ticket-term here\n');
    writeFileSync(join(tickets, 'Projects', 'p1', 'Tickets', 'Archive', 'p1-000.md'), '---\nid: "p1-000"\ntitle: "Old"\nstatus: "done"\n---\nold body\n');
    writeFileSync(join(tickets, 'Projects', 'p1', 'Tickets', '_Index.md'), 'skip me planted-ticket-term');
});

test('index builds every table and skips _Index.md', () => {
    const r = run('index');
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /rows=7 items=4 tickets=2 handoffs=2 docs=11 meta=4/);
});

test('rebuild is idempotent after deleting the DB', () => {
    const a = run('index').out.replace(/\(\d+ ms\)/, '');
    rmSync(dbFile);
    const b = run('index').out.replace(/\(\d+ ms\)/, '');
    assert.equal(a, b);
    assert.ok(!existsSync(dbFile + '.tmp-0'));
});

test('items fold: effective stream, status, closed_by', () => {
    run('index');
    const items = Object.fromEntries(q('SELECT * FROM items').map((i) => [i.id, i]));
    assert.equal(items.aaaa.status, 'done');
    assert.equal(items.aaaa.closed_by, 'dddd');
    assert.equal(items.aaaa.is_open, 0);
    assert.equal(items.bbbb.stream, 'Beta');   // retagged by the tag row
    assert.equal(items.bbbb.is_open, 1);
    assert.equal(items.cccc.is_open, 1);
    assert.equal(items.ffff.status, 'note');
    assert.equal(items.dddd, undefined);        // closers are not items
});

test('open items match journal.mjs status --json', () => {
    const j = spawnSync(process.execPath, [JOURNAL, 'status', '--json', '--vault', root, '--project', 'dev-env'], { encoding: 'utf8' });
    assert.equal(j.status, 0, j.stderr);
    const s = JSON.parse(j.stdout);
    const theirs = [...s.inflight, ...s.blocked, ...s.awaiting].map((i) => `${i.id}:${i.stream ?? ''}`).sort();
    run('index');
    const ours = q('SELECT id, stream FROM items WHERE is_open = 1').map((i) => `${i.id}:${i.stream ?? ''}`).sort();
    assert.deepEqual(ours, theirs);
    assert.deepEqual(ours, ['bbbb:Beta', 'cccc:Beta']);
});

test('planted terms are found with the right source', () => {
    const t = JSON.parse(run('search', 'planted-ticket-term', '--json').out);
    assert.deepEqual(t.map((h) => [h.source, h.ref]), [['tickets', 'p1-001']]);
    const h = JSON.parse(run('search', '"planted-handoff-term"', '--json').out);
    assert.deepEqual(h.map((x) => [x.source, x.ref]), [['handoffs', 'HANDOFF-2026-01-01.md#2']]);
});

test('appending a ledger row makes the next search rebuild', () => {
    run('index');
    assert.equal(run('search', 'narwhal').out.trim(), '(no hits)');
    appendFileSync(join(jdir, 'ledger.jsonl'), row({ id: 'hhhh', kind: 'note', text: 'narwhal sighted' }));
    const r = run('search', 'narwhal', '--source', 'ledger', '--json');
    assert.equal(JSON.parse(r.out)[0].ref, 'hhhh');
});

test('changed ticket file (mtime) triggers rebuild', () => {
    run('index');
    const p = join(tickets, 'Projects', 'p1', 'Tickets', 'p1-001.md');
    writeFileSync(p, '---\nid: "p1-001"\ntitle: "Fix thing"\n---\nnow mentions pangolin\n');
    utimesSync(p, new Date(Date.now() + 5000), new Date(Date.now() + 5000));
    assert.equal(JSON.parse(run('search', 'pangolin', '--json').out).length, 1);
});

test('--source and --stream filters', () => {
    appendFileSync(join(jdir, 'ledger.jsonl'), row({ id: 'iiii', kind: 'note', text: 'widget in ledger and planted-ticket-term' }));
    const all = JSON.parse(run('search', 'widget OR planted-ticket-term', '--json').out);
    assert.ok(new Set(all.map((h) => h.source)).size >= 2);
    const led = JSON.parse(run('search', 'widget OR planted-ticket-term', '--source', 'ledger', '--json').out);
    assert.ok(led.length >= 2 && led.every((h) => h.source === 'ledger'));
    const alpha = JSON.parse(run('search', 'widget', '--stream', 'Alpha', '--json').out);
    assert.deepEqual(alpha.map((h) => h.ref).sort(), ['aaaa', 'dddd']);   // closer inherits the item's stream
    assert.equal(JSON.parse(run('search', 'widget', '--stream', 'Beta', '--json').out).length, 0);
    assert.equal(JSON.parse(run('search', 'widget', '--limit', '1', '--json').out).length, 1);
});

test('bad FTS syntax and bad flags give friendly errors, not stack traces', () => {
    const r = run('search', 'foo AND "open');
    assert.equal(r.code, 1);
    assert.match(r.err, /Could not parse search query/);
    assert.doesNotMatch(r.err, /\n\s+at /);
    assert.equal(run('search', 'x', '--source', 'nope').code, 1);
    assert.equal(run('search').code, 1);
});

test('stats reports counts and open items per stream', () => {
    const r = JSON.parse(run('stats', '--json').out);
    assert.equal(r.counts.items, 4);
    assert.equal(r.open, 2);
    assert.deepEqual(r.streams, [{ stream: 'Beta', open: 2 }]);
});

const qj = (...args) => JSON.parse(run('query', ...args, '--json').out);

test('query open lists open ids and streams, newest first', () => {
    const r = qj('open');
    assert.equal(r.total, 2);
    assert.deepEqual(r.items.map((i) => `${i.id}:${i.stream}`).sort(), ['bbbb:Beta', 'cccc:Beta']);
    assert.equal(qj('open', '--stream', 'Alpha').total, 0);
    assert.match(run('query', 'open').out, /open items: 2/);
});

test('query stream-counts flags a case split', () => {
    appendFileSync(join(jdir, 'ledger.jsonl'), row({ id: 'jjjj', kind: 'wip', text: 'lowercase twin', stream: 'beta' }));
    const s = Object.fromEntries(qj('stream-counts').streams.map((r) => [r.stream, r]));
    assert.equal(s.Beta.open, 2);
    assert.equal(s.beta.open, 1);
    assert.equal(s.Alpha.done, 1);
    assert.equal(s.Alpha.total, 1);
    assert.match(s.Beta.flag, /CASE SPLIT/);
    assert.match(s.beta.flag, /CASE SPLIT/);
    assert.equal(s.Alpha.flag, '');
    assert.match(run('query', 'stream-counts').out, /CASE SPLIT: Beta \/ beta|CASE SPLIT: beta \/ Beta/);
});

test('query by-ticket finds mentions and the ticket row', () => {
    appendFileSync(join(jdir, 'ledger.jsonl'), row({ id: 'kkkk', kind: 'note', text: 'looked at p1-001 today' })
        + row({ id: 'llll', kind: 'note', text: 'via ticket field', ticket: 'p1-001' })
        + row({ id: 'mmmm', kind: 'note', text: 'unrelated' }));
    const r = qj('by-ticket', 'p1-001');
    assert.deepEqual(r.rows.map((x) => x.id).sort(), ['kkkk', 'llll']);
    assert.equal(r.ticket.length, 1);
    assert.equal(r.ticket[0].title, 'Fix thing');
    assert.equal(r.ticket[0].status, 'open');
    assert.equal(run('query', 'by-ticket').code, 1);
});

test('query untagged counts by date and honours --since', () => {
    appendFileSync(join(jdir, 'ledger.jsonl'), JSON.stringify({ ts: '2020-01-01T00:00:00Z', date: '2020-01-01', kind: 'wip', id: 'old1', text: 'ancient', refs: [] }) + '\n');
    const r = qj('untagged');
    assert.equal(r.total, 2);   // ffff (note) and old1; bbbb was retagged
    assert.deepEqual(r.by_date, [{ date: TODAY, count: 1 }, { date: '2020-01-01', count: 1 }]);
    assert.deepEqual(qj('untagged', '--since', '2021-01-01').items.map((i) => i.id), ['ffff']);
    assert.equal(run('query', 'untagged', '--since', 'yesterday').code, 1);
});

test('query tickets counts by project, type and status', () => {
    const all = qj('tickets');
    assert.equal(all.total, 2);
    assert.deepEqual(all.by_project, [{ project: 'p1', count: 2 }]);
    const bugs = qj('tickets', '--type', 'bug');
    assert.equal(bugs.total, 1);
    assert.deepEqual(bugs.by_project, [{ project: 'p1', count: 1 }]);
    assert.deepEqual(bugs.tickets.map((t) => t.id), ['p1-001']);
    assert.equal(qj('tickets', '--project', 'nope').total, 0);
});

test('query handoffs lists files with section titles', () => {
    const r = qj('handoffs');
    assert.deepEqual(r.handoffs, [{ file: 'HANDOFF-2026-01-01.md', sections: ['First', 'Second'] }]);
});

test('query --sql runs selects and refuses writes', () => {
    assert.deepEqual(qj('--sql', 'select count(*) as n from rows'), [{ n: 7 }]);
    assert.match(run('query', '--sql', 'select count(*) as n from rows').out, /^n\n-+\n7\n$/);
    const w = run('query', '--sql', 'delete from rows');
    assert.equal(w.code, 1);
    assert.match(w.err, /read-only/);
    assert.doesNotMatch(w.err, /\n\s+at /);
    assert.equal(q('select count(*) as n from rows')[0].n, 7);
    assert.equal(run('query', '--sql', 'select * from nope').code, 1);
});

test('query with no name lists queries; unknown name is a friendly error', () => {
    assert.match(run('query').out, /Named queries/);
    assert.match(run('query', '--help').out, /stream-counts/);
    const r = run('query', 'bogus');
    assert.equal(r.code, 1);
    assert.match(r.err, /Unknown query "bogus"/);
    assert.match(r.err, /by-ticket/);
});

// ── stream registry and archive ─────────────────────────────────────────────

const regFile = () => join(root, 'Projects', 'dev-env', 'streams.json');
const append = (...rows) => appendFileSync(join(jdir, 'ledger.jsonl'), rows.join(''));
const refs = (query, ...flags) => JSON.parse(run('search', query, ...flags, '--json').out).map((h) => `${h.source}:${h.ref}`).sort();

test('registry maps aliases and case at read time, so the split heals', () => {
    append(row({ id: 'jjjj', kind: 'wip', text: 'lowercase twin', stream: 'beta' }));
    assert.match(run('query', 'stream-counts').out, /CASE SPLIT/);   // no registry yet
    writeFileSync(regFile(), JSON.stringify({ streams: { Beta: { aliases: ['beta'], status: 'active' }, Alpha: { aliases: [], status: 'active' } } }));
    const s = Object.fromEntries(qj('stream-counts').streams.map((r) => [r.stream, r]));
    assert.equal(s.Beta.open, 3);
    assert.equal(s.beta, undefined);
    assert.equal(s.Beta.flag, '');
    assert.equal(qj('open', '--stream', 'beta').total, 3);   // an alias works as a filter
    assert.deepEqual(JSON.parse(run('stats', '--json').out).streams, [{ stream: 'Beta', open: 3 }]);
    assert.equal(refs('widget', '--stream', 'alpha').length, 2);
});

test('fact, carry, archive and unarchive rows are not items', () => {
    append(row({ id: 'ff01', kind: 'fact', key: 'k', value: '1', text: 'k=1', stream: 'Alpha' }),
        row({ id: 'cr01', kind: 'carry', carries: 'bbbb', from: 'Beta', stream: 'Alpha', text: 'carry' }));
    run('index');
    const ids = q('SELECT id FROM items').map((i) => i.id);
    assert.ok(!ids.includes('ff01') && !ids.includes('cr01'));
    assert.equal(q("SELECT stream FROM items WHERE id = 'bbbb'")[0].stream, 'Alpha');   // carried
    assert.equal(q('SELECT count(*) AS n FROM rows WHERE kind = \'fact\'')[0].n, 1);
});

const retroFile = () => join(tickets, 'retro.md');
function archiveAlpha() {
    writeFileSync(retroFile(), '---\nstatus: reviewed\n---\n# Alpha retro\n\n## Summary\n\n- shipped the zebrafish saga, plus quantumleap findings\n\n## Timeline\n\nother\n');
    append(row({ id: 'ar01', kind: 'archive', stream: 'Alpha', ids: ['aaaa'], retro: retroFile(), text: 'archived stream Alpha (1 items)' }));
}

test('archived items are hidden by default and shown with --include-archived', () => {
    archiveAlpha();
    assert.deepEqual(refs('widget', '--source', 'ledger'), []);
    assert.deepEqual(refs('widget', '--source', 'ledger', '--include-archived'), ['ledger:aaaa', 'ledger:dddd']);
    assert.equal(qj('stream-counts').streams.find((r) => r.stream === 'Alpha'), undefined);
    assert.equal(qj('stream-counts', '--include-archived').streams.find((r) => r.stream === 'Alpha').done, 1);
    run('index');
    assert.equal(q('SELECT archived FROM items WHERE id = \'aaaa\'')[0].archived, 1);
    assert.equal(q('SELECT archived FROM items WHERE id = \'bbbb\'')[0].archived, 0);
    assert.equal(q('SELECT archived FROM rows WHERE id = \'dddd\'')[0].archived, 1);   // the closer follows its item
    assert.equal(qj('untagged').items.some((i) => i.id === 'aaaa'), false);
});

test('an archived stream leaves one pointer doc that a default search finds', () => {
    archiveAlpha();
    run('index');
    const docs = q("SELECT ref, stream, body, archived FROM docs WHERE source = 'archive'");
    assert.equal(docs.length, 1);
    assert.equal(docs[0].ref, 'Alpha');
    assert.equal(docs[0].stream, 'Alpha');
    assert.match(docs[0].body, /retro: .*retro\.md/);
    assert.match(docs[0].body, /quantumleap/);
    assert.doesNotMatch(docs[0].body, /## Timeline|other/);   // summary section only
    assert.deepEqual(refs('quantumleap'), ['archive:Alpha']);
    assert.deepEqual(refs('quantumleap', '--source', 'archive'), ['archive:Alpha']);
    assert.deepEqual(refs('quantumleap', '--stream', 'Alpha'), ['archive:Alpha']);
    // editing the retro is a source change: the next search rebuilds
    writeFileSync(retroFile(), readFileSync(retroFile(), 'utf8').replace('quantumleap', 'hyperdrive'));
    utimesSync(retroFile(), new Date(Date.now() + 5000), new Date(Date.now() + 5000));
    assert.deepEqual(refs('hyperdrive'), ['archive:Alpha']);
});

test('archive then unarchive leaves fold, stats and search counts identical', () => {
    const snap = () => JSON.stringify({
        stats: (({ open, streams, counts }) => ({ open, streams, items: counts.items, tickets: counts.tickets }))(JSON.parse(run('stats', '--json').out)),
        counts: qj('stream-counts').streams, open: qj('open').items.map((i) => i.id).sort(),
        widget: refs('widget'), all: refs('widget OR zebrafish OR quokka OR narwhal OR plain'),
        items: q('SELECT id, stream, status, is_open, archived FROM items ORDER BY id'),
    });
    const before = snap();
    archiveAlpha();
    assert.notEqual(snap(), before);
    append(row({ id: 'un01', kind: 'unarchive', stream: 'Alpha', ids: ['aaaa'], text: 'unarchived stream Alpha' }));
    // the two extra rows are ledger docs themselves; compare everything except those
    const after = JSON.parse(snap());
    const was = JSON.parse(before);
    assert.deepEqual(after.stats, was.stats);
    assert.deepEqual(after.counts, was.counts);
    assert.deepEqual(after.open, was.open);
    assert.deepEqual(after.widget, was.widget);
    assert.deepEqual(after.items, was.items);
    assert.equal(q("SELECT count(*) AS n FROM docs WHERE source = 'archive'")[0].n, 0);
});

test('with a registry, carry and archive, open items still match journal.mjs status --json', () => {
    writeFileSync(regFile(), JSON.stringify({ streams: { Beta: { aliases: ['beta'], status: 'active' }, Alpha: { aliases: [], status: 'active' } } }));
    append(row({ id: 'jjjj', kind: 'wip', text: 'lowercase twin', stream: 'beta' }),
        row({ id: 'cr01', kind: 'carry', carries: 'cccc', from: 'Beta', stream: 'Alpha', text: 'carry' }));
    archiveAlpha();   // hides Alpha's aaaa only; the carried cccc stays visible in the ids-based view
    const j = spawnSync(process.execPath, [JOURNAL, 'status', '--json', '--vault', root, '--project', 'dev-env'], { encoding: 'utf8' });
    const s = JSON.parse(j.stdout);
    const theirs = [...s.inflight, ...s.blocked, ...s.awaiting].map((i) => `${i.id}:${i.stream ?? ''}`).sort();
    run('index');
    const ours = q('SELECT id, stream FROM items WHERE is_open = 1 AND archived = 0').map((i) => `${i.id}:${i.stream ?? ''}`).sort();
    assert.deepEqual(ours, theirs);
    assert.deepEqual(ours, ['bbbb:Beta', 'cccc:Alpha', 'jjjj:Beta']);
});
