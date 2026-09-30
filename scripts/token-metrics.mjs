#!/usr/bin/env node
/**
 * Token-cost metrics for the orchestrator, read from Claude Code transcripts.
 *
 * Reads ONLY numeric usage fields, the model id, timestamps, and message
 * type/role/origin metadata. Message content is never read: every parsed line
 * goes straight through `pick()`, which copies the allowed fields and drops the
 * rest, and nothing else touches the parsed object. A test enforces this.
 *
 *   node token-metrics.mjs                      today: day summary + sessions
 *   node token-metrics.mjs --date 2026-09-25    one day
 *   node token-metrics.mjs --write              upsert that day's row in the vault table
 *   node token-metrics.mjs --all --write        backfill every day still on disk
 *   node token-metrics.mjs --compare            day vs 7-day median vs baseline
 *   node token-metrics.mjs --curve              cache-read per turn by turn-index bucket
 *   node token-metrics.mjs --json               machine-readable day + sessions
 *
 * Flags: --projects-dir <dir> (default CLAUDE_PROJECTS_DIR in local-config.mjs)
 *        --vault <path> (default $VAULT_ROOT) --project <name> (default dev-env)
 *        --baseline-until YYYY-MM-DD (default 2026-09-24: the week before the habits)
 *
 * Output file: $VAULT/Projects/<project>/Research/token-metrics.md, one row per
 * day. Rewriting a day replaces its row, so reruns are idempotent. The vault
 * table is the durable history: Claude Code prunes old transcripts, the table
 * keeps their numbers.
 *
 * Counting rules:
 * - A turn is one API response, deduplicated by message.id. Claude Code writes
 *   one line per content block (thinking, text, tool_use), each carrying the same
 *   usage; counting lines instead of ids roughly doubles every total.
 * - A wake-up is a user-role line whose origin.kind is not `human`: a
 *   `task-notification` (background task or agent finished) or a `peer`
 *   handback/message (a subagent's report or SendMessage).
 * - Report size is approximate and usage-only: the growth in context between the
 *   assistant turn before a handback and the one after it, minus the earlier
 *   turn's own output. It includes any hook output that arrived with it.
 * - Fresh = input_tokens (uncached). Context = fresh + cache write + cache read.
 */
import { readFileSync, writeFileSync, readdirSync, existsSync, mkdirSync } from 'node:fs';
import { join, basename } from 'node:path';
import { CLAUDE_PROJECTS_DIR, CONTAINER_PROJECT, VAULT_ROOT } from './local-config.mjs';

const TABLE_HEADER = [
    'Date', 'Sessions', 'Turns', 'Prompts', 'Wakes (notif/handback)', 'Output', 'Cache write',
    'Cache read', 'Fresh', 'Read/turn', 'Subagents', 'Sub turns', 'Sub tokens by model', 'Avg report',
    'Sub growth/turn',
];

// --- the only function allowed to look at a parsed transcript line ----------
export function pick(o) {
    const msg = o.message && typeof o.message === 'object' ? o.message : {};
    const u = msg.usage && typeof msg.usage === 'object' ? msg.usage : null;
    const num = (v) => (Number.isFinite(v) ? v : 0);
    return {
        type: typeof o.type === 'string' ? o.type : '',
        subtype: typeof o.subtype === 'string' ? o.subtype : '',
        role: typeof msg.role === 'string' ? msg.role : '',
        ts: typeof o.timestamp === 'string' ? o.timestamp : '',
        id: typeof msg.id === 'string' ? msg.id : '',
        model: typeof msg.model === 'string' ? msg.model : '',
        originKind: o.origin && typeof o.origin.kind === 'string' ? o.origin.kind : '',
        handback: Boolean(o.origin && o.origin.handback !== undefined),
        usage: u && {
            fresh: num(u.input_tokens),
            write: num(u.cache_creation_input_tokens),
            read: num(u.cache_read_input_tokens),
            out: num(u.output_tokens),
        },
    };
}

