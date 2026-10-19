#!/usr/bin/env node
/**
 * MERGE SWEEP: open ledger rows whose pull request has merged, or is still open and quiet.
 *
 *   node scripts/merge-sweep.ts [--json] [--vault <path>] [--project <name>] [--stale-days N] [--today YYYY-MM-DD]
 *
 * Read-only unless `--close-ledger` (alias `--close`) is given. That flag is the only write, and it touches the local ledger only:
 * this script never deletes a branch (branch-sweep.ts --apply does, as its own step). A cheap runner follows playbooks/merge-sweep.md.
 *
 * An open row (in flight, queued, blocked, or a question) names a pull request in its text, its gate, or its refs as
 * `gh:pr:owner/repo#N`, `owner/repo#N`, a github.com pull URL, or, for a repo whose owner is known, `repo#N`, `repo #N` or
 * `gh:pr:repo#N`. The owner comes from `repo_owners` (config) or the row's own `repo` field (`owner/name`); with neither the
 * PR is unknown, never guessed. Each PR is read with `gh pr view` (`MAESTRO_GH_BIN` points at another gh).
 * The report has two lists:
 *   - merged: GitHub says MERGED, with the `journal.ts done <id>` command to close the row if you agree (printed, never run);
 *   - stale: GitHub says OPEN and `updatedAt` is at least `--stale-days` (default 7) whole UTC days before `--today`.
 * A PR this script cannot read (gh fails, the state is not MERGED/OPEN/CLOSED, the activity timestamp is missing, or the
 * name has no owner) is unknown, never merged. A PR closed without merging is listed apart from both, and is not a close.
 * `--close` appends `done` (through `journal.ts done`) to a merged row, and only when the row is linked to a PR through its
 * refs (pr-open.ts writes that link), every PR it names is MERGED, and it is still open: never twice, and never while any
 * linked PR is open, closed, or unreadable. A closed row leaves the merged list for `autoClosed`. A row that only mentions a
 * PR in its text is listed with the printed command and is not closed.
 * Only `wip` and `blocked` rows are matched at all, and only `wip` closes; a `question` or pending `decision` is skipped
 * (counted in `skipped`), however it cites a PR.
 * `--prune-others` is the second write, and it touches the Podium only: it drops a teammate PR card from the Others' PRs tab's cache, and rejects the review
 * draft queued for it, when the PR is merged or closed or a person other than you, the author and the bots has reviewed or commented on it
 * (lib/teammate/prune.ts). Each pruned item is logged on stderr and listed under `pruned` in the JSON; running it twice prunes nothing the second time.
 * `--resync-runtime` is the third write, and it touches the loop daemon only: it fast-forwards the daemon's worktree to origin/main and restarts it when that is a
 * pure fast-forward, the worktree is clean and CI `test` is green on the commit (lib/runtime-resync.ts); `runtimeResync` in the JSON is the result. A refusal never changes the exit code.
 * If the open rows name no PR at all the sweep is blind, not clean: it prints a WARNING and exits 3.
 * `--json` adds `actions` (rows left for a decision, +1 when blind; 0 exactly when the exit is 0), `closedCount` and `blind`.
 * Exit 0 when every named PR was read and none is merged, stale, or closed-unmerged; 1 when any of those lists is
 * non-empty; 3 when the only news is an unknown PR or a blind sweep; 2 on a usage or read error.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { CONFIGURED_PROJECT, GH_LOGIN, LEDGER_ROOT, REPO_OWNERS, VAULT_ROOT, statusDirFor } from './local-config.ts';
import { draftsPath } from './lib/drafts/queue.ts';
import { pruneOthers } from './lib/teammate/prune.ts';
import type { PruneResult } from './lib/teammate/prune.ts';
import { daysBetween } from './lib/boxes.ts';
import { fold, isOpen, type LedgerRow } from './lib/ledger-core.ts';
import { openStore } from './lib/journal/store.ts';
import { parseArgs } from './lib/journal/args.ts';
import { printJson } from './lib/json-out.ts';
import { toolCommand } from './lib/tool-bin.ts';
import { liveDeps, resyncRuntime, runtimeWorktree } from './lib/runtime-resync.ts';
import type { ResyncResult } from './lib/runtime-resync.ts';

const USAGE = 'Usage: merge-sweep.ts [--json] [--close-ledger] [--prune-others] [--resync-runtime] [--vault <path>] [--project <name>] [--stale-days N] [--today YYYY-MM-DD]';
const DEFAULT_STALE_DAYS = 7;
const SAFE_ID = /^[a-z0-9]{4,6}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const SEGMENT = /^(?!.*\.\.)[\w.-]+$/;
const GATE_RE = /(?<![\w/.-])gh:pr:([\w.-]+(?:\/[\w.-]+)?)#(\d+)\b/g;
const REF_RE = /(?<![\w/.-])([\w.-]+\/[\w.-]+)#(\d+)\b/g;
const URL_RE = /(?<![\w.-])https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/pull\/(\d+)\b/g;
const KNOWN_STATE = new Set(['MERGED', 'OPEN', 'CLOSED']);
const VALUED = new Set(['--vault', '--project', '--stale-days', '--today']);
const BOOLEAN = new Set(['--json', '--close', '--close-ledger', '--prune-others', '--resync-runtime']);

/** `linked` is true when the PR is named in the row's refs (written by pr-open.ts), not only mentioned in its text or gate. */
export interface NamedPr { repo: string; number: number; owned: boolean; linked?: boolean }
export interface PrHit { repo: string; number: number; state: string; updatedAt?: string; idleDays?: number; reason?: string }
export interface SweepRow { id: string; text: string; prs: PrHit[]; allMerged: boolean; closable: boolean; done?: string }
export interface SweepReport { today: string; staleDays: number; merged: SweepRow[]; stale: SweepRow[]; unknown: SweepRow[]; closed: SweepRow[]; autoClosed: SweepRow[]; openRows: number; parsed: number; warning?: string; skipped?: number }
/** The JSON a caller reads: the report plus `actions` (rows left for a decision, plus 1 when blind) and `closedCount` (rows this run closed). actions 0 is exit 0. */
export interface SweepJson extends SweepReport { actions: number; closedCount: number; blind: boolean; /** Present with `--prune-others`: the Others' PRs cards and review drafts it pruned. */ pruned?: PruneResult }

