#!/usr/bin/env node
/**
 * Derived, disposable SQLite FTS5 index over the ledger, vault tickets and handoff notes.
 * The JSONL stays the source of truth; deleting the DB loses nothing.
 *
 *   ledger-index.mjs index                       full rebuild, atomic rename into place
 *   ledger-index.mjs search "<fts query>" [--source ledger|tickets|handoffs|archive] [--stream X] [--limit 20] [--json]
 *   ledger-index.mjs stats [--json]              counts per table, open items per stream
 *   ledger-index.mjs query <name> [args] [--json]  named queries and read-only --sql; `query` lists them
 *
 * Streams: if $LEDGER_ROOT/Projects/<project>/streams.json exists, stream names are mapped through it
 * (aliases and case fold to the canonical name), like journal.mjs. Items of archived streams are hidden
 * from search, stats and the named queries unless --include-archived; each archived stream leaves one
 * `archive` doc pointing at its retro, so a default search still finds the epic. `query --sql` is raw
 * and sees everything (items.archived, rows.archived, docs.archived mark the hidden ones).
 *
 * DB: $LEDGER_ROOT/Projects/<project>/Index/maestro.sqlite (project defaults to dev-env).
 * Roots: --vault, then $LEDGER_ROOT, then $VAULT_ROOT (no default). Tickets: --tickets-vault,
 * then $VAULT_ROOT (no default; tickets are skipped when unset). `search` rebuilds first if a source changed.
 */
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync, statSync, existsSync, mkdirSync, renameSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { LEDGER_ROOT, VAULT_ROOT } from './local-config.mjs';
import { isOpen, readRegistry, mapStreamWith, fold as foldWith } from './lib/ledger-core.ts';

const SCHEMA_VERSION = '2';
const argv = process.argv.slice(2);
const cmd = argv[0];
const VALUE_FLAGS = new Set(['--vault', '--tickets-vault', '--project', '--source', '--stream', '--limit', '--since', '--status', '--type', '--sql']);
const arg = (name, fallback = null) => {
    const i = argv.indexOf(`--${name}`);
    return i !== -1 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : fallback;
};
const has = (name) => argv.includes(`--${name}`);
const positional = argv.slice(1).filter((a, i, all) => !a.startsWith('--') && !VALUE_FLAGS.has(all[i - 1]));
const fail = (msg) => { console.error(msg); process.exit(1); };

const ledgerRoot = arg('vault', LEDGER_ROOT || VAULT_ROOT);
const ticketsRoot = arg('tickets-vault', VAULT_ROOT);
if (!ledgerRoot) fail('Ledger root is not set. Set LEDGER_ROOT (or VAULT_ROOT), or pass --vault <path>.');
const project = arg('project', 'dev-env');
const journalDir = join(ledgerRoot, 'Projects', project, 'Journal');
const ledgerPath = join(journalDir, 'ledger.jsonl');
const registryPath = join(ledgerRoot, 'Projects', project, 'streams.json');
const withArchived = has('include-archived');
const indexDir = join(ledgerRoot, 'Projects', project, 'Index');
const dbPath = join(indexDir, 'maestro.sqlite');

function requireFts5() {
    const db = new DatabaseSync(':memory:');
    try { db.exec('CREATE VIRTUAL TABLE t USING fts5(x)'); } catch {
        fail('This Node build of node:sqlite has no FTS5 support. Use a Node build whose SQLite includes FTS5.');
    } finally { db.close(); }
}

// ── sources ─────────────────────────────────────────────────────────────────

function readLedgerRows() {
    if (!existsSync(ledgerPath)) return [];
    return readFileSync(ledgerPath, 'utf8').split('\n').filter((l) => l.trim()).map((l) => {
        try { return JSON.parse(l); } catch { return null; }
    }).filter(Boolean);
}

const registry = readRegistry(registryPath);
const mapStream = (s) => mapStreamWith(registry, s);
const fold = (entries) => foldWith(entries, registry).items;

