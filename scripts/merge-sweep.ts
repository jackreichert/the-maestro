#!/usr/bin/env node
/**
 * MERGE SWEEP: open ledger rows whose pull request has merged, or is still open and quiet.
 *
 *   node scripts/merge-sweep.ts [--json] [--vault <path>] [--project <name>] [--stale-days N] [--today YYYY-MM-DD]
 *
 * Read-only. It never writes the ledger, never runs `journal.ts done`, and has no apply flag. A cheap runner follows
 * playbooks/merge-sweep.md.
 *
 * An open row (in flight, queued, blocked, or a question) names a pull request as `gh:pr:owner/repo#N` or `owner/repo#N`
 * in its text, its gate, or its refs. Each such PR is read with `gh pr view` (`MAESTRO_GH_BIN` points at another gh).
 * The report has two lists:
 *   - merged: GitHub says MERGED, with the `journal.ts done <id>` command to close the row if you agree (printed, never run);
 *   - stale: GitHub says OPEN and `updatedAt` is at least `--stale-days` (default 7) whole UTC days before `--today`.
 * A PR this script cannot read (gh fails, the state is not MERGED/OPEN/CLOSED, the activity timestamp is missing, or the
 * name has no owner) is unknown, never merged. A PR closed without merging is listed apart from both, and is not a close.
 * Exit 0 when every named PR was read and none is merged, stale, or closed-unmerged; 1 when any of those lists is
 * non-empty; 3 when the only news is an unknown PR; 2 on a usage or read error.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { CONFIGURED_PROJECT, LEDGER_ROOT, VAULT_ROOT } from './local-config.ts';
import { daysBetween } from './lib/boxes.ts';
import { fold, isOpen, type LedgerRow } from './lib/ledger-core.ts';
import { openStore } from './lib/journal/store.ts';
import { parseArgs } from './lib/journal/args.ts';
import { printJson } from './lib/json-out.ts';
import { toolCommand } from './lib/tool-bin.ts';

const USAGE = 'Usage: merge-sweep.ts [--json] [--vault <path>] [--project <name>] [--stale-days N] [--today YYYY-MM-DD]';
const DEFAULT_STALE_DAYS = 7;
const SAFE_ID = /^[a-z0-9]{4,6}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const SEGMENT = /^(?!.*\.\.)[\w.-]+$/;
const GATE_RE = /(?<![\w/.-])gh:pr:([\w.-]+(?:\/[\w.-]+)?)#(\d+)\b/g;
const REF_RE = /(?<![\w/.-])([\w.-]+\/[\w.-]+)#(\d+)\b/g;
const KNOWN_STATE = new Set(['MERGED', 'OPEN', 'CLOSED']);
const VALUED = new Set(['--vault', '--project', '--stale-days', '--today']);

export interface NamedPr { repo: string; number: number; owned: boolean }
export interface PrHit { repo: string; number: number; state: string; updatedAt?: string; idleDays?: number; reason?: string }
export interface SweepRow { id: string; text: string; prs: PrHit[]; allMerged: boolean; done?: string }
export interface SweepReport { today: string; staleDays: number; merged: SweepRow[]; stale: SweepRow[]; unknown: SweepRow[]; closed: SweepRow[] }

/** Why argv cannot be used, or null. A positional, an unknown flag, or a valued flag with no value. */
export function usageError(argv: string[]): string | null {
    if (argv.includes('--help') || argv.includes('-h')) return null;
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i] ?? '';
        if (a === '--') return 'merge-sweep: unexpected extra arguments';
        if (!a.startsWith('--')) return `merge-sweep: unexpected argument ${a}`;
        if (a === '--json') continue;
        if (!VALUED.has(a)) return `merge-sweep: unknown flag ${a}`;
        const v = argv[i + 1];
        if (!v || v.startsWith('--')) return `merge-sweep: ${a} needs a value`;
        i += 1;
    }
    return null;
}

/** `owner/repo` with a single slash and no `..` segment. A bare repo name is not this. */
export function isOwnedRepo(repo: string): boolean {
    const parts = repo.split('/');
    return parts.length === 2 && parts.every((p) => p.length > 0 && p !== '.' && SEGMENT.test(p));
}

/**
 * Pull requests named as `gh:pr:owner/repo#N`, `gh:pr:repo#N`, or `owner/repo#N` in the row's text, gate, and refs.
 * A bare `gh:pr:repo#N` is kept and marked unowned, so the caller can report it unknown instead of guessing an owner.
 */
