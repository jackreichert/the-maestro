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
 * - Model mix: per model family (opus/sonnet/haiku/other), cache-read tokens and input-equivalent units
 *   (fresh 1, cache write 1.25, cache read 0.1, output 5), over orchestrator and subagent turns. The priced mix
 *   multiplies units by `model_price_weights`; with none set only the token mix is shown. No prices are built in.
 * - Turns since compact: the orchestrator turn count since the last compaction marker (compact_boundary or an
 *   isCompactSummary flag); a day keeps its longest run. A small agent finished in under 10 turns.
 * - Targets (`cost_targets`) turn the cost metrics into PASS/MISS in the day summary and --compare.
 * - Fresh = input_tokens (uncached). Context = fresh + cache write + cache read.
 */
import { readFileSync, writeFileSync, readdirSync, existsSync, mkdirSync, statSync } from 'node:fs';
import { join, basename } from 'node:path';
import { CLAUDE_PROJECTS_DIR, CONTAINER_PROJECT, VAULT_ROOT, ROLL_TURNS, ROLL_READ_PER_TURN, COST_TARGETS, MODEL_PRICE_WEIGHTS } from './local-config.mjs';

const TABLE_HEADER = [
    'Date', 'Sessions', 'Turns', 'Prompts', 'Wakes (notif/handback)', 'Output', 'Cache write',
    'Cache read', 'Fresh', 'Read/turn', 'Subagents', 'Sub turns', 'Sub tokens by model', 'Avg report',
    'Sub growth/turn', 'Read by model', 'Units by model', 'Max turns since compact', 'Small agents', 'Opus subagents', 'Opus sub tokens',
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
        // Compaction markers are two metadata flags, never the summary text: the system line with subtype
        // `compact_boundary`, and the `isCompactSummary` boolean on the user line that carries the summary.
        compact: (o.type === 'system' && o.subtype === 'compact_boundary') || o.isCompactSummary === true,
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

    const warning = emptyDirWarning(projectsDir);
    if (warning) console.error(warning);
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
    if (days.has(date)) rows = new Map(rows).set(date, toRow(days.get(date)));
    if (flag('compare')) printCompare(date, rows, baselineUntil);
    else if (!flag('json') && days.has(date)) printCost(date, rows, baselineUntil);
}

// --- collection ----------------------------------------------------------------
/** Session transcripts directly in `dir` (empty when it does not exist). */
function sessionFiles(dir) {
    return existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith('.jsonl')) : [];
}

/**
 * A warning when `dir` holds no sessions, else ''. Unset `projects_dir` falls back to the transcript directory of the
 * process's working directory (local-config.mjs), which is empty or missing when the script runs from anywhere else.
 */
export function emptyDirWarning(dir) {
    if (sessionFiles(dir).length) return '';
    return `token-metrics: no sessions in ${dir}${existsSync(dir) ? '' : ' (directory does not exist)'}. Set projects_dir in local-config (or MAESTRO_PROJECTS_DIR, or --projects-dir); unset, it defaults to the transcript directory of the current working directory.`;
}

