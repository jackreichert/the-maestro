#!/usr/bin/env node
/**
 * Working ledger for the multi-repo orchestrator.
 *
 * Answers "what did we do today, and what is still open" without anyone having
 * to ask. Append-only, so it survives context compaction and session restarts.
 *
 * Storage lives in $VAULT_ROOT/Projects/{project}/Journal/.
 * --project is required. There is no default project name.
 *
 *   ledger.jsonl     append-only source of truth, one JSON object per line
 *   CURRENT.md       GENERATED view of what is open + done today
 *   YYYY-MM-DD.md    GENERATED daily archive, written by `roll`
 *
 * The JSONL is the source of truth precisely so the markdown can be read and
 * edited freely without breaking anything. Regenerate with `render`.
 *
 *   journal.mjs log "<text>" --model "<name>" --used "skill:x,tool:y" [--kind note]
 *   journal.mjs start "<text>" --model "<name>" --used "skill:x,tool:y" [--repo x]
 *   journal.mjs done <id|text> --model "<name>" --used "skill:x,tool:y"
 *   journal.mjs drop <id> --model "<name>" --used "skill:x,tool:y" [--why "..."]
 *   journal.mjs ask "<question>" --model "<name>" --used "skill:x,tool:y"
 *   journal.mjs resolve <id> --model "<name>" --used "skill:x,tool:y" [--answer "..."]
 *   journal.mjs stamp <id> --model "<name>" --used "skill:x,tool:y"
 *   journal.mjs stamp-missing [--model unrecorded] [--used unrecorded] [--tokens unmeasured]
 *   journal.mjs usage [--open]                counts of model and used marks across items
 *   journal.mjs status [--full]               what is open + done today, with usage marks
 *   journal.mjs standup [--date YYYY-MM-DD]   end-of-day summary for the team, no usage marks
 *   journal.mjs roll [--date YYYY-MM-DD]      archive finished work to a dated note
 *   journal.mjs render                        rebuild CURRENT.md from the ledger
 *
 * Every new entry requires --model and --used. --tokens and --harness are optional.
 * Do not invent either. Unknown history is `unrecorded`, unmeasured tokens are
 * `unmeasured`. --allow-unmarked is only for tests and migrations.
 *
 * Kinds: wip | done | blocked | question | decision | note | resolved | dropped | rolled | stamp
 * Common flags: --vault <path> --project <name> --json --dry-run
 */