export function namedPrs(row: LedgerRow): NamedPr[] {
    const refs = Array.isArray(row.refs) ? row.refs.filter((r): r is string => typeof r === 'string') : [];
    const hay = [typeof row.text === 'string' ? row.text : '', typeof row.gate === 'string' ? row.gate : '', ...refs].join('\n');
    const found = new Map<string, NamedPr>();
    const add = (repo: string, n: string, owned: boolean): void => {
        const number = Number(n);
        if (!Number.isInteger(number) || number < 1 || number > 1_000_000_000) return;
        const key = `${repo}#${number}`;
        const prev = found.get(key);
        if (!prev) found.set(key, { repo, number, owned });
        else if (owned) prev.owned = true;
    };
    for (const m of hay.matchAll(GATE_RE)) if (m[1] && m[2]) add(m[1], m[2], m[1].includes('/'));
    for (const m of hay.matchAll(REF_RE)) if (m[1] && m[2]) add(m[1], m[2], true);
    return [...found.values()];
}

/** UTC `YYYY-MM-DD` of an ISO timestamp, or undefined when it does not parse. */
export function utcDay(iso: string): string | undefined {
    const t = Date.parse(iso);
    return Number.isNaN(t) ? undefined : new Date(t).toISOString().slice(0, 10);
}

export function validDate(s: string): boolean {
    return DATE.test(s) && new Date(`${s}T00:00:00Z`).toISOString().slice(0, 10) === s;
}

/** The close command for a ledger id this script is willing to print. Never executed here. */
export function doneCommand(id: string): string | undefined {
    return SAFE_ID.test(id) ? `journal.ts done ${id}` : undefined;
}

interface GhView { state: string; updatedAt?: string }

/** One PR as GitHub reported it, or unknown. An unreadable PR is never given state MERGED. */
export function hitFor(ref: NamedPr, view: GhView | undefined, today: string): PrHit {
    const base = { repo: ref.repo, number: ref.number };
    if (!ref.owned || !isOwnedRepo(ref.repo)) return { ...base, state: 'UNKNOWN', reason: 'no owner' };
    if (!view || !KNOWN_STATE.has(view.state)) return { ...base, state: 'UNKNOWN', reason: 'unreadable' };
    if (view.state !== 'OPEN') return { ...base, state: view.state, ...(view.updatedAt ? { updatedAt: view.updatedAt } : {}) };
    const day = view.updatedAt ? utcDay(view.updatedAt) : undefined;
    if (!day) return { ...base, state: 'UNKNOWN', reason: 'open, no activity timestamp' };
    return { ...base, state: 'OPEN', updatedAt: view.updatedAt, idleDays: daysBetween(day, today) };
}

function oneLine(s: string): string {
    return s.replace(/\s+/g, ' ').trim();
}

function listRow(row: LedgerRow, prs: PrHit[]): SweepRow {
    const id = row.id ?? '';
    const allMerged = prs.length > 0 && prs.every((p) => p.state === 'MERGED');
    // Printed on every merged row, including a partial one. The caller must not run it; allMerged says whether it is ready.
    const done = prs.some((p) => p.state === 'MERGED') ? doneCommand(id) : undefined;
    return { id, text: typeof row.text === 'string' ? row.text : '', prs, allMerged, ...(done ? { done } : {}) };
}

/**
 * Sort open rows into the report. `viewOf` is the GitHub read; a missing or unusable view is unknown, not merged.
 * A row with any MERGED PR is merged. The close command is printed for that row and is not run; `allMerged` is false
 * when another PR on the row is not MERGED. Otherwise a quiet OPEN PR is stale, an unreadable PR is unknown, and a
 * CLOSED PR is closed-unmerged. A recently active OPEN PR is omitted.
 */
export function classifyRows(
    rows: readonly LedgerRow[],
    viewOf: (ref: NamedPr) => GhView | undefined,
    today: string,
    staleDays: number,
): SweepReport {
    const cache = new Map<string, GhView | undefined>();
    const view = (ref: NamedPr): GhView | undefined => {
        const key = `${ref.repo}#${ref.number}`;
        if (!cache.has(key)) cache.set(key, viewOf(ref));
        return cache.get(key);
    };
    const report: SweepReport = { today, staleDays, merged: [], stale: [], unknown: [], closed: [] };
    for (const row of rows) {
        const named = namedPrs(row);
        if (!named.length) continue;
        const prs = named.map((ref) => hitFor(ref, ref.owned && isOwnedRepo(ref.repo) ? view(ref) : undefined, today));
        const listed = listRow(row, prs);
        if (prs.some((p) => p.state === 'MERGED')) report.merged.push(listed);
        else if (prs.some((p) => p.state === 'OPEN' && p.idleDays !== undefined && p.idleDays >= staleDays)) report.stale.push(listed);
        else if (prs.some((p) => p.state === 'UNKNOWN')) report.unknown.push(listed);
        else if (prs.some((p) => p.state === 'CLOSED')) report.closed.push(listed);
    }
    return report;
}