export function collect(projectsDir) {
    const days = new Map();
    const sessions = [];
    const curve = new Map();
    const top = sessionFiles(projectsDir);
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
            if (sub.turns.length < SMALL_AGENT_TURNS) s.subSmall += 1;
            if (sub.turns.some((t) => family(t.model) === 'opus')) s.subOpus += 1;
            for (const t of sub.turns) {
                const st = bucket(t.date);
                st.subTurns += 1;
                addMix(st, t);
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

/** The most recently modified session in `dir`: { session, turns, readPerTurn }, or null when there is none. */
export function currentSession(dir) {
    const newest = sessionFiles(dir)
        .map((f) => ({ f, t: statSync(join(dir, f)).mtimeMs }))
        .sort((a, b) => b.t - a.t)[0];
    if (!newest) return null;
    const { turns } = scanFile(join(dir, newest.f));
    const read = turns.reduce((n, t) => n + t.read, 0);
    return { session: basename(newest.f, '.jsonl').slice(0, 8), turns: turns.length, readPerTurn: turns.length ? read / turns.length : 0 };
}

/**
 * The status-footer Session line for the current session, e.g.
 * `**Session:** 86 turns (48% of 180 roll) · 129k read/turn`. At 100% of either threshold it ends with `roll now`.
 * With no session on disk it says so rather than vanishing, so a misconfigured projects_dir is visible.
 */
export function sessionLine(dir, rollTurns = ROLL_TURNS, rollRead = ROLL_READ_PER_TURN) {
    let s;
    try { s = currentSession(dir); } catch (e) { return `**Session:** unavailable (${e.code || e.message.split('\n')[0]} reading ${dir})`; }
    if (!s) return `**Session:** unavailable (no sessions in ${dir}; set projects_dir)`;
    const roll = s.turns >= rollTurns || s.readPerTurn >= rollRead;
    return `**Session:** ${s.turns} turns (${Math.floor((s.turns / rollTurns) * 100)}% of ${rollTurns} roll) · ${Math.floor(s.readPerTurn / 1000)}k read/turn${roll ? ' · roll now' : ''}`;
}

function scanFile(path) {
    const turns = [];
    const events = [];
    const reports = [];
    const seen = new Map();
    let last = null;
    let pending = null;
    let since = 0;
    for (const line of readFileSync(path, 'utf8').split('\n')) {
        if (!line) continue;
        let rec;
        try { rec = pick(JSON.parse(line)); } catch { continue; }
        if (rec.compact) { pending = null; last = null; since = 0; continue; }
        if (rec.type === 'assistant' && rec.usage && rec.id) {
            if (seen.has(rec.id)) { Object.assign(seen.get(rec.id), rec.usage); continue; }
            since += 1;
            const t = { date: localDate(rec.ts), model: rec.model, since, ...rec.usage };
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
    mix: {}, sinceCompact: 0, subSmall: 0, subOpus: 0,
});
function addTurn(s, t) {
    s.turns += 1; s.out += t.out; s.write += t.write; s.read += t.read; s.fresh += t.fresh;
    s.sinceCompact = Math.max(s.sinceCompact, t.since);
    addMix(s, t);
}
/** Per model family, cache-read tokens and input-equivalent units (see UNIT_WEIGHTS), orchestrator and subagent turns alike. */
function addMix(s, t) {
    const m = s.mix[family(t.model)] || (s.mix[family(t.model)] = { read: 0, units: 0 });
    m.read += t.read;
    m.units += t.fresh * UNIT_WEIGHTS.fresh + t.write * UNIT_WEIGHTS.write + t.read * UNIT_WEIGHTS.read + t.out * UNIT_WEIGHTS.out;
}
function addEvent(s, e) {
    if (e.kind === 'human') s.prompts += 1;
    else if (e.kind === 'task-notification') s.wakesNotif += 1;
    else if (e.kind === 'handback') s.wakesHandback += 1;
    else if (e.kind === 'peer') s.peerMsgs += 1;
}
function merge(a, b) {
    for (const [k, v] of Object.entries(b)) {
        if (k === 'subByModel') for (const [m, n] of Object.entries(v)) a.subByModel[m] = (a.subByModel[m] || 0) + n;
        else if (k === 'mix') for (const [m, x] of Object.entries(v)) { const c = a.mix[m] || (a.mix[m] = { read: 0, units: 0 }); c.read += x.read; c.units += x.units; }
        else if (k === 'sinceCompact') a[k] = Math.max(a[k] || 0, v);
        else if (typeof v === 'number') a[k] = (a[k] || 0) + v;
    }
}
/** Cost of each token kind relative to one fresh input token. */
export const UNIT_WEIGHTS = { fresh: 1, write: 1.25, read: 0.1, out: 5 };
/** A subagent that finished in fewer turns than this is "small": cheaper done inline than dispatched. */
export const SMALL_AGENT_TURNS = 10;
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

/** A mix cell: `opus 1200000 · sonnet 300000`, families with nothing left out; `-` when empty. Read back by parseMix. */
export function mixCell(mix, key) {
    // Whole numbers, not compact(): PASS/MISS is scored from these cells, and 1-decimal k/M rounding can flip a verdict near a target.
    return Object.entries(mix || {}).filter(([, v]) => v[key] > 0).sort((a, b) => b[1][key] - a[1][key]).map(([m, v]) => `${m} ${Math.round(v[key])}`).join(' · ') || '-';
}
/** The family totals back out of a mix cell: { opus: 1.2e6, sonnet: 3e5 }. */
export function parseMix(text) {
    const out = {};
    for (const m of String(text || '').matchAll(/([a-z]+) (\d[\d.]*[kMB]?)/g)) out[m[1]] = uncompact(m[2]);
    return out;
}

export function toRow(s) {
    return [
        s.date, s.sessions, s.turns, s.prompts, `${s.wakesNotif + s.wakesHandback} (${s.wakesNotif}/${s.wakesHandback})`,
        compact(s.out), compact(s.write), compact(s.read), compact(s.fresh), compact(readPerTurn(s)),
        s.subagents, s.subTurns, byModel(s), compact(avgReport(s)), compact(subGrowth(s)),
        mixCell(s.mix, 'read'), mixCell(s.mix, 'units'), s.sinceCompact, s.subSmall, s.subOpus, compact(s.subByModel.opus || 0),
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
    console.log(`  model mix (cache read) ${mixLine(shares(readMix(s.mix), null))}`);
    const w = MODEL_PRICE_WEIGHTS;
    console.log(`  model mix (priced)     ${w ? mixLine(shares(unitMix(s.mix), w)) : 'price weights unset (model_price_weights): token mix only'}`);
}
const readMix = (mix) => Object.fromEntries(Object.entries(mix).map(([f, v]) => [f, v.read]));
const unitMix = (mix) => Object.fromEntries(Object.entries(mix).map(([f, v]) => [f, v.units]));
const mixLine = (sh) => FAMILIES.map((f) => `${f} ${fmtValue(sh[f], 'pct')}`).join(' · ');
function printSessions(list) {
    if (!list.length) return;
    console.log('\nSession   Turns  Prompts  Wakes  Read/turn  Cache read  Subagents  Max since compact');
    for (const s of list.sort((a, b) => b.read - a.read)) {
        console.log(`${s.session}  ${String(s.turns).padStart(5)}  ${String(s.prompts).padStart(7)}  ${String(s.wakesNotif + s.wakesHandback).padStart(5)}  ${compact(readPerTurn(s)).padStart(9)}  ${compact(s.read).padStart(10)}  ${String(s.subagents).padStart(9)}  ${String(s.sinceCompact).padStart(17)}`);
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
    // Rows written before a column existed are padded so every row is as wide as the header.
    const body = [...rows].sort((a, b) => a[0].localeCompare(b[0])).map(([, cells]) => `| ${TABLE_HEADER.map((h, i) => cells[i] ?? '-').join(' | ')} |`);
    const align = TABLE_HEADER.map((h, i) => ([0, 12, 15, 16].includes(i) ? '---' : '---:')).join('|');
    const table = [`| ${TABLE_HEADER.join(' | ')} |`, `|${align}|`, ...body];
    writeFileSync(path, `${[...head, ...table].join('\n')}\n`);
}

// --- comparison ------
const FAMILIES = ['opus', 'sonnet', 'haiku'];
/**
 * Share of each family in `mix` ({ family: amount }), as fractions. With `weights`, each amount is multiplied by its family's
 * price weight first and a family with no weight drops out of the denominator. NaN for every family when nothing is left.
 */
export function shares(mix, weights) {
    // Any family that is not opus, sonnet or haiku (fable included) takes the optional `other` weight.
    const w = (f) => (weights ? (FAMILIES.includes(f) ? weights[f] : weights.other) || 0 : 1);
    const total = Object.entries(mix).reduce((n, [f, v]) => n + v * w(f), 0);
    return Object.fromEntries(FAMILIES.map((f) => [f, total > 0 ? ((mix[f] || 0) * w(f)) / total : NaN]));
}

// Key metrics, read back from table cells so pruned days still compare.
const cell = (i) => (r) => uncompact(r[i]);
const ratio = (i, j) => (r) => { const d = uncompact(r[j]); return d ? uncompact(r[i]) / d : NaN; };
const share = (col, fam, weights) => (r) => shares(parseMix(r[col]), weights)[fam];
const smallRate = (r) => { const n = uncompact(r[10]); return n ? uncompact(r[18]) / n : NaN; };
const CORE_METRICS = [
    ['Turns', cell(2)], ['Wakes', cell(4)], ['Output', cell(5)], ['Cache read', cell(7)],
    ['Read/turn', cell(9), { cost: true, target: ['read_per_turn_max', 1, 'max'] }], ['Read/prompt', ratio(7, 3)], ['Read/subagent', ratio(7, 10)],
    ['Avg report', cell(13)], ['Sub growth', cell(14)],
];
/**
 * Every metric as [name, getter over a table row, options]. Options: cost (shown in the day summary), fmt (n, pct or ratio),
 * worse (up, down or none: which move counts as a regression), target ([config key, scale, max|min]) or trend (lower is better, no target).
 * Priced shares exist only when `weights` is set. Columns are the table's: 4 wakes, 15 read by model, 16 units by model,
 * 17 max turns since compact, 18 small agents, 19 Opus subagents, 20 Opus sub tokens.
 */
export function metricList(weights = MODEL_PRICE_WEIGHTS) {
    const pct = { cost: true, fmt: 'pct' };
    return [
        ...CORE_METRICS,
        ['Opus share (read)', share(15, 'opus'), { ...pct, target: ['opus_share_max', 0.01, 'max'] }],
        ['Sonnet share (read)', share(15, 'sonnet'), { ...pct, worse: 'none' }],
        ['Haiku share (read)', share(15, 'haiku'), { ...pct, worse: 'down', target: ['haiku_share_min', 0.01, 'min'] }],
        ...(weights ? [
            ['Opus share (priced)', share(16, 'opus', weights), { ...pct, target: ['opus_priced_share_max', 0.01, 'max'] }],
            ['Sonnet share (priced)', share(16, 'sonnet', weights), { ...pct, worse: 'none' }],
            ['Haiku share (priced)', share(16, 'haiku', weights), { ...pct, worse: 'down', target: ['haiku_priced_share_min', 0.01, 'min'] }],
        ] : []),
        ['Wakes/prompt', ratio(4, 3), { cost: true, fmt: 'ratio', target: ['wakes_per_prompt_max', 1, 'max'] }],
        ['Max turns/compact', cell(17), { cost: true, target: ['turns_since_compact_max', 1, 'max'] }],
        ['Small-agent rate', smallRate, { cost: true, fmt: 'pct', trend: true }],
        ['Opus subagents', cell(19), { cost: true, worse: 'none' }],
        ['Opus sub tokens', cell(20), { cost: true, worse: 'none' }],
    ];
}
export function median(xs) {
    const v = xs.filter(Number.isFinite).sort((a, b) => a - b);
    if (!v.length) return NaN;
    const m = Math.floor(v.length / 2);
    return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2;
}
/**
 * Each metric for `date` against the 7 rows before it and the baseline rows. `opts.targets` and `opts.weights` default to the config.
 * `status` is PASS or MISS against a target, '-' when there is no target or no number today.
 */
export function compare(date, rows, baselineUntil, opts = {}) {
    const targets = opts.targets || COST_TARGETS;
    const all = [...rows].sort((a, b) => a[0].localeCompare(b[0]));
    const today = rows.get(date);
    const prior7 = all.filter(([d]) => d < date).slice(-7).map(([, r]) => r);
    const base = all.filter(([d]) => d <= baselineUntil && d < date).map(([, r]) => r);
    return metricList(opts.weights === undefined ? MODEL_PRICE_WEIGHTS : opts.weights).map(([name, val, o = {}]) => {
        const t = today ? val(today) : NaN;
        const m7 = median(prior7.map(val));
        const b = median(base.map(val));
        const pct = (x) => (Number.isFinite(x) && x ? (t - x) / x : NaN);
        const [key, scale, dir] = o.target || [];
        const limit = key && Number.isFinite(targets[key]) ? targets[key] * scale : NaN;
        const worse = o.worse || 'up';
        const status = !Number.isFinite(limit) || !Number.isFinite(t) ? '-' : (dir === 'max' ? t <= limit : t >= limit) ? 'PASS' : 'MISS';
        return {
            name, today: t, median7: m7, baseline: b, vs7: pct(m7), vsBase: pct(b), fmt: o.fmt || 'n', cost: Boolean(o.cost),
            limit: Number.isFinite(limit) ? limit : NaN, dir, trend: Boolean(o.trend), status,
            regression: worse === 'up' ? pct(m7) > 0.2 : worse === 'down' ? pct(m7) < -0.2 : false,
        };
    });
}
export function fmtValue(n, fmt = 'n') {
    if (!Number.isFinite(n)) return '-';
    if (fmt === 'pct') return `${Math.round(n * 100)}%`;
    if (fmt === 'ratio') return n.toFixed(2);
    return compact(n);
}
const fmtPct = (p) => (Number.isFinite(p) ? `${p >= 0 ? '+' : ''}${Math.round(p * 100)}%` : '-');
const targetText = (c) => (c.trend ? 'lower is better' : Number.isFinite(c.limit) ? `${c.dir === 'max' ? '<=' : '>='}${fmtValue(c.limit, c.fmt)}` : '-');

function printMetrics(list) {
    console.log('Metric                 Today     7d med    vs 7d   Baseline  vs base  Target           Status');
    for (const c of list) {
        console.log(`${c.name.padEnd(21)} ${fmtValue(c.today, c.fmt).padStart(8)} ${fmtValue(c.median7, c.fmt).padStart(9)} ${fmtPct(c.vs7).padStart(7)} ${fmtValue(c.baseline, c.fmt).padStart(9)} ${fmtPct(c.vsBase).padStart(7)}  ${targetText(c).padEnd(15)}  ${c.status}${c.regression ? '  REGRESSION >20%' : ''}`);
    }
    if (!MODEL_PRICE_WEIGHTS) console.log('Price weights are unset: only the token mix is shown. Set model_price_weights (opus=1, sonnet=<ratio>, haiku=<ratio>) from your billing console.');
    console.log('Opus subagents: each should be design, decision or review work.');
}
function printCompare(date, rows, baselineUntil) {
    console.log(`\nCompare ${date} · 7-day median of prior rows · baseline = median of days <= ${baselineUntil}`);
    printMetrics(compare(date, rows, baselineUntil));
}
/** The day summary's cost block: the cost metrics only, same columns as --compare. */
function printCost(date, rows, baselineUntil) {
    console.log(`\nCost targets ${date} · 7-day median of prior rows · baseline = median of days <= ${baselineUntil}`);
    printMetrics(compare(date, rows, baselineUntil).filter((c) => c.cost));
}

if (import.meta.url === `file://${process.argv[1]}`) main(process.argv.slice(2));