/** Why argv cannot be used, or null. A positional, an unknown flag, or a valued flag with no value. */
export function usageError(argv: string[]): string | null {
    if (argv.includes('--help') || argv.includes('-h')) return null;
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i] ?? '';
        if (a === '--') return 'merge-sweep: unexpected extra arguments';
        if (!a.startsWith('--')) return `merge-sweep: unexpected argument ${a}`;
        if (BOOLEAN.has(a)) continue;
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

/** The owner/repo the row's own `repo` field names, or undefined when it is only a bare name. */
const rowSlug = (row: LedgerRow): string | undefined => (typeof row.repo === 'string' && isOwnedRepo(row.repo.trim()) ? row.repo.trim() : undefined);

/** The owner of a bare repo name: the configured map first, then the row's own `owner/name` repo field when its name matches. */
function ownerOf(name: string, row: LedgerRow, owners: Readonly<Record<string, string>>): string | undefined {
    if (Object.hasOwn(owners, name)) return owners[name];
    const slug = rowSlug(row);
    return slug && slug.split('/')[1] === name ? slug.split('/')[0] : undefined;
}

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Pull requests named in the row's text, gate, and refs as `gh:pr:owner/repo#N`, `owner/repo#N`, a github.com pull URL,
 * `gh:pr:repo#N`, `repo#N` or `repo #N`. A bare repo name resolves to an owner through `owners` (default: `repo_owners` config)
 * or the row's own `repo` field; `repo#N` and `repo #N` are read only for a repo the sweep can name this way (a configured repo,
 * or the one in the row's repo field), so "ticket #12" is not a PR. A bare name with no known owner is kept and marked
 * unowned, so the caller reports it unknown instead of guessing. `linked` marks a PR named in the row's refs.
 */