import { readFileSync, writeFileSync, appendFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const DEFAULT_VAULT = process.env.VAULT_ROOT || '';
const KINDS = ['wip', 'done', 'blocked', 'question', 'decision', 'note', 'resolved', 'dropped', 'rolled', 'stamp'];
// Kinds that keep an item on the board until something closes it.
const OPEN_KINDS = ['wip', 'blocked', 'question', 'decision'];
const isOpen = (i) => !i.closedBy && OPEN_KINDS.includes(i.kind);

const argv = process.argv.slice(2);
const cmd = argv[0];

const BOOL_FLAGS = new Set(['--json', '--dry-run', '--full', '--open', '--allow-unmarked']);
function isFlagValue(a) {
    const i = argv.indexOf(a);
    return i > 0 && argv[i - 1].startsWith('--') && !BOOL_FLAGS.has(argv[i - 1]);
}
const positional = argv.slice(1).filter((a) => !a.startsWith('--') && !isFlagValue(a));
function arg(name, fallback = null) {
    const i = argv.indexOf(`--${name}`);
    return i !== -1 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : fallback;
}
const has = (name) => argv.includes(`--${name}`);

const dryRun = has('dry-run');
const asJson = has('json');
const vault = arg('vault', DEFAULT_VAULT);
if (!vault) {
    console.error('Vault path is not set. Ask where the Obsidian vault lives, then set VAULT_ROOT or pass --vault <path>.');
    process.exit(1);
}
const project = arg('project');
if (!project) {
    console.error('Pass --project <container-folder-name>. There is no default.');
    process.exit(1);
}
const dir = join(vault, 'Projects', project, 'Journal');
const ledgerPath = join(dir, 'ledger.jsonl');

const today = () => new Date().toISOString().slice(0, 10);
/**
 * A roll is recorded in the ledger with a timestamp, not inferred from the
 * archive file existing. Work finished AFTER a roll still shows in CURRENT.md,
 * so rolling at 5pm does not hide the evening's work.
 */
function rollPoint(entries, d) {
    const marks = entries.filter((e) => e.kind === 'rolled' && e.date === d);
    return marks.length ? marks[marks.length - 1].ts : null;
}
const now = () => new Date().toISOString();

function ensureDir() {
    if (!dryRun) mkdirSync(dir, { recursive: true });
}

function readLedger() {
    if (!existsSync(ledgerPath)) return [];
    return readFileSync(ledgerPath, 'utf8')
        .split('\n')
        .filter((l) => l.trim())
        .map((l, i) => {
            try { return JSON.parse(l); } catch { console.error(`  skipped malformed line ${i + 1}`); return null; }
        })
        .filter(Boolean);
}

function append(entry) {
    ensureDir();
    if (dryRun) { console.log('[dry-run]', JSON.stringify(entry)); return entry; }
    appendFileSync(ledgerPath, JSON.stringify(entry) + '\n');
    return entry;
}

/** Short, collision-checked, human-typeable id. */
function newId(existing) {
    const taken = new Set(existing.map((e) => e.id));
    for (let n = 0; ; n++) {
        const id = Math.random().toString(36).slice(2, 6);
        if (!taken.has(id) && !/^\d+$/.test(id)) return id;
        if (n > 500) return `${Date.now()}`.slice(-6);
    }
}

/**
 * Fold the append-only log into current state. Later entries referencing an
 * earlier id (via `closes`) supersede it.
 */
function withStamp(entry, stamped) {
    const mark = entry?.id ? stamped.get(entry.id) : null;
    if (!mark) return entry;
    return {
        ...entry,
        model: mark.model ?? entry.model,
        used: mark.used ?? entry.used,
        tokens: mark.tokens ?? entry.tokens,
        harness: mark.harness ?? entry.harness,
    };
}

const MARK_FIELDS = ['model', 'used', 'tokens', 'harness'];
/** Later stamps win field by field, so a partial stamp never erases an earlier one. */
function mergeMark(prev, next) {
    const out = { ...(prev || {}) };
    for (const f of MARK_FIELDS) if (next[f] !== undefined) out[f] = next[f];
    return out;
}

function fold(entries) {
    const byId = new Map();
    const stamped = new Map();
    for (const e of entries) {
        if (e.annotates) stamped.set(e.annotates, mergeMark(stamped.get(e.annotates), e));
        if (e.id && !e.annotates) byId.set(e.id, e);
    }
    const closed = new Map();
    for (const e of entries) {
        if (e.closes) closed.set(e.closes, withStamp(e, stamped));
    }
    const items = [];
    for (const e of entries) {
        if (!e.id || e.closes || e.annotates || e.kind === 'rolled' || e.kind === 'stamp') continue;
        const base = withStamp(e, stamped);
        const close = closed.get(e.id) || null;
        items.push({ ...base, closedBy: close, state: close ? close.kind : base.kind });
    }
    return { items, byId };
}

function resolveTarget(items, needle) {
    if (!needle) return null;
    const exact = items.find((i) => i.id === needle);
    if (exact) return exact;
    const open = items.filter(isOpen);
    const matches = open.filter((i) => i.text.toLowerCase().includes(needle.toLowerCase()));
    if (matches.length === 1) return matches[0];
    if (matches.length > 1) {
        console.error(`"${needle}" matches ${matches.length} open items:`);
        matches.forEach((m) => console.error(`  ${m.id}  ${m.text}`));
        process.exit(1);
    }
    return null;
}

function parseList(name) {
    const raw = arg(name);
    if (!raw) return undefined;
    const list = raw.split(',').map((s) => s.trim()).filter(Boolean);
    return list.length ? list : undefined;
}

function usageFromArgs() {
    const model = arg('model');
    const used = parseList('used');
    if (!has('allow-unmarked') && (!model || !used)) {
        console.error('Every ledger entry needs --model "<name>" and --used "skill:x,tool:y".');
        console.error('Do not guess. Unknown is --model unrecorded --used unrecorded. Tests may pass --allow-unmarked.');
        process.exit(1);
    }
    const usage = {};
    if (model) usage.model = model;
    if (used) usage.used = used;
    if (arg('tokens')) usage.tokens = arg('tokens');
    if (arg('harness')) usage.harness = arg('harness');
    if (arg('agent')) usage.agent = arg('agent');
    return usage;
}

function formatUsed(used) {
    if (!used) return null;
    return Array.isArray(used) ? used.join(', ') : String(used);
}

function usageSuffix(i) {
    const model = i.model || 'unrecorded';
    const used = formatUsed(i.used) || 'unrecorded';
    const bits = [`model: ${model}`, `used: ${used}`];
    if (i.closedBy?.model && i.closedBy.model !== i.model) {
        bits[0] = `model: ${model} → ${i.closedBy.model}`;
    }
    if (i.harness) bits.push(`harness: ${i.harness}`);
    if (i.tokens) bits.push(`tokens: ${i.tokens}`);
    return bits.join(' · ');
}

function fmt(i, { showId = true, showUsage = true } = {}) {
    const bits = [];
    if (showId) bits.push(`\`${i.id}\``);
    bits.push(i.text);
    const tail = [];
    if (i.repo) tail.push(i.repo);
    if (i.ticket) tail.push(`[[${i.ticket}]]`);
    if (showUsage) tail.push(usageSuffix(i));
    if (tail.length) bits.push(`— ${tail.join(' · ')}`);
    return bits.join(' ');
}

// ── commands ────────────────────────────────────────────────────────────────

function cmdLog(kindDefault = 'note') {
    const text = arg('text') || positional.join(' ');
    if (!text) { console.error('Needs text: journal.mjs log "what happened"'); process.exit(1); }
    const kind = arg('kind', kindDefault);
    if (!KINDS.includes(kind)) { console.error(`kind must be one of: ${KINDS.join(', ')}`); process.exit(1); }

    const entries = readLedger();
    const entry = {
        id: newId(entries),
        ts: now(),
        date: arg('date', today()),   // backdate when reconstructing
        kind,
        text,
        repo: arg('repo') || undefined,
        ticket: arg('ticket') || undefined,
        refs: (arg('ref') || '').split(',').map((s) => s.trim()).filter(Boolean),
        ...usageFromArgs(),
    };
    append(entry);
    if (!dryRun) render(true);
    console.log(`${entry.kind}  ${entry.id}  ${entry.text}`);
    return entry;
}

function cmdClose(newKind) {
    const needle = positional[0];
    const { items } = fold(readLedger());
    const target = resolveTarget(items, needle);
    if (!target) { console.error(`No open item matching "${needle}".`); process.exit(1); }

    const entries = readLedger();
    const note = arg('answer') || arg('why') || null;
    append({
        id: newId(entries),
        ts: now(),
        date: today(),
        kind: newKind,
        closes: target.id,
        text: note || target.text,
        repo: target.repo,
        ticket: arg('ticket') || target.ticket,
        ...usageFromArgs(),
    });
    if (!dryRun) render(true);
    console.log(`${newKind}  ${target.id}  ${target.text}${note ? `\n      ${note}` : ''}`);
}

function groups() {
    const entries = readLedger();
    const { items } = fold(entries);
    const open = items.filter(isOpen);
    return {
        items,
        inflight: open.filter((i) => i.kind === 'wip'),
        blocked: open.filter((i) => i.kind === 'blocked'),
        awaiting: open.filter((i) => i.kind === 'question' || i.kind === 'decision'),
        decidedOn: (d) => items.filter((i) => i.closedBy?.kind === 'resolved' && i.closedBy.date === d),
        rollPointOn: (d) => rollPoint(entries, d),
        doneOn: (d, { sinceRoll = false } = {}) => {
            const cut = sinceRoll ? rollPoint(entries, d) : null;
            const after = (ts) => !cut || ts > cut;
            return items
                .filter((i) => i.closedBy?.kind === 'done' && i.closedBy.date === d && after(i.closedBy.ts))
                .concat(items.filter((i) => i.state === 'done' && i.date === d && !i.closedBy && after(i.ts)));
        },
        notesOn: (d) => items.filter((i) => i.state === 'note' && i.date === d),
        dates: [...new Set(items.map((i) => i.date))].sort(),
    };
}

function cmdStatus() {
    const g = groups();
    const d = arg('date', today());
    const rolledAt = g.rollPointOn(d);
    const done = g.doneOn(d, { sinceRoll: true });

    if (asJson) {
        console.log(JSON.stringify({
            date: d,
            inflight: g.inflight, blocked: g.blocked, awaiting: g.awaiting, done,
        }, null, 2));
        return;
    }

    const line = (label, arr) => {
        if (!arr.length) return;
        console.log(`\n${label}`);
        arr.forEach((i) => console.log(`  ${fmt(i)}`));
    };
    console.log(`Ledger — ${d}`);
    line('In flight', g.inflight);
    line('Blocked', g.blocked);
    line('Awaiting you', g.awaiting);
    line(`Done ${d}`, done);
    if (rolledAt) console.log(`\n  (${g.doneOn(d).length - done.length} earlier item(s) archived to ${d}.md)`);
    if (has('full')) line('Notes', g.notesOn(d));
    if (!g.inflight.length && !g.blocked.length && !g.awaiting.length && !done.length) {
        console.log('\n  (empty)');
    }
    console.log(`\n  ${done.length} done · ${g.inflight.length} in flight · ${g.awaiting.length} awaiting you`);
}

function standupText(d) {
    const g = groups();
    const done = g.doneOn(d);
    const out = [`# Standup — ${d}`, ''];

    const section = (title, arr, empty) => {
        out.push(`## ${title}`, '');
        if (!arr.length) { out.push(empty, ''); return; }
        arr.forEach((i) => {
            const note = i.closedBy && i.closedBy.text !== i.text ? ` — ${i.closedBy.text}` : '';
            out.push(`- ${fmt(i, { showId: false, showUsage: false })}${note}`);
        });
        out.push('');
    };

    section('Shipped', done, '_Nothing closed._');
    section('In flight', g.inflight, '_Nothing running._');
    section('Blocked', g.blocked, '_Nothing blocked._');
    section('Awaiting you', g.awaiting, '_No open questions._');

    const decided = g.decidedOn(d);
    if (decided.length) {
        out.push('## Decided', '');
        decided.forEach((i) => out.push(`- ${i.text} — ${i.closedBy.text}`));
        out.push('');
    }

    const notes = g.notesOn(d);
    if (notes.length) section('Notes', notes, '');
    return out.join('\n');
}

function cmdStandup() {
    console.log(standupText(arg('date', today())));
}

function render(quiet = false) {
    const g = groups();
    const d = today();
    const rolledDates = g.dates.filter((x) => g.rollPointOn(x));

    const out = [
        '---',
        'generated: true',
        `updated: ${d}`,
        '---',
        '',
        '# Current ledger',
        '',
        '> Generated from `ledger.jsonl` by `journal.mjs render`. Edits here are',
        '> overwritten — the JSONL is the source of truth. Dated archives are',
        '> written once and are yours to edit.',
        '',
    ];

    const section = (title, arr) => {
        out.push(`## ${title}`, '');
        if (!arr.length) { out.push('_none_', ''); return; }
        arr.forEach((i) => out.push(`- ${fmt(i)}`));
        out.push('');
    };

    section('In flight', g.inflight);
    section('Blocked', g.blocked);
    section('Awaiting you', g.awaiting);
    section(`Done today (${d})`, g.doneOn(d, { sinceRoll: true }));
    if (g.rollPointOn(d)) out.push(`Earlier today archived -> [[${d}]]`, '');

    if (rolledDates.length) {
        out.push('## Archive', '');
        rolledDates.slice().reverse().forEach((x) => out.push(`- [[${x}]]`));
        out.push('');
    }
    out.push('---', '', 'See CONTEXT.md in this project folder for durable project context.', '');

    if (dryRun) { if (!quiet) console.log(out.join('\n')); return; }
    ensureDir();
    writeFileSync(join(dir, 'CURRENT.md'), out.join('\n'));
    if (!quiet) console.log(`wrote ${join(dir, 'CURRENT.md')}`);
}

/**
 * Compression. Writes the day's finished work to a dated note and drops it out
 * of CURRENT.md, leaving a link. Open items are NOT archived — they stay
 * visible until they are actually closed.
 */
function cmdRoll() {
    const d = arg('date', today());
    const g = groups();
    const done = g.doneOn(d);
    const notes = g.notesOn(d);

    if (!done.length && !notes.length) {
        console.log(`Nothing finished on ${d} to archive.`);
        return;
    }

    const dest = join(dir, `${d}.md`);
    const body = [
        '---',
        `date: ${d}`,
        'type: journal',
        '---',
        '',
        standupText(d),
        '',
        '---',
        '',
        `_Archived from the working ledger. Still-open items stay in [[CURRENT]]._`,
        '',
    ].join('\n');

    if (dryRun) { console.log(body); return; }
    ensureDir();
    writeFileSync(dest, body);
    append({
        id: newId(readLedger()), ts: now(), date: d, kind: 'rolled', text: `archived ${done.length} item(s)`,
        model: 'n/a', used: ['tool:journal.mjs'], tokens: 'n/a',
    });
    render(true);
    console.log(`archived ${done.length} finished item(s) -> ${dest}`);
    console.log(`kept open: ${g.inflight.length} in flight, ${g.awaiting.length} awaiting you`);
}

/** Annotate one existing entry (an item or a closing row) without rewriting the JSONL. */
function cmdStamp() {
    const needle = positional[0];
    const entries = readLedger();
    const target = entries.find((e) => e.id === needle && !e.annotates)
        || resolveTarget(fold(entries).items, needle);
    if (!target) { console.error(`No entry matching "${needle}".`); process.exit(1); }
    append({
        id: newId(entries), ts: now(), date: today(), kind: 'stamp', annotates: target.id,
        text: `stamp ${target.id}`, ...usageFromArgs(),
    });
    if (!dryRun) render(true);
    console.log(`stamp  ${target.id}  ${target.text}`);
}

/**
 * Mark every entry that has no model or no used. Only missing fields are
 * written, and an entry already marked is skipped, so re-running is a no-op.
 */
function cmdStampMissing() {
    const entries = readLedger();
    const marks = new Map();
    for (const e of entries) if (e.annotates) marks.set(e.annotates, mergeMark(marks.get(e.annotates), e));
    const fill = {
        model: arg('model', 'unrecorded'),
        used: parseList('used') || ['unrecorded'],
        tokens: arg('tokens', 'unmeasured'),
    };
    const taken = [...entries];
    let count = 0;
    for (const e of entries) {
        if (!e.id || e.annotates || e.kind === 'stamp') continue;
        const cur = { ...e, ...(marks.get(e.id) || {}) };
        if (cur.model && cur.used) continue;
        const add = {};
        for (const f of ['model', 'used', 'tokens']) if (cur[f] === undefined) add[f] = fill[f];
        const row = { id: newId(taken), ts: now(), date: today(), kind: 'stamp', annotates: e.id, text: `stamp ${e.id}`, ...add };
        taken.push(row);
        append(row);
        count++;
    }
    if (!dryRun && count) render(true);
    console.log(`stamped ${count} entr${count === 1 ? 'y' : 'ies'}${dryRun ? ' (dry-run)' : ''}`);
}

function cmdUsage() {
    const { items } = fold(readLedger());
    const pool = has('open') ? items.filter(isOpen) : items;
    const models = new Map();
    const used = new Map();
    const bump = (m, k) => m.set(k, (m.get(k) || 0) + 1);
    for (const i of pool) {
        bump(models, i.model || 'unrecorded');
        (Array.isArray(i.used) ? i.used : [i.used || 'unrecorded']).forEach((x) => bump(used, x));
    }
    const sorted = (m) => [...m].sort((a, b) => b[1] - a[1]);
    if (asJson) {
        console.log(JSON.stringify({ items: pool.length, model: Object.fromEntries(sorted(models)), used: Object.fromEntries(sorted(used)) }, null, 2));
        return;
    }
    console.log(`Usage marks — ${pool.length} item(s)${has('open') ? ' open' : ''}`);
    console.log('\nModel');
    sorted(models).forEach(([k, n]) => console.log(`  ${String(n).padStart(4)}  ${k}`));
    console.log('\nUsed');
    sorted(used).forEach(([k, n]) => console.log(`  ${String(n).padStart(4)}  ${k}`));
}

// ── dispatch ────────────────────────────────────────────────────────────────

switch (cmd) {
    case 'log': cmdLog('note'); break;
    case 'start': cmdLog('wip'); break;
    case 'ask': cmdLog('question'); break;
    case 'note': cmdLog('note'); break;
    case 'done': cmdClose('done'); break;
    case 'drop': cmdClose('dropped'); break;
    case 'resolve': cmdClose('resolved'); break;
    case 'stamp': cmdStamp(); break;
    case 'stamp-missing': cmdStampMissing(); break;
    case 'usage': cmdUsage(); break;
    case 'status': cmdStatus(); break;
    case 'standup': cmdStandup(); break;
    case 'roll': cmdRoll(); break;
    case 'render': render(); break;
    default:
        console.log(readFileSync(new URL(import.meta.url)).toString().split('*/')[0].split('/**')[1]
            .split('\n').map((l) => l.replace(/^ \* ?/, '')).join('\n').trim());
        process.exit(cmd ? 1 : 0);
}
