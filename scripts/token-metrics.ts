#!/usr/bin/env node
/**
 * Token-cost metrics for the orchestrator, read from Claude Code transcripts.
 *
 * Reads ONLY numeric usage fields, the model id, timestamps, and message
 * type/role/origin metadata. Message content is never read: every parsed line
 * goes straight through `pick()`, which copies the allowed fields and drops the
 * rest, and nothing else touches the parsed object. A test enforces this.
 *
 *   node token-metrics.ts                      today: day summary + sessions
 *   node token-metrics.ts --date 2026-09-25    one day
 *   node token-metrics.ts --write              upsert that day's row in the vault table
 *   node token-metrics.ts --all --write        backfill every day still on disk
 *   node token-metrics.ts --compare            day vs 7-day median vs baseline
 *   node token-metrics.ts --expiry             cache-expiry rewrites per day: count, average gap, dollars
 *   node token-metrics.ts --curve              cache-read per turn by turn-index bucket
 *   node token-metrics.ts --leaks              avoidable spend by bucket, ranked, with the fix for each
 *   node token-metrics.ts --json               machine-readable day + sessions
 *
 * Flags: --projects-dir <dir> (default CLAUDE_PROJECTS_DIR in local-config.ts)
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
 * - Model mix: per model family (opus/sonnet/haiku/other), cache-read tokens over orchestrator and subagent turns.
 * - Estimated dollars: tokens by kind (fresh, 5m cache write, 1h cache write, cache read, output) per family, priced
 *   from `model_prices` (dollars per MTok), reported for the orchestrator and for subagents, by model and by category
 *   (read / write / output / input). A write counts as 5m unless usage splits it (cache_creation). The priced mix is each
 *   family's share of those dollars. With no `model_prices` only the token mix is shown; no prices are built in.
 * - Cache-expiry rewrite: a turn whose gap since the previous turn in the same transcript is over 5 minutes (EXPIRY_GAP_SEC) and
 *   which writes at least EXPIRY_MIN_WRITE tokens to the 5-minute cache. The prompt cache had lapsed, so the turn paid to write the
 *   whole context again instead of reading it. Its cost is those 5m write tokens at the family's write price; a 1h write is not
 *   counted (it cannot have expired in under an hour). The first turn of a transcript and the first after a compaction have no
 *   gap and are never counted. Orchestrator and subagent transcripts both count. `--expiry` lists it per day.
 * - Turns since compact: the orchestrator turn count since the last compaction marker (compact_boundary or an
 *   isCompactSummary flag); a day keeps its longest run. A small agent finished in under 10 turns.
 * - Targets (`cost_targets`) turn the cost metrics into PASS/MISS in the day summary and --compare.
 * - Fresh = input_tokens (uncached). Context = fresh + cache write + cache read.
 */
import { readFileSync, writeFileSync, readdirSync, existsSync, mkdirSync, statSync, realpathSync } from 'node:fs';
import { join, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ModelPrice } from './local-config.ts';
import { family } from './lib/model-family.ts';
import { readAutocompact, triggerTokens } from './lib/autocompact.ts';
import { sessionText } from './lib/session-text.ts';
import { leaks, formatLeaks } from './lib/leaks.ts';
import type { Transcripts } from './lib/leaks.ts';
import { toolReadOnly } from './lib/tool-class.ts';
import { EXPIRY_GAP_SEC, EXPIRY_MIN_WRITE, isExpiryRewrite } from './lib/expiry.ts';
import { FAMILIES, kindsOf, dollars, priceKey } from './lib/pricing.ts';
import type { Usage, Kinds, Dollars } from './lib/pricing.ts';
import type { SessionStatus } from './lib/session-text.ts';
import { CLAUDE_PROJECTS_DIR, PROJECTS_DIR_GUESSED, CONTAINER_PROJECT, VAULT_ROOT, ROLL_WARN_PCT, ROLL_AT_PCT, COST_TARGETS, MODEL_PRICES } from './local-config.ts';
import { printJson } from './lib/json-out.ts';


/** The only fields of a transcript line that survive `pick`. */
export interface Picked {
    type: string; subtype: string; role: string; ts: string; id: string; model: string; originKind: string;
    handback: boolean; compact: boolean; usage: Usage | null; tools: ToolUse[]; results: ToolResult[];
}
/** A tool call: its id, tool name, whether it only reads, and the basename of the file it names ('' when none). Never the input itself. */
export interface ToolUse { id: string; name: string; readOnly: boolean; file: string }
/** A tool result: the id of the call it answers and the size of its content in characters. Never the content. */
export interface ToolResult { id: string; chars: number }
/** A tool result carried into the context: which tool and file it came from, and its size in tokens (estimated from characters). */
export interface CarriedResult { tool: string; file: string; tokens: number }
/** A deduplicated API response. `growth` is context growth since the previous turn (unset for the first). */
export { EXPIRY_GAP_SEC, EXPIRY_MIN_WRITE, isExpiryRewrite };
export type { Usage, Kinds, Dollars };
export { kindsOf, dollars };
export interface Turn extends Usage { date: string; model: string; since: number; growth?: number; gapSec?: number; tools?: ToolUse[]; results?: CarriedResult[] }
export interface TurnEvent { date: string; kind: string }
export interface ScanResult { turns: Turn[]; events: TurnEvent[]; reports: { date: string; tokens: number }[] }
export type FamilyKinds = Record<string, Kinds>;
export type Prices = Record<string, ModelPrice> | null;
/** One day's (or one session's) counters, as emptyStats builds them. */
export interface Stats {
    turns: number; prompts: number; wakesNotif: number; wakesHandback: number; peerMsgs: number;
    out: number; write: number; read: number; fresh: number;
    subagents: number; subTurns: number; subWakes: number; subByModel: Record<string, number>; subGrowth: number; subGrowthN: number;
    reportTokens: number; reportCount: number;
    expiryTurns: number; expiryGapSec: number; expiryByFamily: FamilyKinds;
    mix: Record<string, { read: number }>; orch: FamilyKinds; sub: FamilyKinds; sinceCompact: number; subSmall: number; subOpus: number;
}
export type DayStats = Stats & { date: string; sessions: number };
export type SessionStats = Stats & { session: string; date: string };
/** A table row: one cell of text per TABLE_HEADER column. */
export type TableRow = string[];
export type MetricGetter = (row: TableRow) => number;
export interface MetricOptions { cost?: boolean; fmt?: string; worse?: string; target?: [string, number, string]; trend?: boolean }
export type Metric = [string, MetricGetter, MetricOptions?];
export interface Comparison {
    name: string; today: number; median7: number; baseline: number; vs7: number; vsBase: number; fmt: string; cost: boolean;
    limit: number; dir: string | undefined; trend: boolean; status: string; regression: boolean;
}

