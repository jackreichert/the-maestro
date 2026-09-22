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
 *   journal.mjs log "<text>" [--kind done] [--repo x] [--ticket id] [--date YYYY-MM-DD]
 *   journal.mjs start "<text>" [--repo x]     open a work item (kind: wip)
 *   journal.mjs done <id|text>                close a wip as finished
 *   journal.mjs drop <id> [--why "..."]       close a wip as abandoned
 *   journal.mjs ask "<question>"              something awaiting the user
 *   journal.mjs resolve <id> [--answer "..."] close a question/decision
 *   journal.mjs status [--full]               what is open + done today
 *   journal.mjs standup [--date YYYY-MM-DD]   formatted end-of-day summary
 *   journal.mjs roll [--date YYYY-MM-DD]      archive finished work to a dated note
 *   journal.mjs render                        rebuild CURRENT.md from the ledger
 *
 * Kinds: wip | done | blocked | question | decision | note
 * Common flags: --vault <path> --project <name> --json --dry-run
 */
import { readFileSync, writeFileSync, appendFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const DEFAULT_VAULT = process.env.VAULT_ROOT || '';
const KINDS = ['wip', 'done', 'blocked', 'question', 'decision', 'note', 'resolved', 'dropped', 'rolled'];
// Kinds that keep an item on the board until something closes it.
const OPEN_KINDS = ['wip', 'blocked', 'question', 'decision'];
const isOpen = (i) => !i.closedBy && OPEN_KINDS.includes(i.kind);

const argv = process.argv.slice(2);
const cmd = argv[0];

function isFlagValue(a) {
    const i = argv.indexOf(a);
    return i > 0 && argv[i - 1].startsWith('--');
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
function fold(entries) {
    const byId = new Map();
    const closed = new Map();
    for (const e of entries) {
        if (e.closes) closed.set(e.closes, e);
        if (e.id) byId.set(e.id, e);
    }
    const items = [];
    for (const e of entries) {
        if (!e.id || e.closes || e.kind === 'rolled') continue;
        const close = closed.get(e.id);
        items.push({ ...e, closedBy: close || null, state: close ? close.kind : e.kind });
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

function fmt(i, { showId = true } = {}) {
    const bits = [];
    if (showId) bits.push(`\`${i.id}\``);
    bits.push(i.text);
    const tail = [];
    if (i.repo) tail.push(i.repo);
    if (i.ticket) tail.push(`[[${i.ticket}]]`);
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
        agent: arg('agent') || undefined,
        refs: (arg('ref') || '').split(',').map((s) => s.trim()).filter(Boolean),
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
            out.push(`- ${fmt(i, { showId: false })}${note}`);
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
    append({ id: newId(readLedger()), ts: now(), date: d, kind: 'rolled', text: `archived ${done.length} item(s)` });
    render(true);
    console.log(`archived ${done.length} finished item(s) -> ${dest}`);
    console.log(`kept open: ${g.inflight.length} in flight, ${g.awaiting.length} awaiting you`);
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
    case 'status': cmdStatus(); break;
    case 'standup': cmdStandup(); break;
    case 'roll': cmdRoll(); break;
    case 'render': render(); break;
    default:
        console.log(readFileSync(new URL(import.meta.url)).toString().split('*/')[0].split('/**')[1]
            .split('\n').map((l) => l.replace(/^ \* ?/, '')).join('\n').trim());
        process.exit(cmd ? 1 : 0);
}