/** Latest archive event per stream, unless a later unarchive cancelled it. Same archive rule as fold() in lib/ledger-core.ts. */
function archiveState(entries) {
    const byStream = new Map();
    for (const e of entries) {
        if (e.kind === 'archive' && e.stream) byStream.set(mapStream(e.stream), e);
        if (e.kind === 'unarchive' && e.stream) byStream.delete(mapStream(e.stream));
    }
    return { events: byStream, hidden: new Set([...byStream.values()].flatMap((e) => e.ids || [])) };
}

function walkTickets() {
    const out = [];
    if (!ticketsRoot) return out;
    const projects = join(ticketsRoot, 'Projects');
    if (!existsSync(projects)) return out;
    const visit = (d) => {
        for (const ent of readdirSync(d, { withFileTypes: true })) {
            const p = join(d, ent.name);
            if (ent.isDirectory()) visit(p);
            else if (ent.name.endsWith('.md') && ent.name !== '_Index.md') out.push(p);
        }
    };
    for (const p of readdirSync(projects, { withFileTypes: true })) {
        const t = join(projects, p.name, 'Tickets');
        if (p.isDirectory() && existsSync(t)) visit(t);
    }
    return out.sort();
}

/** Flat `key: value` frontmatter; values may be JSON (arrays, quoted strings) or bare scalars. */
function parseTicket(path) {
    const raw = readFileSync(path, 'utf8');
    const fm = {};
    let body = raw;
    const m = raw.match(/^---\n([\s\S]*?)\n---\n?/);
    if (m) {
        body = raw.slice(m[0].length);
        for (const line of m[1].split('\n')) {
            const kv = line.match(/^([\w-]+):\s*(.*)$/);
            if (!kv) continue;
            let v = kv[2].trim();
            try { v = JSON.parse(v); } catch { /* keep bare scalar */ }
            fm[kv[1]] = v;
        }
    }
    const asText = (v) => (v === undefined || v === null ? null : Array.isArray(v) ? v.join(',') : String(v));
    return {
        id: asText(fm.id) || path.split('/').pop().replace(/\.md$/, ''),
        title: asText(fm.title) || '', status: asText(fm.status), type: asText(fm.type),
        priority: asText(fm.priority), labels: asText(fm.labels), reviewed: asText(fm.reviewed),
        external: asText(fm.external), path, body,
    };
}