/** A parsed JSON value as an object, or null when it is not one. */
const obj = (v: unknown): Record<string, unknown> | null => (v && typeof v === 'object' ? (v as Record<string, unknown>) : null);
const TABLE_HEADER = [
    'Date', 'Sessions', 'Turns', 'Prompts', 'Wakes (notif/handback)', 'Output', 'Cache write',
    'Cache read', 'Fresh', 'Read/turn', 'Subagents', 'Sub turns', 'Sub tokens by model', 'Avg report',
    'Sub growth/turn', 'Read by model', 'Orchestrator tokens by model', 'Max turns since compact', 'Small agents', 'Opus subagents', 'Opus sub tokens',
    'Subagent tokens by model', 'Expiry rewrites', 'Expiry write tokens by model',
];

/** Characters per token, for sizing tool results (which carry no usage of their own). */
export const CHARS_PER_TOKEN = 4;
const str = (v: unknown): string => (typeof v === 'string' ? v : '');
/** Content blocks of a message; a plain string content has none. */
const blocksOf = (content: unknown): Record<string, unknown>[] => (Array.isArray(content) ? content.map((b) => obj(b) ?? {}) : []);
/** Length of a tool result's content in characters: a string, or the text blocks of an array. The text itself is not kept. */
const sizeOf = (content: unknown): number => (typeof content === 'string' ? content.length : blocksOf(content).reduce((n, b) => n + str(b.text).length, 0));
const toolUses = (blocks: Record<string, unknown>[]): ToolUse[] => blocks.filter((b) => b.type === 'tool_use').map((b) => {
    const input = obj(b.input) ?? {};
    const name = str(b.name);
    return { id: str(b.id), name, readOnly: toolReadOnly(name, str(input.command)), file: basename(str(input.file_path) || str(input.notebook_path) || str(input.path)) };
});
const toolResults = (blocks: Record<string, unknown>[]): ToolResult[] => blocks.filter((b) => b.type === 'tool_result').map((b) => ({ id: str(b.tool_use_id), chars: sizeOf(b.content) }));

// --- the only function allowed to look at a parsed transcript line ----------
export function pick(parsed: unknown): Picked {
    // A null line throws here, as before, and scanFile skips it.
    const o = parsed as Record<string, unknown>;
    const msg = obj(o.message) ?? {};
    const u = obj(msg.usage);
    const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
    // The 5m/1h split of cache writes: two numeric fields of `cache_creation`, absent on older transcripts.
    const cc = obj(u?.cache_creation) ?? {};
    const origin = obj(o.origin);
    const blocks = blocksOf(msg.content);
    return {
        type: typeof o.type === 'string' ? o.type : '',
        subtype: typeof o.subtype === 'string' ? o.subtype : '',
        role: typeof msg.role === 'string' ? msg.role : '',
        ts: typeof o.timestamp === 'string' ? o.timestamp : '',
        id: typeof msg.id === 'string' ? msg.id : '',
        model: typeof msg.model === 'string' ? msg.model : '',
        originKind: typeof origin?.kind === 'string' ? origin.kind : '',
        handback: Boolean(origin && origin.handback !== undefined),
        tools: msg.role === 'assistant' ? toolUses(blocks) : [],
        results: msg.role === 'user' ? toolResults(blocks) : [],
        // Compaction markers are two metadata flags, never the summary text: the system line with subtype
        // `compact_boundary`, and the `isCompactSummary` boolean on the user line that carries the summary.
        compact: (o.type === 'system' && o.subtype === 'compact_boundary') || o.isCompactSummary === true,
        usage: u && {
            fresh: num(u.input_tokens),
            write: num(u.cache_creation_input_tokens),
            write5m: num(cc.ephemeral_5m_input_tokens),
            write1h: num(cc.ephemeral_1h_input_tokens),
            read: num(u.cache_read_input_tokens),
            out: num(u.output_tokens),
        },
    };
}

// --- CLI ---------------------------------------------------------------------
function main(argv: string[]): void {
    const flag = (n: string): boolean => argv.includes(`--${n}`);
    const arg = (n: string, d: string): string => { const i = argv.indexOf(`--${n}`); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
    const projectsDir = arg('projects-dir', CLAUDE_PROJECTS_DIR);
    const vault = arg('vault', VAULT_ROOT);
    const project = arg('project', CONTAINER_PROJECT);
    const date = arg('date', localDate(new Date().toISOString()));
    const baselineUntil = arg('baseline-until', '2026-09-24');

    const warning = emptyDirWarning(projectsDir);
    if (warning) console.error(warning);
    if (flag('leaks')) { printLeaks(projectsDir); return; }
    const { days, sessions, curve } = collect(projectsDir);

    if (flag('curve')) { printCurve(curve); return; }
    if (flag('expiry')) { printExpiry(days); return; }

    const todays = sessions.filter((s) => s.date === date);
    if (flag('json')) {
        printJson({ day: days.get(date) || null, sessions: todays });
    } else {
        printDay(date, days.get(date));
        printSessions(todays);
    }

    const tablePath = vault ? join(vault, 'Projects', project, 'Research', 'token-metrics.md') : '';
    if ((flag('write') || flag('compare')) && !vault) {
        console.error('Vault path is not set. Set VAULT_ROOT or pass --vault <path>.');
        process.exit(1);
    }
    let rows: Map<string, TableRow> = tablePath ? readTable(tablePath) : new Map();
    if (flag('write')) {
        const which = flag('all') ? [...days.keys()] : [date];
        for (const d of which) if (days.has(d)) rows.set(d, toRow(days.get(d) as DayStats));
        writeTable(tablePath, rows);
        console.log(`\nwrote ${which.filter((d) => days.has(d)).length} row(s) to ${tablePath}`);
    }
    if (days.has(date)) rows = new Map(rows).set(date, toRow(days.get(date) as DayStats));
    if (flag('compare')) printCompare(date, rows, baselineUntil);
    else if (!flag('json') && days.has(date)) printCost(date, rows, baselineUntil);
}

/** Every transcript's turns: the orchestrator's, and each subagent's with its agent type. */
export function collectTranscripts(projectsDir: string): Transcripts {
    const out: Transcripts = { orch: [], subs: [] };
    for (const f of sessionFiles(projectsDir)) {
        out.orch.push(scanFile(join(projectsDir, f)).turns);
        const subDir = join(projectsDir, basename(f, '.jsonl'), 'subagents');
        if (!existsSync(subDir)) continue;
        for (const n of readdirSync(subDir).filter((x) => x.endsWith('.jsonl'))) {
            out.subs.push({ type: agentType(join(subDir, n.replace(/\.jsonl$/, '.meta.json'))), turns: scanFile(join(subDir, n)).turns });
        }
    }
    return out;
}

function printLeaks(projectsDir: string): void {
    if (!MODEL_PRICES) { console.log('Model prices are unset, so there are no dollars to rank. Set model_prices (or MAESTRO_MODEL_PRICES).'); return; }
    console.log(formatLeaks(leaks(collectTranscripts(projectsDir), MODEL_PRICES)));
}

// --- collection ----------------------------------------------------------------
/** Session transcripts directly in `dir` (empty when it does not exist). */
function sessionFiles(dir: string): string[] {
    return existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith('.jsonl')) : [];
}