export function namedPrs(row: LedgerRow, owners: Readonly<Record<string, string>> = REPO_OWNERS): NamedPr[] {
    const refs = Array.isArray(row.refs) ? row.refs.filter((r): r is string => typeof r === 'string') : [];
    const found = new Map<string, NamedPr>();
    const add = (repo: string, n: string, owned: boolean, linked: boolean): void => {
        const number = Number(n);
        if (!Number.isInteger(number) || number < 1 || number > 1_000_000_000) return;
        const owner = owned || repo.includes('/') ? undefined : ownerOf(repo, row, owners);
        const full = owner ? `${owner}/${repo}` : repo;
        const key = `${full}#${number}`;
        const isOwned = owned || owner !== undefined;
        const prev = found.get(key);
        if (!prev) found.set(key, { repo: full, number, owned: isOwned, linked });
        else { if (isOwned) prev.owned = true; if (linked) prev.linked = true; }
    };
    const names = [...new Set([...Object.keys(owners), ...(rowSlug(row) ? [rowSlug(row)!.split('/')[1]!] : [])])];
    const bare = names.length ? new RegExp(`(?<![\\w/.:-])(${names.map(escapeRe).join('|')})\\s?#(\\d+)\\b`, 'g') : undefined;
    const scan = (hay: string, linked: boolean): void => {
        for (const m of hay.matchAll(URL_RE)) if (m[1] && m[2]) add(m[1], m[2], true, linked);
        for (const m of hay.matchAll(GATE_RE)) if (m[1] && m[2]) add(m[1], m[2], m[1].includes('/'), linked);
        for (const m of hay.matchAll(REF_RE)) if (m[1] && m[2]) add(m[1], m[2], true, linked);
        if (bare) for (const m of hay.matchAll(bare)) if (m[1] && m[2]) add(m[1], m[2], false, linked);
    };
    scan([typeof row.text === 'string' ? row.text : '', typeof row.gate === 'string' ? row.gate : ''].join('\n'), false);
    scan(refs.join('\n'), true);
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

/** Only a row that tracks work (`wip`, `blocked`) can be matched to a PR. A `question` or a pending `decision` never is. */
export function matchable(row: LedgerRow): boolean {
    return row.kind === 'wip' || row.kind === 'blocked';
}

function oneLine(s: string): string {
    return s.replace(/\s+/g, ' ').trim();
}

function listRow(row: LedgerRow, named: NamedPr[], prs: PrHit[]): SweepRow {
    const id = row.id ?? '';
    const allMerged = prs.length > 0 && prs.every((p) => p.state === 'MERGED');
    // Printed on every merged row, including a partial one. The caller must not run it; allMerged says whether it is ready.
    const done = prs.some((p) => p.state === 'MERGED') ? doneCommand(id) : undefined;
    // Closable: every PR on the row merged, at least one of them linked through refs (not just mentioned in text), and an id the close command accepts.
    // Only a `wip` row closes: a blocked row waits on something else, and a question is never closed here.
    const closable = row.kind === 'wip' && allMerged && named.some((n) => n.linked) && doneCommand(id) !== undefined;
    return { id, text: typeof row.text === 'string' ? row.text : '', prs, allMerged, closable, ...(done ? { done } : {}) };
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
    const report: SweepReport = { today, staleDays, merged: [], stale: [], unknown: [], closed: [], autoClosed: [], openRows: rows.length, parsed: 0 };
    const parsed = new Set<string>();
    for (const row of rows) {
        // An open question or pending decision is waiting on a person; a merge that its text cites does not answer it.
        if (!matchable(row)) { report.skipped = (report.skipped ?? 0) + 1; continue; }
        const named = namedPrs(row);
        if (!named.length) continue;
        for (const n of named) parsed.add(`${n.repo}#${n.number}`);
        const prs = named.map((ref) => hitFor(ref, ref.owned && isOwnedRepo(ref.repo) ? view(ref) : undefined, today));
        const listed = listRow(row, named, prs);
        if (prs.some((p) => p.state === 'MERGED')) report.merged.push(listed);
        else if (prs.some((p) => p.state === 'OPEN' && p.idleDays !== undefined && p.idleDays >= staleDays)) report.stale.push(listed);
        else if (prs.some((p) => p.state === 'UNKNOWN')) report.unknown.push(listed);
        else if (prs.some((p) => p.state === 'CLOSED')) report.closed.push(listed);
    }
    report.parsed = parsed.size;
    if (rows.length - (report.skipped ?? 0) > 0 && parsed.size === 0) report.warning = `WARNING: merge-sweep parsed 0 pull requests across ${rows.length - (report.skipped ?? 0)} open rows, so it cannot see any merge. This is not a clean sweep. Rows name a PR as owner/repo#N, a github.com pull URL, or repo#N for a repo in repo_owners.`;
    return report;
}

/** Rows left for a decision (merged but not closed, stale, closed unmerged, unknown), plus 1 for a blind sweep. 0 means nothing to do. */
export function actionCount(report: SweepReport): number {
    return report.merged.length + report.stale.length + report.closed.length + report.unknown.length + (report.warning ? 1 : 0);
}

export function toJson(report: SweepReport, pruned?: PruneResult): SweepJson {
    return { ...report, actions: actionCount(report), closedCount: report.autoClosed.length, blind: Boolean(report.warning), ...(pruned ? { pruned } : {}) };
}

/** 0 clean, 1 something to report, 3 unknown only. Usage errors are the caller's 2. */
export function exitCode(report: SweepReport): number {
    if (report.merged.length || report.stale.length || report.closed.length) return 1;
    return report.unknown.length || report.warning ? 3 : 0;
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

function printText(report: SweepReport, closing: boolean): void {
    if (report.warning) console.log(report.warning);
    if (closing) console.log(`Closed on merge (${report.autoClosed.length}):${report.autoClosed.map((r) => `\n  ${r.id}  ${oneLine(r.text)}`).join('')}`);
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

const JOURNAL = fileURLToPath(new URL('./journal.ts', import.meta.url));

/** Append `done` to one row through `journal.ts done`. True when it exited 0. */
function journalDone(id: string, why: string, vault: string, project: string): boolean {
    const r = spawnSync(process.execPath, [JOURNAL, 'done', id, '--why', why, '--vault', vault, '--project', project, '--model', 'n/a', '--used', 'tool:merge-sweep.ts'], { encoding: 'utf8', timeout: 30_000 });
    return r.status === 0;
}

/**
 * Close each closable merged row, once. `rows` are the open rows the report was built from, so a row already closed is never here;
 * a row whose close fails stays in `merged`. Moves the closed rows from `merged` to `autoClosed`.
 */
export function closeMerged(report: SweepReport, close: (id: string, why: string) => boolean): void {
    const keep: SweepRow[] = [];
    for (const row of report.merged) {
        const why = `all linked PRs merged: ${row.prs.map((p) => `${p.repo}#${p.number}`).join(', ')} (closed by merge-sweep)`;
        if (row.closable && close(row.id, why)) report.autoClosed.push(row);
        else keep.push(row);
    }
    report.merged = keep;
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
    const closing = has('close') || has('close-ledger');
    if (closing) closeMerged(report, (id, why) => journalDone(id, why, vault, project));
    let pruned: PruneResult | undefined;
    if (has('prune-others')) {
        // A prune that cannot run (no status dir, gh down) is reported and never changes the sweep's own exit code.
        try { pruned = pruneOthers({ statusDir: statusDirFor(project), draftsFile: draftsPath(vault, project), self: GH_LOGIN }, (line) => console.error(`merge-sweep: ${line}`)); }
        catch (e) { console.error(`merge-sweep: Others' PRs not pruned (${(e as Error).message.split('\n')[0]})`); }
    }
    let resync: ResyncResult | undefined;
    if (has('resync-runtime')) {
        // Runs after the close/prune so a merged PR is already on origin/main. Like the prune, it never changes the sweep's exit code.
        const cwd = runtimeWorktree();
        if (cwd) { try { resync = resyncRuntime(liveDeps(cwd, (line) => console.error(`merge-sweep: ${line}`))); } catch (e) { console.error(`merge-sweep: runtime not resynced (${(e as Error).message.split('\n')[0]})`); } }
        else console.error('merge-sweep: runtime not resynced (no runtime worktree found; set MAESTRO_RUNTIME_WORKTREE)');
    }
    if (has('json')) printJson({ ...toJson(report, pruned), ...(resync ? { runtimeResync: resync } : {}) });
    else {
        printText(report, closing);
        if (resync) console.log(`Runtime resync: ${resync.action}${resync.old ? ` ${resync.old.slice(0, 8)}` : ''}${resync.new && resync.new !== resync.old ? ` -> ${resync.new.slice(0, 8)}` : ''}${resync.reason ? ` (${resync.reason})` : ''}`);
        if (pruned) console.log(`Pruned from the Others' PRs tab: ${pruned.cards.length} cards, ${pruned.drafts.length} drafts${pruned.unread ? ` (${pruned.unread} PRs unreadable, left)` : ''}`);
    }
    return exitCode(report);
}

const isMain = (): boolean => { try { return realpathSync(process.argv[1] ?? '') === fileURLToPath(import.meta.url); } catch { return false; } };
if (isMain()) process.exitCode = main(process.argv.slice(2));