function readHandoffs() {
    if (!existsSync(journalDir)) return [];
    const out = [];
    for (const f of readdirSync(journalDir).filter((n) => /^HANDOFF-.*\.md$/.test(n)).sort()) {
        const parts = readFileSync(join(journalDir, f), 'utf8').split(/^## /m);
        parts.slice(1).forEach((sec, idx) => {
            const nl = sec.indexOf('\n');
            const heading = (nl === -1 ? sec : sec.slice(0, nl)).trim();
            out.push({ file: f, section: idx + 1, heading, body: nl === -1 ? '' : sec.slice(nl + 1).trim() });
        });
    }
    return out;
}

/** Cheap change detector: size+mtime of ledger and handoffs, count+max mtime of ticket files. */
function fingerprint() {
    const st = (p) => (existsSync(p) ? statSync(p) : null);
    const l = st(ledgerPath);
    const handoffs = existsSync(journalDir)
        ? readdirSync(journalDir).filter((n) => /^HANDOFF-.*\.md$/.test(n)).sort().map((n) => {
            const s = statSync(join(journalDir, n));
            return [n, s.size, s.mtimeMs];
        }) : [];
    const tf = walkTickets();
    const r = st(registryPath);
    const retros = [...archiveState(readLedgerRows()).events.values()].map((e) => {
        const rs = e.retro ? st(e.retro) : null;
        return [e.retro || null, rs ? rs.size : null, rs ? rs.mtimeMs : null];
    });
    return {
        ledger: l ? { size: l.size, mtime: l.mtimeMs } : null,
        registry: r ? { size: r.size, mtime: r.mtimeMs } : null,
        retros,
        handoffs,
        tickets: { count: tf.length, maxMtime: Math.max(0, ...tf.map((p) => statSync(p).mtimeMs)) },
    };
}

// ── build ───────────────────────────────────────────────────────────────────

function rebuild() {
    const t0 = Date.now();
    mkdirSync(indexDir, { recursive: true });
    const tmp = join(indexDir, `maestro.sqlite.tmp-${process.pid}`);
    rmSync(tmp, { force: true });
    const fp = fingerprint();
    const rows = readLedgerRows();
    const items = fold(rows);
    const streamOf = new Map(items.map((i) => [i.id, i.stream]));
    const { events: archivedEvents, hidden } = archiveState(rows);
    const archivedStreams = new Set(archivedEvents.keys());
    // A row is hidden when its item is, or (for facts) when its stream is archived.
    const rowHidden = (r) => (r.kind === 'fact' ? archivedStreams.has(mapStream(r.stream)) : hidden.has(r.closes || r.tags || r.carries || r.annotates || r.id));
    const tickets = walkTickets().map(parseTicket);
    const handoffs = readHandoffs();

    const db = new DatabaseSync(tmp);
    try {
        db.exec(`
            CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT);
            CREATE TABLE rows (seq INTEGER PRIMARY KEY, id TEXT, ts TEXT, date TEXT, kind TEXT, text TEXT,
                repo TEXT, ticket TEXT, stream TEXT, closes TEXT, tags TEXT, annotates TEXT, raw TEXT,
                carries TEXT, archived INTEGER);
            CREATE TABLE items (id TEXT PRIMARY KEY, kind TEXT, status TEXT, is_open INTEGER, stream TEXT,
                date TEXT, ts TEXT, text TEXT, repo TEXT, ticket TEXT, closed_by TEXT, closed_at TEXT, archived INTEGER);
            CREATE TABLE tickets (id TEXT, title TEXT, status TEXT, type TEXT, priority TEXT, labels TEXT,
                reviewed TEXT, external TEXT, path TEXT PRIMARY KEY, body TEXT);
            CREATE TABLE handoffs (file TEXT, section INTEGER, heading TEXT, body TEXT, PRIMARY KEY (file, section));
            CREATE VIRTUAL TABLE docs USING fts5(source, ref, title, body, stream UNINDEXED, archived UNINDEXED, tokenize='unicode61');
        `);
        db.exec('BEGIN');
        const ins = (sql) => db.prepare(sql);
        const insRow = ins('INSERT INTO rows VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)');
        const insItem = ins('INSERT OR REPLACE INTO items VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)');
        const insTicket = ins('INSERT OR REPLACE INTO tickets VALUES (?,?,?,?,?,?,?,?,?,?)');
        const insHand = ins('INSERT INTO handoffs VALUES (?,?,?,?)');
        const insDoc = ins('INSERT INTO docs (source, ref, title, body, stream, archived) VALUES (?,?,?,?,?,?)');
        const s = (v) => (v === undefined || v === null ? null : Array.isArray(v) ? v.join(',') : String(v));

        rows.forEach((r, n) => {
            const hide = rowHidden(r) ? 1 : 0;
            insRow.run(n + 1, s(r.id), s(r.ts), s(r.date), s(r.kind), s(r.text), s(r.repo), s(r.ticket),
                s(mapStream(r.stream)), s(r.closes), s(r.tags), s(r.annotates), JSON.stringify(r), s(r.carries), hide);
            const stream = r.closes ? streamOf.get(r.closes) : r.tags ? streamOf.get(r.tags) : r.carries ? streamOf.get(r.carries)
                : streamOf.get(r.id) ?? mapStream(r.stream);
            insDoc.run('ledger', s(r.id) || `row-${n + 1}`, `${r.kind || ''} ${(r.text || '').slice(0, 80)}`.trim(),
                [r.text, r.repo, r.ticket, r.closes && `closes ${r.closes}`].filter(Boolean).join(' '), s(stream), String(hide));
        });
        for (const i of items) {
            insItem.run(i.id, i.kind, i.state, isOpen(i) ? 1 : 0, s(i.stream), s(i.date), s(i.ts), s(i.text),
                s(i.repo), s(i.ticket), i.closedBy ? s(i.closedBy.id) : null, i.closedBy ? s(i.closedBy.ts) : null, hidden.has(i.id) ? 1 : 0);
        }
        for (const t of tickets) {
            insTicket.run(t.id, t.title, t.status, t.type, t.priority, t.labels, t.reviewed, t.external, t.path, t.body);
            insDoc.run('tickets', t.id, t.title, [t.status, t.type, t.labels, t.external, t.body].filter(Boolean).join('\n'), null, '0');
        }
        for (const h of handoffs) {
            insHand.run(h.file, h.section, h.heading, h.body);
            insDoc.run('handoffs', `${h.file}#${h.section}`, h.heading, h.body, null, '0');
        }
        // One pointer per archived stream: the retro's summary, so a default search still finds the epic.
        for (const [stream, e] of archivedEvents) {
            const retro = e.retro && existsSync(e.retro) ? readFileSync(e.retro, 'utf8') : '';
            const summary = (retro.split(/^## Summary\s*$/m)[1] || '').split(/^## /m)[0].trim();
            insDoc.run('archive', stream, `archived stream ${stream}`,
                [`archived ${e.date || ''}`, e.retro && `retro: ${e.retro}`, summary || e.text].filter(Boolean).join('\n'), stream, '0');
        }
        const meta = db.prepare('INSERT INTO meta VALUES (?, ?)');
        meta.run('schema_version', SCHEMA_VERSION);
        meta.run('fingerprint', JSON.stringify(fp));
        meta.run('ledger_rows', String(rows.length));
        meta.run('built_at', new Date().toISOString());
        db.exec('COMMIT');
    } catch (e) {
        try { db.close(); } catch { /* ignore */ }
        rmSync(tmp, { force: true });
        throw e;
    }
    db.close();
    renameSync(tmp, dbPath);
    return { counts: counts(), ms: Date.now() - t0 };
}

function counts() {
    const db = new DatabaseSync(dbPath, { readOnly: true });
    try {
        const out = {};
        for (const t of ['rows', 'items', 'tickets', 'handoffs', 'docs', 'meta']) {
            out[t] = db.prepare(`SELECT count(*) AS n FROM ${t}`).get().n;
        }
        return out;
    } finally { db.close(); }
}

function isStale() {
    if (!existsSync(dbPath)) return true;
    const db = new DatabaseSync(dbPath, { readOnly: true });
    try {
        const get = (k) => db.prepare('SELECT value FROM meta WHERE key = ?').get(k)?.value;
        return get('schema_version') !== SCHEMA_VERSION || get('fingerprint') !== JSON.stringify(fingerprint());
    } catch { return true; } finally { db.close(); }
}

// ── commands ────────────────────────────────────────────────────────────────

function cmdIndex() {
    const { counts: c, ms } = rebuild();
    console.log(Object.entries(c).map(([k, v]) => `${k}=${v}`).join(' ') + `  (${ms} ms)`);
}

function cmdSearch() {
    const query = positional.join(' ').trim();
    if (!query) fail('Usage: ledger-index.mjs search "<fts query>" [--source ledger|tickets|handoffs|archive] [--stream X] [--limit 20] [--json] [--include-archived]');
    const source = arg('source');
    if (source && !['ledger', 'tickets', 'handoffs', 'archive'].includes(source)) fail('--source must be ledger, tickets, handoffs or archive.');
    const limit = Number.parseInt(arg('limit', '20'), 10);
    if (!Number.isInteger(limit) || limit < 1) fail('--limit must be a positive integer.');
    if (isStale()) rebuild();

    const where = ['docs MATCH ?'];
    const params = [query];
    if (source) { where.push('source = ?'); params.push(source); }
    if (arg('stream')) { where.push('stream = ?'); params.push(mapStream(arg('stream'))); }
    if (!withArchived) where.push("archived = '0'");
    const db = new DatabaseSync(dbPath, { readOnly: true });
    const run = (match) => db.prepare(`SELECT source, ref, title, snippet(docs, 3, '[', ']', '…', 14) AS snippet, bm25(docs) AS score
        FROM docs WHERE ${where.join(' AND ')} ORDER BY bm25(docs) LIMIT ${limit}`).all(match, ...params.slice(1));
    // Bare ids such as KEY-1234 or my_db are FTS5 syntax errors; retry with those tokens quoted.
    const quoted = query.replace(/"[^"]*"|\S+/g, (t) => (t.startsWith('"') || /^\w+\*?$/.test(t) || /^(AND|OR|NOT)$/.test(t) ? t : `"${t.replace(/"/g, '')}"`));
    let hits;
    try {
        try { hits = run(query); } catch (e) {
            if (quoted === query) throw e;
            hits = run(quoted);
        }
    } catch (e) {
        if (/fts5|syntax|no such column|unterminated|malformed/i.test(e.message)) {
            fail(`Could not parse search query: ${e.message}\nTry plain words, "quoted phrases", prefix*, AND/OR/NOT.`);
        }
        throw e;
    } finally { db.close(); }

    if (has('json')) { console.log(JSON.stringify(hits, null, 2)); return; }
    if (!hits.length) { console.log('(no hits)'); return; }
    for (const h of hits) console.log(`${h.ref}  [${h.source}]  ${h.title}\n    ${h.snippet.replace(/\s+/g, ' ')}`);
}

function cmdStats() {
    if (isStale()) rebuild();
    const c = counts();
    const db = new DatabaseSync(dbPath, { readOnly: true });
    let streams;
    try {
        streams = db.prepare(`SELECT coalesce(stream, '(none)') AS stream, count(*) AS open FROM items
            WHERE is_open = 1 ${withArchived ? '' : 'AND archived = 0'} GROUP BY 1 ORDER BY 2 DESC, 1`).all();
    } finally { db.close(); }
    const openTotal = streams.reduce((n, r) => n + r.open, 0);
    if (has('json')) { console.log(JSON.stringify({ counts: c, open: openTotal, streams }, null, 2)); return; }
    console.log(Object.entries(c).map(([k, v]) => `${k}=${v}`).join(' '));
    console.log(`open items: ${openTotal}`);
    streams.forEach((r) => console.log(`  ${String(r.open).padStart(4)}  ${r.stream}`));
}

// ── query ───────────────────────────────────────────────────────────────────

const QUERY_HELP = `Usage: ledger-index.mjs query <name> [args] [--json]

Named queries (each rebuilds the index first if a source changed):
  open [--stream X]                         open items, newest first
  by-ticket <ticket-id|external-key>        ledger rows mentioning the id, plus the ticket's own row (matched by id or external tracker key)
  untagged [--since YYYY-MM-DD]             items with no effective stream, by date, then the list
  stream-counts                             open/done/dropped/total per stream; case variants flagged
  handoffs [--limit N]                      handoff files, newest first, with section titles
  tickets [--project P] [--status S] [--type T]   counts by project, type, status; list when filtered
  --sql "<select>"                          arbitrary SQL on a read-only connection

Tables: rows, items, tickets, handoffs, docs, meta.
Every query hides archived streams unless --include-archived; --sql is raw (see the archived columns).`;

const clip = (v, n) => {
    const t = String(v ?? '').replace(/\s+/g, ' ').trim();
    return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};

/** Aligned plain-text table; long cells are clipped to maxCell characters. */
function table(rows, cols = rows.length ? Object.keys(rows[0]) : [], maxCell = 100) {
    if (!rows.length) return '(no rows)';
    const cell = (r, c) => clip(r[c] ?? '', maxCell);
    const w = cols.map((c) => Math.max(c.length, ...rows.map((r) => cell(r, c).length)));
    const line = (vals) => vals.map((v, i) => String(v).padEnd(w[i])).join('  ').trimEnd();
    return [line(cols), line(w.map((n) => '-'.repeat(n))), ...rows.map((r) => line(cols.map((c) => cell(r, c))))].join('\n');
}

const projectOf = (path) => path.match(/Projects\/([^/]+)\/Tickets\//)?.[1] ?? '(unknown)';
const tally = (rows, key) => Object.entries(rows.reduce((m, r) => ((m[r[key] ?? '(none)'] = (m[r[key] ?? '(none)'] || 0) + 1), m), {}))
    .map(([k, count]) => ({ [key]: k, count })).sort((a, b) => b.count - a.count || a[key].localeCompare(b[key]));

/** True when a ticket's `external` is `key` or `<tracker>-key`; the tracker prefix is one word, so `123` never matches `jira-PROJ-123`. */
function externalMatches(external, key) {
    if (!external) return false;
    const ext = external.trim();
    return ext === key || new RegExp(`^[A-Za-z][A-Za-z0-9_]*-${key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`).test(ext);
}

const QUERIES = {
    open(db) {
        const stream = arg('stream') && mapStream(arg('stream'));
        const rows = db.prepare(`SELECT id, coalesce(stream, '(none)') AS stream, kind, date, text, repo FROM items
            WHERE is_open = 1 ${withArchived ? '' : 'AND archived = 0'} ${stream ? 'AND stream = ?' : ''} ORDER BY ts DESC, id`).all(...(stream ? [stream] : []))
            .map((r) => ({ ...r, text: clip(r.text, 100) }));
        return { data: { total: rows.length, items: rows }, text: `open items: ${rows.length}\n${table(rows, ['id', 'stream', 'kind', 'date', 'text', 'repo'])}` };
    },
    'by-ticket'(db) {
        const id = positional[1];
        if (!id) fail('Usage: query by-ticket <ticket-id|external-key>');
        const rows = db.prepare(`SELECT r.id, r.date, r.kind, coalesce(i.stream, r.stream) AS stream, r.ticket, r.text FROM rows r
            LEFT JOIN items i ON i.id = coalesce(r.closes, r.tags, r.carries, r.id)
            WHERE (r.ticket = ?1 OR instr(r.raw, ?1) > 0) ${withArchived ? '' : 'AND r.archived = 0'} ORDER BY r.seq DESC`).all(id)
            .map((r) => ({ ...r, text: clip(r.text, 100) }));
        // A ticket matches by id, or by its `external` tracker key: `<tracker>-KEY` (e.g. jira-PROJ-123) or the bare KEY.
        const tk = db.prepare('SELECT id, title, status, type, external, path FROM tickets').all()
            .filter((t) => t.id === id || externalMatches(t.external, id))
            .map(({ external, ...rest }) => rest);
        return {
            data: { ticket: tk, rows },
            text: `ticket:\n${table(tk, ['id', 'title', 'status', 'type', 'path'])}\n\nledger rows mentioning ${id}: ${rows.length}\n${table(rows, ['id', 'date', 'kind', 'stream', 'ticket', 'text'])}`,
        };
    },
    untagged(db) {
        const since = arg('since');
        if (since && !/^\d{4}-\d{2}-\d{2}$/.test(since)) fail('--since must be YYYY-MM-DD.');
        const rows = db.prepare(`SELECT id, date, kind, status, text, repo FROM items
            WHERE (stream IS NULL OR stream = '') ${withArchived ? '' : 'AND archived = 0'} ${since ? 'AND date >= ?' : ''} ORDER BY date DESC, ts DESC`).all(...(since ? [since] : []))
            .map((r) => ({ ...r, text: clip(r.text, 100) }));
        const byDate = tally(rows, 'date').sort((a, b) => b.date.localeCompare(a.date));
        return {
            data: { total: rows.length, by_date: byDate, items: rows },
            text: `untagged items: ${rows.length}\n${table(byDate)}\n\n${table(rows, ['id', 'date', 'kind', 'status', 'text', 'repo'])}`,
        };
    },
    'stream-counts'(db) {
        const rows = db.prepare(`SELECT coalesce(stream, '(none)') AS stream, sum(is_open) AS open,
            sum(status = 'done') AS done, sum(status = 'dropped') AS dropped, count(*) AS total
            FROM items ${withArchived ? '' : 'WHERE archived = 0'} GROUP BY 1 ORDER BY 5 DESC, 1`).all();
        const spellings = new Map();
        for (const r of rows) spellings.set(r.stream.toLowerCase(), [...(spellings.get(r.stream.toLowerCase()) || []), r.stream]);
        for (const r of rows) {
            const twins = spellings.get(r.stream.toLowerCase());
            r.flag = twins.length > 1 ? `CASE SPLIT: ${twins.join(' / ')}` : '';
        }
        return { data: { streams: rows }, text: table(rows, ['stream', 'open', 'done', 'dropped', 'total', 'flag'], 60) };
    },
    handoffs(db) {
        const limit = Number.parseInt(arg('limit', '20'), 10);
        if (!Number.isInteger(limit) || limit < 1) fail('--limit must be a positive integer.');
        const files = db.prepare('SELECT DISTINCT file FROM handoffs ORDER BY file DESC LIMIT ?').all(limit);
        const out = files.map(({ file }) => ({
            file, sections: db.prepare('SELECT heading FROM handoffs WHERE file = ? ORDER BY section').all(file).map((h) => h.heading),
        }));
        return { data: { handoffs: out }, text: out.length ? out.map((h) => `${h.file}\n${h.sections.map((s) => `    ${clip(s, 100)}`).join('\n')}`).join('\n') : '(no handoffs)' };
    },
    tickets(db) {
        const all = db.prepare('SELECT id, title, status, type, priority, path FROM tickets').all()
            .map((t) => ({ ...t, project: projectOf(t.path) }));
        const filters = ['project', 'status', 'type'].filter((f) => arg(f));
        const rows = all.filter((t) => filters.every((f) => t[f] === arg(f)));
        const data = { total: rows.length, by_project: tally(rows, 'project'), by_type: tally(rows, 'type'), by_status: tally(rows, 'status') };
        let text = `tickets: ${rows.length}${filters.length ? ` (${filters.map((f) => `${f}=${arg(f)}`).join(', ')})` : ''}\n\nby project\n${table(data.by_project)}\n\nby type\n${table(data.by_type)}\n\nby status\n${table(data.by_status)}`;
        if (filters.length) {
            data.tickets = rows.map((t) => ({ id: t.id, project: t.project, type: t.type, status: t.status, title: t.title }));
            text += `\n\n${table(data.tickets, ['id', 'project', 'type', 'status', 'title'])}`;
        }
        return { data, text };
    },
};

function runSql(db, sql) {
    try {
        const rows = db.prepare(sql).all();
        return { data: rows, text: table(rows) };
    } catch (e) {
        if (/readonly|read-only|attempt to write/i.test(e.message)) {
            fail(`query --sql is read-only: write statements (INSERT/UPDATE/DELETE/DROP...) are not allowed. (${e.message})`);
        }
        fail(`SQL error: ${e.message}`);
    }
}

function cmdQuery() {
    const name = positional[0];
    const sql = arg('sql');
    if (has('help') || (!name && !has('sql'))) { console.log(QUERY_HELP); return; }
    if (has('sql') && !sql) fail('Usage: query --sql "<select>"');
    if (!sql && !QUERIES[name]) fail(`Unknown query "${name}".\n\n${QUERY_HELP}`);
    if (isStale()) rebuild();
    const db = new DatabaseSync(dbPath, { readOnly: true });
    try {
        const { data, text } = sql ? runSql(db, sql) : QUERIES[name](db);
        console.log(has('json') ? JSON.stringify(data, null, 2) : text);
    } finally { db.close(); }
}

requireFts5();
try {
    switch (cmd) {
        case 'index': cmdIndex(); break;
        case 'search': cmdSearch(); break;
        case 'stats': cmdStats(); break;
        case 'query': cmdQuery(); break;
        default:
            console.log(readFileSync(new URL(import.meta.url), 'utf8').split('*/')[0].split('/**')[1]
                .split('\n').map((l) => l.replace(/^ \* ?/, '')).join('\n').trim());
            process.exit(cmd ? 1 : 0);
    }
} catch (e) {
    fail(`ledger-index failed: ${e.message}`);
}