/** 0 clean, 1 something to report, 3 unknown only. Usage errors are the caller's 2. */
export function exitCode(report: SweepReport): number {
    if (report.merged.length || report.stale.length || report.closed.length) return 1;
    return report.unknown.length ? 3 : 0;
}

function formatPr(p: PrHit): string {
    if (p.state === 'OPEN' && p.idleDays !== undefined) {
        const day = p.updatedAt ? utcDay(p.updatedAt) : undefined;
        return `${p.repo}#${p.number} OPEN last activity ${day ?? 'unknown'} (${p.idleDays}d)`;
    }
    return `${p.repo}#${p.number} ${p.state}${p.reason ? ` (${p.reason})` : ''}`;
}

function printList(title: string, rows: SweepRow[], withDone: boolean): void {
    console.log(`${title} (${rows.length}); nothing was closed:`);
    for (const row of rows) {
        console.log(`  ${row.id}  ${oneLine(row.text)}`);
        console.log(`      ${row.prs.map(formatPr).join(', ')}`);
        if (withDone && !row.allMerged) console.log('      (other PRs on this row are not merged)');
        if (withDone && row.done) console.log(`      close if you agree: ${row.done}`);
        else if (withDone) console.log('      no safe id; not closed');
    }
}

function printText(report: SweepReport): void {
    printList('Merged open rows', report.merged, true);
    printList(`Stale open PRs, no activity in ${report.staleDays} days`, report.stale, false);
    printList('Unknown, not merged', report.unknown, false);
    printList('Closed without merging', report.closed, false);
}

/** Ask gh for state and updatedAt. Failure, empty output, and unusable JSON are undefined — unknown, not merged. Stderr is dropped: it can carry a token. */
function ghView(ref: NamedPr): GhView | undefined {
    const r = spawnSync(...toolCommand('gh', ['pr', 'view', String(ref.number), '--repo', ref.repo, '--json', 'state,updatedAt']), { encoding: 'utf8', timeout: 20_000 });
    if (r.status !== 0 || !r.stdout.trim()) return undefined;
    try {
        const parsed = JSON.parse(r.stdout) as { state?: unknown; updatedAt?: unknown };
        if (typeof parsed.state !== 'string' || !parsed.state.trim()) return undefined;
        const updatedAt = typeof parsed.updatedAt === 'string' && parsed.updatedAt.trim() ? parsed.updatedAt : undefined;
        return { state: parsed.state.trim().toUpperCase(), ...(updatedAt ? { updatedAt } : {}) };
    } catch {
        return undefined;
    }
}

export function main(argv: string[]): number {
    if (argv.includes('--help') || argv.includes('-h')) { console.log(USAGE); return 0; }
    const bad = usageError(argv);
    if (bad) { console.error(bad); console.error(USAGE); return 2; }
    const { arg, has } = parseArgs(['merge-sweep', ...argv]);
    const vault = arg('vault', LEDGER_ROOT || VAULT_ROOT);
    const project = arg('project') || CONFIGURED_PROJECT;
    if (!vault || !project) { console.error('merge-sweep: pass --vault <ledger root> and --project <name> (or set LEDGER_ROOT and the configured project).'); return 2; }
    const staleRaw = arg('stale-days', String(DEFAULT_STALE_DAYS));
    if (!/^\d+$/.test(staleRaw) || Number(staleRaw) > 3650) { console.error('merge-sweep: --stale-days needs a whole number from 0 to 3650'); return 2; }
    const today = arg('today', new Date().toISOString().slice(0, 10));
    if (!validDate(today)) { console.error('merge-sweep: --today needs YYYY-MM-DD'); return 2; }
    const store = openStore({ vault, project, dryRun: true });
    if (!existsSync(store.ledgerPath)) { console.error(`merge-sweep: no ledger at ${store.ledgerPath}`); return 2; }
    let entries: LedgerRow[];
    try { entries = store.readLedger(); } catch { console.error(`merge-sweep: could not read ${store.ledgerPath}`); return 2; }
    const open = fold(entries, store.loadRegistry()).items.filter(isOpen);
    const report = classifyRows(open, ghView, today, Number(staleRaw));
    if (has('json')) printJson(report);
    else printText(report);
    return exitCode(report);
}

const isMain = (): boolean => { try { return realpathSync(process.argv[1] ?? '') === fileURLToPath(import.meta.url); } catch { return false; } };
if (isMain()) process.exitCode = main(process.argv.slice(2));