// --- CLI ---------------------------------------------------------------------
function main(argv) {
    const flag = (n) => argv.includes(`--${n}`);
    const arg = (n, d) => { const i = argv.indexOf(`--${n}`); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
    const projectsDir = arg('projects-dir', CLAUDE_PROJECTS_DIR);
    const vault = arg('vault', VAULT_ROOT);
    const project = arg('project', CONTAINER_PROJECT);
    const date = arg('date', localDate(new Date().toISOString()));
    const baselineUntil = arg('baseline-until', '2026-09-24');

    const { days, sessions, curve } = collect(projectsDir);

    if (flag('curve')) { printCurve(curve); return; }

    const todays = sessions.filter((s) => s.date === date);
    if (flag('json')) {
        console.log(JSON.stringify({ day: days.get(date) || null, sessions: todays }, null, 2));
    } else {
        printDay(date, days.get(date));
        printSessions(todays);
    }

    const tablePath = vault ? join(vault, 'Projects', project, 'Research', 'token-metrics.md') : '';
    if ((flag('write') || flag('compare')) && !vault) {
        console.error('Vault path is not set. Set VAULT_ROOT or pass --vault <path>.');
        process.exit(1);
    }
    let rows = tablePath ? readTable(tablePath) : new Map();
    if (flag('write')) {
        const which = flag('all') ? [...days.keys()] : [date];
        for (const d of which) if (days.has(d)) rows.set(d, toRow(days.get(d)));
        writeTable(tablePath, rows);
        console.log(`\nwrote ${which.filter((d) => days.has(d)).length} row(s) to ${tablePath}`);
    }
    if (flag('compare')) {
        if (days.has(date)) rows = new Map(rows).set(date, toRow(days.get(date)));
        printCompare(date, rows, baselineUntil);
    }
}

// --- collection ----------------------------------------------------------------
export function collect(projectsDir) {
    const days = new Map();
    const sessions = [];
    const curve = new Map();
    const top = readdirSync(projectsDir).filter((f) => f.endsWith('.jsonl'));
    for (const f of top) {
        const sid = basename(f, '.jsonl');
        const main = scanFile(join(projectsDir, f));
        const subDir = join(projectsDir, sid, 'subagents');
        const subs = existsSync(subDir)
            ? readdirSync(subDir).filter((n) => n.endsWith('.jsonl')).map((n) => ({
                type: agentType(join(subDir, n.replace(/\.jsonl$/, '.meta.json'))),
                ...scanFile(join(subDir, n)),
            }))
            : [];
        main.turns.forEach((t, i) => {
            const b = Math.floor(i / 100) * 100;
            const c = curve.get(b) || { n: 0, read: 0 };
            c.n += 1; c.read += t.read; curve.set(b, c);
        });
        const byDate = new Map();
        const bucket = (d) => { if (!byDate.has(d)) byDate.set(d, emptyStats()); return byDate.get(d); };
        for (const t of main.turns) addTurn(bucket(t.date), t);
        for (const e of main.events) addEvent(bucket(e.date), e);
        for (const r of main.reports) { const s = bucket(r.date); s.reportTokens += r.tokens; s.reportCount += 1; }
        for (const sub of subs) {
            if (!sub.turns.length) continue;
            const s = bucket(sub.turns[0].date);
            s.subagents += 1;
            for (const t of sub.turns) {
                const st = bucket(t.date);
                st.subTurns += 1;
                const fam = family(t.model);
                st.subByModel[fam] = (st.subByModel[fam] || 0) + t.fresh + t.write + t.read + t.out;
                if (t.growth !== undefined) { st.subGrowth += t.growth; st.subGrowthN += 1; }
            }
            for (const e of sub.events) if (e.kind === 'task-notification') bucket(e.date).subWakes += 1;
        }
        for (const [d, s] of byDate) {
            sessions.push({ session: sid.slice(0, 8), date: d, ...s });
            const day = days.get(d) || { date: d, sessions: 0, ...emptyStats() };
            if (s.turns) day.sessions += 1;
            merge(day, s);
            days.set(d, day);
        }
    }
    return { days: new Map([...days].sort()), sessions, curve };
}

function scanFile(path) {
    const turns = [];
    const events = [];
    const reports = [];
    const seen = new Map();
    let last = null;
    let pending = null;
    for (const line of readFileSync(path, 'utf8').split('\n')) {
        if (!line) continue;
        let rec;
        try { rec = pick(JSON.parse(line)); } catch { continue; }
        if (rec.type === 'system' && rec.subtype === 'compact_boundary') { pending = null; last = null; continue; }
        if (rec.type === 'assistant' && rec.usage && rec.id) {
            if (seen.has(rec.id)) { Object.assign(seen.get(rec.id), rec.usage); continue; }
            const t = { date: localDate(rec.ts), model: rec.model, ...rec.usage };
            seen.set(rec.id, t);
            if (last) {
                const ctxBefore = last.fresh + last.write + last.read;
                t.growth = Math.max(0, t.fresh + t.write + t.read - ctxBefore - last.out);
            }
            turns.push(t);
            if (pending && last) {
                const delta = t.growth;
                if (delta > 0) for (let k = 0; k < pending.n; k += 1) reports.push({ date: pending.date, tokens: delta / pending.n });
            }
            pending = null;
            last = t;
            continue;
        }
        if (rec.role === 'user' && rec.originKind) {
            const kind = rec.originKind === 'peer' ? (rec.handback ? 'handback' : 'peer') : rec.originKind;
            const e = { date: localDate(rec.ts), kind };
            events.push(e);
            if (kind === 'handback') pending = pending ? { ...pending, n: pending.n + 1 } : { date: e.date, n: 1 };
        }
    }
    return { turns, events, reports };
}

function agentType(metaPath) {
    try { const m = JSON.parse(readFileSync(metaPath, 'utf8')); return typeof m.agentType === 'string' ? m.agentType : 'unknown'; } catch { return 'unknown'; }
}

const emptyStats = () => ({
    turns: 0, prompts: 0, wakesNotif: 0, wakesHandback: 0, peerMsgs: 0,
    out: 0, write: 0, read: 0, fresh: 0,
    subagents: 0, subTurns: 0, subWakes: 0, subByModel: {}, subGrowth: 0, subGrowthN: 0, reportTokens: 0, reportCount: 0,
});
function addTurn(s, t) { s.turns += 1; s.out += t.out; s.write += t.write; s.read += t.read; s.fresh += t.fresh; }
function addEvent(s, e) {
    if (e.kind === 'human') s.prompts += 1;
    else if (e.kind === 'task-notification') s.wakesNotif += 1;
    else if (e.kind === 'handback') s.wakesHandback += 1;
    else if (e.kind === 'peer') s.peerMsgs += 1;
}
function merge(a, b) {
    for (const [k, v] of Object.entries(b)) {
        if (k === 'subByModel') for (const [m, n] of Object.entries(v)) a.subByModel[m] = (a.subByModel[m] || 0) + n;
        else if (typeof v === 'number') a[k] = (a[k] || 0) + v;
    }
}
export function family(model) {
    const m = /(opus|sonnet|haiku|fable)/i.exec(model || '');
    return m ? m[1].toLowerCase() : 'other';
}
export function localDate(iso) {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return 'unknown';
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

// --- formatting ------------------------------------------------------------------
export function compact(n) {
    if (!Number.isFinite(n)) return '-';
    const a = Math.abs(n);
    if (a >= 1e9) return `${(n / 1e9).toFixed(2)}B`;
    if (a >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
    if (a >= 1e3) return `${(n / 1e3).toFixed(1)}k`;
    return String(Math.round(n));
}
export function uncompact(s) {
    const m = /^(-?[\d.]+)([kMB]?)/.exec(String(s).trim());
    if (!m) return NaN;
    return Number(m[1]) * ({ k: 1e3, M: 1e6, B: 1e9 }[m[2]] || 1);
}
const avgReport = (s) => (s.reportCount ? s.reportTokens / s.reportCount : NaN);
const readPerTurn = (s) => (s.turns ? s.read / s.turns : NaN);
const subGrowth = (s) => (s.subGrowthN ? s.subGrowth / s.subGrowthN : NaN);
const byModel = (s) => Object.entries(s.subByModel).filter(([, n]) => n > 0).sort((a, b) => b[1] - a[1]).map(([m, n]) => `${m} ${compact(n)}`).join(' · ') || '-';

export function toRow(s) {
    return [
        s.date, s.sessions, s.turns, s.prompts, `${s.wakesNotif + s.wakesHandback} (${s.wakesNotif}/${s.wakesHandback})`,
        compact(s.out), compact(s.write), compact(s.read), compact(s.fresh), compact(readPerTurn(s)),
        s.subagents, s.subTurns, byModel(s), compact(avgReport(s)), compact(subGrowth(s)),
    ].map(String);
}

function printDay(date, s) {
    if (!s) { console.log(`${date}: no orchestrator turns on disk.`); return; }
    console.log(`Day ${date}: ${s.sessions} session(s), ${s.turns} turns, ${s.prompts} prompts`);
    console.log(`  tokens   out ${compact(s.out)} · cache write ${compact(s.write)} · cache read ${compact(s.read)} · fresh ${compact(s.fresh)} · read/turn ${compact(readPerTurn(s))}`);
    console.log(`  wake-ups ${s.wakesNotif} task-notification · ${s.wakesHandback} handback · ${s.peerMsgs} peer message`);
    console.log(`  subagents ${s.subagents} · ${s.subTurns} turns · ${s.subWakes} background wake-ups inside subagents · ${byModel(s)}`);
    console.log(`  subagent context growth ≈ ${compact(subGrowth(s))} tokens/turn (tool results + hooks)`);
    console.log(`  avg report ≈ ${compact(avgReport(s))} tokens over ${s.reportCount} handback(s)`);
}
function printSessions(list) {
    if (!list.length) return;
    console.log('\nSession   Turns  Prompts  Wakes  Read/turn  Cache read  Subagents');
    for (const s of list.sort((a, b) => b.read - a.read)) {
        console.log(`${s.session}  ${String(s.turns).padStart(5)}  ${String(s.prompts).padStart(7)}  ${String(s.wakesNotif + s.wakesHandback).padStart(5)}  ${compact(readPerTurn(s)).padStart(9)}  ${compact(s.read).padStart(10)}  ${String(s.subagents).padStart(9)}`);
    }
}
function printCurve(curve) {
    console.log('Turn index  Turns  Avg cache-read/turn   (orchestrator sessions, all days)');
    for (const [b, c] of [...curve].sort((x, y) => x[0] - y[0])) {
        console.log(`${String(b).padStart(5)}-${String(b + 99).padEnd(5)} ${String(c.n).padStart(6)}  ${compact(c.read / c.n).padStart(8)}`);
    }
}

// --- the vault table ---------------------------------------------------------------
export function readTable(path) {
    const rows = new Map();
    if (!existsSync(path)) return rows;
    for (const line of readFileSync(path, 'utf8').split('\n')) {
        const m = /^\|\s*(\d{4}-\d{2}-\d{2})\s*\|/.exec(line);
        if (m) rows.set(m[1], line.split('|').slice(1, -1).map((c) => c.trim()));
    }
    return rows;
}
export function writeTable(path, rows) {
    mkdirSync(join(path, '..'), { recursive: true });
    const intro = [
        '---', 'tags: [maestro, tokens, metrics]', '---', '',
        '# Token metrics, one row per day',
        '',
        'Generated by `the-maestro/scripts/token-metrics.mjs --write`. Rerunning a day replaces its row; edit anything above the table freely, the table itself is regenerated.',
        '',
        'Turns are API responses deduplicated by message id. Wakes are orchestrator turns started by a task notification or a subagent handback. Avg report is the approximate context growth per handback. Loop and experiments: [[token-usage-strategies#Self-correcting loop]].',
        '',
    ];
    let head = intro;
    if (existsSync(path)) {
        const lines = readFileSync(path, 'utf8').split('\n');
        const at = lines.findIndex((l) => l.startsWith('| Date |'));
        if (at > 0) head = lines.slice(0, at);
    }
    const body = [...rows].sort((a, b) => a[0].localeCompare(b[0])).map(([, cells]) => `| ${cells.join(' | ')} |`);
    const align = TABLE_HEADER.map((h, i) => (i === 0 || i === 12 ? '---' : '---:')).join('|');
    const table = [`| ${TABLE_HEADER.join(' | ')} |`, `|${align}|`, ...body];
    writeFileSync(path, `${[...head, ...table].join('\n')}\n`);
}

// --- comparison ------------------------------------------------------------------------
// Key metrics, read back from table cells so pruned days still compare.
const cell = (i) => (r) => uncompact(r[i]);
const ratio = (i, j) => (r) => { const d = uncompact(r[j]); return d ? uncompact(r[i]) / d : NaN; };
const METRICS = [
    ['Turns', cell(2)], ['Wakes', cell(4)], ['Output', cell(5)], ['Cache read', cell(7)],
    ['Read/turn', cell(9)], ['Read/prompt', ratio(7, 3)], ['Read/subagent', ratio(7, 10)],
    ['Avg report', cell(13)], ['Sub growth', cell(14)],
];
export function median(xs) {
    const v = xs.filter(Number.isFinite).sort((a, b) => a - b);
    if (!v.length) return NaN;
    const m = Math.floor(v.length / 2);
    return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2;
}
export function compare(date, rows, baselineUntil) {
    const all = [...rows].sort((a, b) => a[0].localeCompare(b[0]));
    const today = rows.get(date);
    const prior7 = all.filter(([d]) => d < date).slice(-7).map(([, r]) => r);
    const base = all.filter(([d]) => d <= baselineUntil && d < date).map(([, r]) => r);
    return METRICS.map(([name, val]) => {
        const t = today ? val(today) : NaN;
        const m7 = median(prior7.map(val));
        const b = median(base.map(val));
        const pct = (x) => (Number.isFinite(x) && x ? (t - x) / x : NaN);
        return { name, today: t, median7: m7, baseline: b, vs7: pct(m7), vsBase: pct(b), regression: pct(m7) > 0.2 };
    });
}
function printCompare(date, rows, baselineUntil) {
    const fmtPct = (p) => (Number.isFinite(p) ? `${p >= 0 ? '+' : ''}${Math.round(p * 100)}%` : '-');
    console.log(`\nCompare ${date} · 7-day median of prior rows · baseline = median of days ≤ ${baselineUntil}`);
    console.log('Metric         Today     7d med    vs 7d   Baseline  vs base');
    for (const c of compare(date, rows, baselineUntil)) {
        console.log(`${c.name.padEnd(13)} ${compact(c.today).padStart(8)} ${compact(c.median7).padStart(9)} ${fmtPct(c.vs7).padStart(7)} ${compact(c.baseline).padStart(9)} ${fmtPct(c.vsBase).padStart(7)}${c.regression ? '  REGRESSION >20%' : ''}`);
    }
}

if (import.meta.url === `file://${process.argv[1]}`) main(process.argv.slice(2));