/** Whether `dir` is the configured default and that default was only guessed from the working directory. */
const guessedFromCwd = (dir: string): boolean => PROJECTS_DIR_GUESSED && dir === CLAUDE_PROJECTS_DIR;

/**
 * A warning when `dir` holds no sessions, else ''. Unset `projects_dir` follows `container_root`, else the working
 * directory (local-config.ts); the working directory is the wrong folder when the script runs from anywhere else, so
 * when it was the guess the warning says so.
 */
export function emptyDirWarning(dir: string, guessed: boolean = guessedFromCwd(dir)): string {
    if (sessionFiles(dir).length) return '';
    return `token-metrics: no sessions in ${dir}${existsSync(dir) ? '' : ' (directory does not exist)'}. Set projects_dir or container_root in local-config (or MAESTRO_PROJECTS_DIR, MAESTRO_CONTAINER_ROOT, or --projects-dir).${guessed ? GUESS_NOTE : ''}`;
}

const GUESS_NOTE = ' Neither is set, so this folder is only a guess from the current working directory.';

export function collect(projectsDir: string): { days: Map<string, DayStats>; sessions: SessionStats[]; curve: Map<number, { n: number; read: number }> } {
    const days = new Map<string, DayStats>();
    const sessions: SessionStats[] = [];
    const curve = new Map<number, { n: number; read: number }>();
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
        const byDate = new Map<string, Stats>();
        const bucket = (d: string): Stats => { if (!byDate.has(d)) byDate.set(d, emptyStats()); return byDate.get(d) as Stats; };
        for (const t of main.turns) { addTurn(bucket(t.date), t); addExpiry(bucket(t.date), t); }
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
                addMix(st, t, 'sub');
                addExpiry(st, t);
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

/**
 * The most recently modified session in `dir`: { session, turns, turnsBefore, readPerTurn, ctx }, or null when there is none. The figures cover only
 * the run since the last compaction marker (the turns from the last one with since === 1 onward), not the whole transcript; `turnsBefore` is the
 * turns the transcript holds before that run (0 when it never compacted), so the footer can say a compaction happened.
 * `ctx` is the last turn's context (fresh + cache write + cache read), 0 with no turns.
 */
export function currentSession(dir: string, sessionId?: string): { session: string; turns: number; turnsBefore: number; readPerTurn: number; ctx: number } | null {
    const newest = sessionId !== undefined ? sessionFileById(dir, sessionId) : newestSessionFile(dir);
    if (!newest) return null;
    const all = scanFile(newest).turns;
    const turns = all.slice(Math.max(0, all.findLastIndex((t) => t.since === 1)));
    const read = turns.reduce((n, t) => n + t.read, 0);
    const lastTurn = turns.at(-1);
    return { session: basename(newest, '.jsonl').slice(0, 8), turns: turns.length, turnsBefore: all.length - turns.length, readPerTurn: turns.length ? read / turns.length : 0, ctx: lastTurn ? lastTurn.fresh + lastTurn.write + lastTurn.read : 0 };
}

/** The full path of the most recently modified session transcript in `dir`, or null when there is none. The one place "newest session" is decided. */
export function newestSessionFile(dir: string): string | null {
    const newest = sessionFiles(dir)
        .map((f) => ({ f, t: statSync(join(dir, f)).mtimeMs }))
        .sort((a, b) => b.t - a.t)[0];
    return newest ? join(dir, newest.f) : null;
}

/**
 * The transcript of session `id` in `dir` (the exact id, else the one transcript whose name starts with it), or null when none or
 * several match. An id that is not plain word characters and hyphens never matches, so it cannot name a path outside `dir`.
 */
export function sessionFileById(dir: string, id: string): string | null {
    if (!/^[\w-]+$/.test(id)) return null;
    const names = sessionFiles(dir).map((f) => basename(f, '.jsonl'));
    const hits = names.includes(id) ? [id] : names.filter((n) => n.startsWith(id));
    return hits.length === 1 ? join(dir, `${hits[0]}.jsonl`) : null;
}

/**
 * The current session (the newest transcript, or session `sessionId` when given) measured against the autocompact trigger: the
 * last turn's context against `trigger` tokens (default: the live autocompact setting, see lib/autocompact.ts), so `roll soon` and
 * `roll now` fire before the compaction, not never. `_retiredReadLimit` is the old read-per-turn slot, kept only so the positional
 * call in journal.ts (`undefined` for every threshold, then the session id) still lines up; it is ignored and goes with that call.
 */
export function sessionStatus(dir: string, trigger: number = triggerTokens(readAutocompact()), _retiredReadLimit?: number, warnPct: number = ROLL_WARN_PCT, rollPct: number = ROLL_AT_PCT, guessed: boolean = guessedFromCwd(dir), sessionId?: string): SessionStatus {
    let s;
    try { s = currentSession(dir, sessionId); } catch (e) { const err = e as NodeJS.ErrnoException; return { available: false, unavailable: `${err.code || err.message.split('\n')[0]} reading ${dir}` }; }
    if (!s && sessionId !== undefined) return { available: false, unavailable: `no session ${JSON.stringify(sessionId.replace(/[^\w-]/g, '?').slice(0, 40))} in ${dir}` };
    if (!s) return { available: false, unavailable: `no sessions in ${dir}; set projects_dir${guessed ? ' or container_root (this folder was guessed from the working directory)' : ''}` };
    // Cross-multiplied so 85% of 200k is exactly 170k, with no float division at the boundary.
    const reached = (pct: number): boolean => s.ctx * 100 >= pct * trigger;
    const advice = reached(rollPct) ? 'roll now' : reached(warnPct) ? 'roll soon' : '';
    return { available: true, session: s.session, turns: s.turns, ...(s.turnsBefore > 0 ? { turnsBefore: s.turnsBefore } : {}), ctxK: Math.floor(s.ctx / 1000), triggerK: Math.floor(trigger / 1000), pct: Math.floor((s.ctx / trigger) * 100), readK: Math.floor(s.readPerTurn / 1000), advice };
}

/**
 * The status-footer Session line for the current session, e.g.
 * `**Session:** 86 turns · ctx 142k of ~200k (71%) · 129k read/turn · roll soon`. The turn count, context and read/turn mean are
 * since the last compact; after one the line says so (`2 turns since compact (137 before)`). The roll percent is context-based, so a compact
 * lowers it for real. The percent is the last turn's context over the autocompact trigger. At `warnPct` of the trigger it ends
 * with `roll soon`; at `rollPct`, `roll now` instead. With no session on disk it says so rather than vanishing, so a misconfigured
 * projects_dir is visible.
 */
export const sessionLine = (...args: Parameters<typeof sessionStatus>): string => sessionText(sessionStatus(...args));

/** Reads one transcript into deduplicated turns, wake-up events and handback reports. */
export function scanFile(path: string): ScanResult {
    const turns: Turn[] = [];
    const events: TurnEvent[] = [];
    const reports: { date: string; tokens: number }[] = [];
    const seen = new Map<string, Turn>();
    let last = null as Turn | null;
    let pending = null as { date: string; n: number } | null;
    let since = 0;
    let lastAt = null as number | null;
    const toolById = new Map<string, ToolUse>();
    let carried: CarriedResult[] = [];
    for (const line of readFileSync(path, 'utf8').split('\n')) {
        if (!line) continue;
        let rec: Picked;
        try { rec = pick(JSON.parse(line)); } catch { continue; }
        if (rec.compact) { pending = null; last = null; since = 0; lastAt = null; carried = []; continue; }
        for (const u of rec.tools) toolById.set(u.id, u);
        if (rec.type === 'assistant' && rec.usage && rec.id) {
            const dup = seen.get(rec.id);
            if (dup) { Object.assign(dup, rec.usage); if (rec.tools.length) dup.tools = [...(dup.tools || []), ...rec.tools]; continue; }
            since += 1;
            const t: Turn = { date: localDate(rec.ts), model: rec.model, since, ...rec.usage, tools: rec.tools, results: carried };
            carried = [];
            const at = Date.parse(rec.ts);
            if (lastAt !== null && Number.isFinite(at)) t.gapSec = Math.max(0, (at - lastAt) / 1000);
            lastAt = Number.isFinite(at) ? at : lastAt;
            seen.set(rec.id, t);
            if (last) {
                const ctxBefore = last.fresh + last.write + last.read;
                t.growth = Math.max(0, t.fresh + t.write + t.read - ctxBefore - last.out);
            }
            turns.push(t);
            if (pending && last) {
                const delta = t.growth as number;
                if (delta > 0) for (let k = 0; k < pending.n; k += 1) reports.push({ date: pending.date, tokens: delta / pending.n });
            }
            pending = null;
            last = t;
            continue;
        }
        for (const r of rec.results) {
            const use = toolById.get(r.id);
            if (use) carried.push({ tool: use.name, file: use.file, tokens: Math.round(r.chars / CHARS_PER_TOKEN) });
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

function agentType(metaPath: string): string {
    try { const m = JSON.parse(readFileSync(metaPath, 'utf8')); return typeof m.agentType === 'string' ? m.agentType : 'unknown'; } catch { return 'unknown'; }
}

const emptyStats = (): Stats => ({
    turns: 0, prompts: 0, wakesNotif: 0, wakesHandback: 0, peerMsgs: 0,
    out: 0, write: 0, read: 0, fresh: 0,
    subagents: 0, subTurns: 0, subWakes: 0, subByModel: {}, subGrowth: 0, subGrowthN: 0, reportTokens: 0, reportCount: 0,
    expiryTurns: 0, expiryGapSec: 0, expiryByFamily: {},
    mix: {}, orch: {}, sub: {}, sinceCompact: 0, subSmall: 0, subOpus: 0,
});
function addTurn(s: Stats, t: Turn): void {
    s.turns += 1; s.out += t.out; s.write += t.write; s.read += t.read; s.fresh += t.fresh;
    s.sinceCompact = Math.max(s.sinceCompact, t.since);
    addMix(s, t, 'orch');
}
/** Counts `t` into the day's expiry totals when it is a rewrite; only its 5m write is kept, which is all that was rewritten. */
function addExpiry(s: Stats, t: Turn): void {
    if (!isExpiryRewrite(t)) return;
    s.expiryTurns += 1;
    s.expiryGapSec += t.gapSec as number;
    const f = family(t.model);
    addKinds(s.expiryByFamily[f] || (s.expiryByFamily[f] = zeroKinds()), { ...zeroKinds(), w5: kindsOf(t).w5 });
}
const zeroKinds = (): Kinds => ({ fresh: 0, w5: 0, w1: 0, read: 0, out: 0 });
const addKinds = (a: Kinds, b: Kinds): void => { for (const k of Object.keys(a) as (keyof Kinds)[]) a[k] += b[k]; };
/** Per model family, cache-read tokens (the token mix) and tokens by price kind for `who`: `orch` (orchestrator) or `sub` (subagents). */
function addMix(s: Stats, t: Usage & { model: string }, who: 'orch' | 'sub'): void {
    const f = family(t.model);
    const m = s.mix[f] || (s.mix[f] = { read: 0 });
    m.read += t.read;
    addKinds(s[who][f] || (s[who][f] = zeroKinds()), kindsOf(t));
}
function addEvent(s: Stats, e: TurnEvent): void {
    if (e.kind === 'human') s.prompts += 1;
    else if (e.kind === 'task-notification') s.wakesNotif += 1;
    else if (e.kind === 'handback') s.wakesHandback += 1;
    else if (e.kind === 'peer') s.peerMsgs += 1;
}
type NumericKey = { [K in keyof Stats]: Stats[K] extends number ? K : never }[keyof Stats];
function merge(a: Stats, b: Stats): void {
    for (const k of Object.keys(b) as (keyof Stats)[]) {
        if (k === 'subByModel') for (const [m, n] of Object.entries(b.subByModel)) a.subByModel[m] = (a.subByModel[m] || 0) + n;
        else if (k === 'mix') for (const [m, x] of Object.entries(b.mix)) { const c = a.mix[m] || (a.mix[m] = { read: 0 }); c.read += x.read; }
        else if (k === 'orch' || k === 'sub' || k === 'expiryByFamily') for (const [m, x] of Object.entries(b[k])) addKinds(a[k][m] || (a[k][m] = zeroKinds()), x);
        else if (k === 'sinceCompact') a[k] = Math.max(a[k] || 0, b[k]);
        else if (typeof b[k] === 'number') { const nk = k as NumericKey; a[nk] = (a[nk] || 0) + b[nk]; }
    }
}
/** A subagent that finished in fewer turns than this is "small": cheaper done inline than dispatched. */
export const SMALL_AGENT_TURNS = 10;
export { family };
export function localDate(iso: string): string {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return 'unknown';
    const p = (n: number): string => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

// --- formatting ------------------------------------------------------------------
export function compact(n: number): string {
    if (!Number.isFinite(n)) return '-';
    const a = Math.abs(n);
    if (a >= 1e9) return `${(n / 1e9).toFixed(2)}B`;
    if (a >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
    if (a >= 1e3) return `${(n / 1e3).toFixed(1)}k`;
    return String(Math.round(n));
}
export function uncompact(s: unknown): number {
    const m = /^(-?[\d.]+)([kMB]?)/.exec(String(s).trim());
    if (!m) return NaN;
    return Number(m[1]) * ({ k: 1e3, M: 1e6, B: 1e9 }[m[2]] || 1);
}
const avgReport = (s: Stats): number => (s.reportCount ? s.reportTokens / s.reportCount : NaN);
const readPerTurn = (s: Stats): number => (s.turns ? s.read / s.turns : NaN);
const subGrowth = (s: Stats): number => (s.subGrowthN ? s.subGrowth / s.subGrowthN : NaN);
const byModel = (s: Stats): string => Object.entries(s.subByModel).filter(([, n]) => n > 0).sort((a, b) => b[1] - a[1]).map(([m, n]) => `${m} ${compact(n)}`).join(' · ') || '-';

/** A mix cell: `opus 1200000 · sonnet 300000`, families with nothing left out; `-` when empty. Read back by parseMix. */
export function mixCell(mix: Record<string, Record<string, number>> | undefined, key: string): string {
    // Whole numbers, not compact(): PASS/MISS is scored from these cells, and 1-decimal k/M rounding can flip a verdict near a target.
    return Object.entries(mix || {}).filter(([, v]) => v[key] > 0).sort((a, b) => b[1][key] - a[1][key]).map(([m, v]) => `${m} ${Math.round(v[key])}`).join(' · ') || '-';
}
/** The family totals back out of a mix cell: { opus: 1.2e6, sonnet: 3e5 }. */
export function parseMix(text: unknown): Record<string, number> {
    const out: Record<string, number> = {};
    for (const m of String(text || '').matchAll(/([a-z]+) (\d[\d.]*[kMB]?)/g)) out[m[1]] = uncompact(m[2]);
    return out;
}

/**
 * A kinds cell: `opus 1/2/3/4/5 · sonnet ...`, each family's tokens as fresh/write-5m/write-1h/read/output in whole numbers;
 * `-` when empty. Read back by parseKinds, so a pruned day can still be priced.
 */
export function kindsCell(byFamily: FamilyKinds | undefined): string {
    const total = (k: Kinds): number => k.fresh + k.w5 + k.w1 + k.read + k.out;
    return Object.entries(byFamily || {}).filter(([, k]) => total(k) > 0).sort((a, b) => total(b[1]) - total(a[1]))
        .map(([f, k]) => `${f} ${[k.fresh, k.w5, k.w1, k.read, k.out].map(Math.round).join('/')}`).join(' · ') || '-';
}
export function parseKinds(text: unknown): FamilyKinds {
    const out: FamilyKinds = {};
    for (const m of String(text || '').matchAll(/([a-z]+) (\d+)\/(\d+)\/(\d+)\/(\d+)\/(\d+)/g)) {
        out[m[1]] = { fresh: Number(m[2]), w5: Number(m[3]), w1: Number(m[4]), read: Number(m[5]), out: Number(m[6]) };
    }
    return out;
}

// --- pricing ---------------------------------------------------------------------
/** Dollars per family for { family: kinds }; a family with no price row (an `other` model with no `other` price) is left out. */
export function priceFamilies(byFamily: FamilyKinds | undefined, prices: Prices): Record<string, Dollars> {
    return Object.fromEntries(Object.entries(byFamily || {}).filter(([f]) => prices && prices[priceKey(f)]).map(([f, k]) => [f, dollars(k, (prices as Record<string, ModelPrice>)[priceKey(f)] as ModelPrice)]));
}
/**
 * What `byFamily` ({ family: kinds }) would cost with every priced token on Sonnet: { actual, onSonnet } in dollars.
 * The same tokens repriced, so it ignores any difference in how many tokens another model would need or how good its work is.
 */
export function sonnetWhatIf(byFamily: FamilyKinds | undefined, prices: Record<string, ModelPrice>): { actual: number; onSonnet: number } {
    const priced = Object.entries(byFamily || {}).filter(([f]) => prices[priceKey(f)]);
    return {
        actual: priced.reduce((n, [f, k]) => n + dollars(k, prices[priceKey(f)]).total, 0),
        onSonnet: priced.reduce((n, [, k]) => n + dollars(k, prices.sonnet).total, 0),
    };
}
const sumDollars = (list: Dollars[]): Dollars => list.reduce((a, d) => ({ read: a.read + d.read, write: a.write + d.write, output: a.output + d.output, input: a.input + d.input, total: a.total + d.total }), { read: 0, write: 0, output: 0, input: 0, total: 0 });
/** Each family's share of the dollars in `byFamily` (priceFamilies output), as fractions; NaN when there are none. */
export function pricedShares(byFamily: Record<string, Dollars>): Record<string, number> {
    const total = Object.values(byFamily).reduce((n, d) => n + d.total, 0);
    return Object.fromEntries(FAMILIES.map((f) => [f, total > 0 ? (byFamily[f] ? byFamily[f].total : 0) / total : NaN]));
}
const joinKinds = (a: FamilyKinds, b: FamilyKinds): FamilyKinds => { const out: FamilyKinds = {}; for (const m of [a, b]) for (const [f, k] of Object.entries(m)) addKinds(out[f] || (out[f] = zeroKinds()), k); return out; };

export function toRow(s: DayStats): TableRow {
    return [
        s.date, s.sessions, s.turns, s.prompts, `${s.wakesNotif + s.wakesHandback} (${s.wakesNotif}/${s.wakesHandback})`,
        compact(s.out), compact(s.write), compact(s.read), compact(s.fresh), compact(readPerTurn(s)),
        s.subagents, s.subTurns, byModel(s), compact(avgReport(s)), compact(subGrowth(s)),
        mixCell(s.mix, 'read'), kindsCell(s.orch), s.sinceCompact, s.subSmall, s.subOpus, compact(s.subByModel.opus || 0), kindsCell(s.sub),
        s.expiryTurns, kindsCell(s.expiryByFamily),
    ].map(String);
}

function printDay(date: string, s: DayStats | undefined): void {
    if (!s) { console.log(`${date}: no orchestrator turns on disk.`); return; }
    console.log(`Day ${date}: ${s.sessions} session(s), ${s.turns} turns, ${s.prompts} prompts`);
    console.log(`  tokens   out ${compact(s.out)} · cache write ${compact(s.write)} · cache read ${compact(s.read)} · fresh ${compact(s.fresh)} · read/turn ${compact(readPerTurn(s))}`);
    console.log(`  wake-ups ${s.wakesNotif} task-notification · ${s.wakesHandback} handback · ${s.peerMsgs} peer message`);
    console.log(`  subagents ${s.subagents} · ${s.subTurns} turns · ${s.subWakes} background wake-ups inside subagents · ${byModel(s)}`);
    console.log(`  subagent context growth ≈ ${compact(subGrowth(s))} tokens/turn (tool results + hooks)`);
    console.log(`  avg report ≈ ${compact(avgReport(s))} tokens over ${s.reportCount} handback(s)`);
    console.log(`  model mix (cache read) ${mixLine(shares(readMix(s.mix)))}`);
    console.log(`  cache-expiry rewrites  ${expiryLine(s, MODEL_PRICES)}`);
    printPriced(s, MODEL_PRICES);
}
/** Dollars of a day's cache-expiry rewrites, or NaN when `prices` is unset. */
export const expiryUsd = (byFamily: FamilyKinds, prices: Prices): number => (prices ? sumDollars(Object.values(priceFamilies(byFamily, prices))).total : NaN);
/** `12 turns, avg gap 12.5 min, $4.20 (opus $3.90 · sonnet $0.30)`; the dollars are left out while prices are unset. */
function expiryLine(s: Stats, prices: Prices): string {
    if (!s.expiryTurns) return 'none';
    const gap = `${s.expiryTurns} turns, avg gap ${(s.expiryGapSec / s.expiryTurns / 60).toFixed(1)} min`;
    if (!prices) return `${gap}, ${compact(Object.values(s.expiryByFamily).reduce((n, k) => n + k.w5, 0))} tokens rewritten (prices unset)`;
    const fams = Object.entries(priceFamilies(s.expiryByFamily, prices)).sort((a, b) => b[1].total - a[1].total).map(([f, d]) => `${f} ${usd(d.total)}`).join(' · ');
    return `${gap}, ${usd(expiryUsd(s.expiryByFamily, prices))} (${fams})`;
}
/** `--expiry`: one line per day with the cache-expiry rewrites it paid for. */
function printExpiry(days: Map<string, DayStats>): void {
    console.log(`Cache-expiry rewrites per day (gap over ${EXPIRY_GAP_SEC / 60} min, 5m write of at least ${compact(EXPIRY_MIN_WRITE)} tokens)`);
    for (const [d, s] of days) console.log(`${d}  ${expiryLine(s, MODEL_PRICES)}`);
    if (!MODEL_PRICES) console.log('Model prices are unset: tokens only. Set model_prices to see dollars.');
}
const readMix = (mix: Stats['mix']): Record<string, number> => Object.fromEntries(Object.entries(mix).map(([f, v]) => [f, v.read]));
const usd = (n: number): string => `$${n.toFixed(2)}`;
const categories = (d: Dollars): string => `read ${usd(d.read)} · write ${usd(d.write)} · output ${usd(d.output)} · input ${usd(d.input)}`;
/** The estimated-dollars block of the day summary: orchestrator and subagents, by model and by category, then the priced mix. */
function printPriced(s: Stats, prices: Prices): void {
    if (!prices) { console.log('  est. cost              prices unset (model_prices): token mix only'); return; }
    const parts = { orchestrator: priceFamilies(s.orch, prices), subagents: priceFamilies(s.sub, prices) };
    for (const [who, fams] of Object.entries(parts)) {
        console.log(`  est. $/day ${who.padEnd(12)} ${usd(sumDollars(Object.values(fams)).total).padStart(9)}  ${categories(sumDollars(Object.values(fams)))}`);
        for (const [f, d] of Object.entries(fams).sort((a, b) => b[1].total - a[1].total)) console.log(`    ${f.padEnd(8)} ${usd(d.total).padStart(9)}  ${categories(d)}`);
    }
    const w = sonnetWhatIf(s.orch, prices);
    if (w.actual > 0) {
        const delta = (w.onSonnet - w.actual) / w.actual;
        console.log(`  what-if: orchestrator on Sonnet ${usd(w.onSonnet)} vs ${usd(w.actual)} actual (${delta >= 0 ? '+' : ''}${Math.round(delta * 100)}%). Same tokens repriced; ignores quality effects and any change in tokens needed.`);
    }
    const all = priceFamilies(joinKinds(s.orch, s.sub), prices);
    console.log(`  model mix (priced)     ${mixLine(pricedShares(all))}`);
}
const mixLine = (sh: Record<string, number>): string => FAMILIES.map((f) => `${f} ${fmtValue(sh[f], 'pct')}`).join(' · ');
function printSessions(list: SessionStats[]): void {
    if (!list.length) return;
    console.log('\nSession   Turns  Prompts  Wakes  Read/turn  Cache read  Subagents  Max since compact');
    for (const s of list.sort((a, b) => b.read - a.read)) {
        console.log(`${s.session}  ${String(s.turns).padStart(5)}  ${String(s.prompts).padStart(7)}  ${String(s.wakesNotif + s.wakesHandback).padStart(5)}  ${compact(readPerTurn(s)).padStart(9)}  ${compact(s.read).padStart(10)}  ${String(s.subagents).padStart(9)}  ${String(s.sinceCompact).padStart(17)}`);
    }
}
function printCurve(curve: Map<number, { n: number; read: number }>): void {
    console.log('Turn index  Turns  Avg cache-read/turn   (orchestrator sessions, all days)');
    for (const [b, c] of [...curve].sort((x, y) => x[0] - y[0])) {
        console.log(`${String(b).padStart(5)}-${String(b + 99).padEnd(5)} ${String(c.n).padStart(6)}  ${compact(c.read / c.n).padStart(8)}`);
    }
}

// --- the vault table ---------------------------------------------------------------
export function readTable(path: string): Map<string, TableRow> {
    const rows = new Map<string, TableRow>();
    if (!existsSync(path)) return rows;
    for (const line of readFileSync(path, 'utf8').split('\n')) {
        const m = /^\|\s*(\d{4}-\d{2}-\d{2})\s*\|/.exec(line);
        if (m) rows.set(m[1], line.split('|').slice(1, -1).map((c) => c.trim()));
    }
    return rows;
}
export function writeTable(path: string, rows: Map<string, TableRow>): void {
    mkdirSync(join(path, '..'), { recursive: true });
    const intro = [
        '---', 'tags: [maestro, tokens, metrics]', '---', '',
        '# Token metrics, one row per day',
        '',
        'Generated by `the-maestro/scripts/token-metrics.ts --write`. Rerunning a day replaces its row; edit anything above the table freely, the table itself is regenerated.',
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
    const align = TABLE_HEADER.map((h, i) => ([0, 12, 15, 16, 21, 23].includes(i) ? '---' : '---:')).join('|');
    const table = [`| ${TABLE_HEADER.join(' | ')} |`, `|${align}|`, ...body];
    writeFileSync(path, `${[...head, ...table].join('\n')}\n`);
}

// --- comparison ------
/**
 * Share of each family in `mix` ({ family: amount }), as fractions of everything in it. NaN for every family when it is empty.
 */
export function shares(mix: Record<string, number>): Record<string, number> {
    const total = Object.values(mix).reduce((n, v) => n + v, 0);
    return Object.fromEntries(FAMILIES.map((f) => [f, total > 0 ? (mix[f] || 0) / total : NaN]));
}

// Key metrics, read back from table cells so pruned days still compare.
const cell = (i: number): MetricGetter => (r) => uncompact(r[i]);
const ratio = (i: number, j: number): MetricGetter => (r) => { const d = uncompact(r[j]); return d ? uncompact(r[i]) / d : NaN; };
const share = (col: number, fam: string): MetricGetter => (r) => shares(parseMix(r[col]))[fam];
// Dollar getters price a row's token cells with today's prices. Orchestrator cell 16, subagent cell 21 (a day with subagents but no cell is pre-column).
const rowKinds = (r: TableRow): { orch: FamilyKinds; sub: FamilyKinds } => ({ orch: parseKinds(r[16]), sub: parseKinds(r[21]) });
const rowUsd = (who: 'orch' | 'sub', prices: Prices): MetricGetter => (r) => {
    const k = rowKinds(r)[who];
    if (!Object.keys(k).length && (who === 'orch' || uncompact(r[10]) > 0)) return NaN;
    return sumDollars(Object.values(priceFamilies(k, prices))).total;
};
const pricedShare = (fam: string, prices: Prices): MetricGetter => (r) => pricedShares(priceFamilies(joinKinds(rowKinds(r).orch, rowKinds(r).sub), prices))[fam];
// Expiry columns: 22 rewrite count (a pre-column row reads '-', so NaN), 23 write tokens by model.
const expiryCost = (prices: Prices): MetricGetter => (r) => (Number.isFinite(uncompact(r[22])) ? expiryUsd(parseKinds(r[23]), prices) : NaN);
const smallRate: MetricGetter = (r) => { const n = uncompact(r[10]); return n ? uncompact(r[18]) / n : NaN; };
const CORE_METRICS: Metric[] = [
    ['Turns', cell(2)], ['Wakes', cell(4)], ['Output', cell(5)], ['Cache read', cell(7)],
    ['Read/turn', cell(9), { cost: true, target: ['read_per_turn_max', 1, 'max'] }], ['Read/prompt', ratio(7, 3)], ['Read/subagent', ratio(7, 10)],
    ['Avg report', cell(13)], ['Sub growth', cell(14)],
];
/**
 * Every metric as [name, getter over a table row, options]. Options: cost (shown in the day summary), fmt (n, pct, ratio or usd),
 * worse (up, down or none: which move counts as a regression), target ([config key, scale, max|min]) or trend (lower is better, no target).
 * Dollar metrics exist only when `prices` is set. Columns are the table's: 4 wakes, 15 read by model, 16 orchestrator tokens by model,
 * 17 max turns since compact, 18 small agents, 19 Opus subagents, 20 Opus sub tokens, 21 subagent tokens by model, 22 cache-expiry rewrites, 23 their 5m write tokens by model.
 */
export function metricList(prices: Prices = MODEL_PRICES): Metric[] {
    const pct = { cost: true, fmt: 'pct' };
    const priced: Metric[] = prices ? [
        ['Opus share (priced)', pricedShare('opus', prices), { ...pct, target: ['opus_priced_share_max', 0.01, 'max'] }],
        ['Sonnet share (priced)', pricedShare('sonnet', prices), { ...pct, worse: 'none' }],
        ['Haiku share (priced)', pricedShare('haiku', prices), { ...pct, worse: 'none' }],
        ['Est. $ orchestrator', rowUsd('orch', prices), { cost: true, fmt: 'usd' }],
        ['Est. $ subagents', rowUsd('sub', prices), { cost: true, fmt: 'usd' }],
        ['Est. $ cache expiry', expiryCost(prices), { cost: true, fmt: 'usd' }],
    ] : [];
    const list: Metric[] = [
        ...CORE_METRICS,
        ['Opus share (read)', share(15, 'opus'), { ...pct, target: ['opus_share_max', 0.01, 'max'] }],
        ['Sonnet share (read)', share(15, 'sonnet'), { ...pct, worse: 'none' }],
        ['Haiku share (read)', share(15, 'haiku'), { ...pct, worse: 'down', target: ['haiku_share_min', 0.01, 'min'] }],
        ...priced,
        ['Wakes/prompt', ratio(4, 3), { cost: true, fmt: 'ratio', target: ['wakes_per_prompt_max', 1, 'max'] }],
        ['Max turns/compact', cell(17), { cost: true, target: ['turns_since_compact_max', 1, 'max'] }],
        ['Small-agent rate', smallRate, { cost: true, fmt: 'pct', trend: true }],
        ['Opus subagents', cell(19), { cost: true, worse: 'none' }],
        ['Opus sub tokens', cell(20), { cost: true, worse: 'none' }],
        ['Expiry rewrites', cell(22), { cost: true }],
    ];
    return list;
}
export function median(xs: number[]): number {
    const v = xs.filter(Number.isFinite).sort((a, b) => a - b);
    if (!v.length) return NaN;
    const m = Math.floor(v.length / 2);
    return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2;
}
/**
 * Each metric for `date` against the 7 rows before it and the baseline rows. `opts.targets` and `opts.prices` default to the config.
 * `status` is PASS or MISS against a target, '-' when there is no target or no number today.
 */
export function compare(date: string, rows: Map<string, TableRow>, baselineUntil: string, opts: { targets?: Record<string, number>; prices?: Prices } = {}): Comparison[] {
    const targets: Record<string, number> = opts.targets || COST_TARGETS;
    const all = [...rows].sort((a, b) => a[0].localeCompare(b[0]));
    const today = rows.get(date);
    const prior7 = all.filter(([d]) => d < date).slice(-7).map(([, r]) => r);
    const base = all.filter(([d]) => d <= baselineUntil && d < date).map(([, r]) => r);
    return metricList(opts.prices === undefined ? MODEL_PRICES : opts.prices).map(([name, val, o = {}]) => {
        const t = today ? val(today) : NaN;
        const m7 = median(prior7.map(val));
        const b = median(base.map(val));
        const pct = (x: number): number => (Number.isFinite(x) && x ? (t - x) / x : NaN);
        const [key, scale, dir]: [string?, number?, string?] = o.target || [];
        const limit = key && Number.isFinite(targets[key]) ? (targets[key] as number) * (scale as number) : NaN;
        const worse = o.worse || 'up';
        const status = !Number.isFinite(limit) || !Number.isFinite(t) ? '-' : (dir === 'max' ? t <= limit : t >= limit) ? 'PASS' : 'MISS';
        return {
            name, today: t, median7: m7, baseline: b, vs7: pct(m7), vsBase: pct(b), fmt: o.fmt || 'n', cost: Boolean(o.cost),
            limit: Number.isFinite(limit) ? limit : NaN, dir, trend: Boolean(o.trend), status,
            regression: worse === 'up' ? pct(m7) > 0.2 : worse === 'down' ? pct(m7) < -0.2 : false,
        };
    });
}
export function fmtValue(n: number, fmt = 'n'): string {
    if (!Number.isFinite(n)) return '-';
    if (fmt === 'pct') return `${Math.round(n * 100)}%`;
    if (fmt === 'ratio') return n.toFixed(2);
    if (fmt === 'usd') return usd(n);
    return compact(n);
}
const fmtPct = (p: number): string => (Number.isFinite(p) ? `${p >= 0 ? '+' : ''}${Math.round(p * 100)}%` : '-');
const targetText = (c: Comparison): string => (c.trend ? 'lower is better' : Number.isFinite(c.limit) ? `${c.dir === 'max' ? '<=' : '>='}${fmtValue(c.limit, c.fmt)}` : '-');

function printMetrics(list: Comparison[]): void {
    console.log('Metric                 Today     7d med    vs 7d   Baseline  vs base  Target           Status');
    for (const c of list) {
        console.log(`${c.name.padEnd(21)} ${fmtValue(c.today, c.fmt).padStart(8)} ${fmtValue(c.median7, c.fmt).padStart(9)} ${fmtPct(c.vs7).padStart(7)} ${fmtValue(c.baseline, c.fmt).padStart(9)} ${fmtPct(c.vsBase).padStart(7)}  ${targetText(c).padEnd(15)}  ${c.status}${c.regression ? '  REGRESSION >20%' : ''}`);
    }
    if (!MODEL_PRICES) console.log('Model prices are unset: only the token mix is shown. Set model_prices (dollars per MTok per family; the README lists the current Anthropic prices).');
    console.log('Opus subagents: each should be design, decision or review work.');
}
function printCompare(date: string, rows: Map<string, TableRow>, baselineUntil: string): void {
    console.log(`\nCompare ${date} · 7-day median of prior rows · baseline = median of days <= ${baselineUntil}`);
    printMetrics(compare(date, rows, baselineUntil));
}
/** The day summary's cost block: the cost metrics only, same columns as --compare. */
function printCost(date: string, rows: Map<string, TableRow>, baselineUntil: string): void {
    console.log(`\nCost targets ${date} · 7-day median of prior rows · baseline = median of days <= ${baselineUntil}`);
    printMetrics(compare(date, rows, baselineUntil).filter((c) => c.cost));
}

const isMain = (): boolean => { try { return realpathSync(process.argv[1]) === fileURLToPath(import.meta.url); } catch { return false; } };

if (process.argv[1] && isMain()) main(process.argv.slice(2));
