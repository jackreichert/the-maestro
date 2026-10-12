/**
 * stall: wakes the orchestrator when a dispatched agent has made no progress for `stall_minutes` (default 90), with the item id and the
 * evidence. The loop cannot stop a Claude Code subagent, so it only reports; playbooks/event-types/stall.md says what the orchestrator does.
 * Target is the container directory (the folder holding the repos, where each repo and its worktrees live). One watch.
 *
 * A candidate is an item in flight (open `wip`, not queued) with a writer brief: its `claim` row (text ends `: brief <id>`, no later `released` of the
 * same repo and scope) names the repo and the worktree or branch the agent works in. Items with no claim (read-only briefs, work done in the
 * orchestrator itself) have no place to look for evidence, so they are never judged: a stall is only reported when it can be shown.
 *
 * Progress is the newest of: the dispatch itself (the item's latest brief or claim row, so a fresh dispatch starts a new clock), the newest report or scratch file the dispatch wrote (files beside the report path whose name holds the item id), a live process that started after the dispatch and has its working directory in the worktree (`lsof -a -d cwd`; when lsof is missing this signal is simply absent; it extends the clock by at most one `stall_minutes` past the newest other sign), the worktree's
 * HEAD, reflog and index files (a commit, checkout or `git add`), and the mtimes of the files `git status` lists as changed or untracked (an edit).
 * Why these and not the lease: a lease belongs to the orchestrator window and any row that window writes renews it, so it says nothing about
 * the subagent. The agent writes no ledger rows of its own until it hands back. Commits alone miss an agent that edits for an hour before its
 * first commit, so edited files count too. Ignored files (node_modules, build output, caches) are not read: a test run's churn does not hide a
 * stall. A quiet test run is covered by the report/scratch writes and the live-process check, then by the threshold.
 * An agent whose report file is newer than the dispatch and then goes quiet is reported as `finished`, not `stalled`: re-briefing it would overwrite the report.
 *
 * Fires once per stall: state.announced[id] holds the progress time a stall was reported at. The same stall never repeats on later ticks;
 * the item is reported again only if the agent makes progress and then stalls again (or is re-dispatched and stalls). Closed or no longer
 * in-flight items are forgotten. A repo or worktree git cannot read is skipped, never counted as a stall.
 * State { announced: { <id>: progress epoch ms }, fresh: Finding[] } where `fresh` is only what this check newly found. Epoch ms throughout.
 */
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { basename, dirname, join, sep } from 'node:path';
import { claimScope } from '../lib/journal/claims.ts';
import { fold, isInFlight, parseLedger } from '../lib/ledger-core.ts';
import type { LedgerRow } from '../lib/ledger-core.ts';
import { CONFIGURED_PROJECT, CONTAINER_PROJECT, LEDGER_ROOT, STALL_MINUTES, VAULT_ROOT } from '../local-config.ts';
import type { CheckContext, Run, WatchEvent } from '../lib/types.ts';

export interface Finding { id: string; repo: string; worktree: string; idleMs: number; lastAt: number; last: string; /** Set when the agent wrote its report after the dispatch and then went quiet: finished, not stuck. */ report?: string }
export interface StallState { announced: Record<string, number>; fresh: Finding[]; /** When a live process was last seen in the item's worktree; a suite that just ended counts as progress at its end. */ liveSeen?: Record<string, number> }

export const interval = 300;
export const renews = true;
export const network = false;
export const backoff = false;
export const singleton = true;

/** Most changed files whose mtime is read per worktree; a worktree this dirty is not idle anyway. */
export const MAX_STAT_FILES = 2000;
const THREE_DAYS_MS = 3 * 24 * 3600 * 1000;
export const defaultTtlMs = (): number => THREE_DAYS_MS;

export function validate(target: string): void {
  if (!existsSync(target) || !statSync(target).isDirectory()) throw new Error(`stall target must be the container directory (the folder holding your repos), got "${target}"`);
}

export interface WorktreeRef { path: string; branch: string }

/** The outside world; tests replace it. */
export interface StallIo {
  /** Minutes without progress that make a stall. */
  stallMinutes: number;
  rows(): LedgerRow[];
  /** The linked worktrees of a repo (never its main checkout), or null when the repo or git cannot be read. */
  worktrees(repo: string): WorktreeRef[] | null;
  /** The newest sign of work in a worktree, or null when it cannot be read. */
  activity(dir: string): { at: number; what: string } | null;
  /** The report file's mtime, 0 when it does not exist. */
  reportAt(report: string): number;
  /** The newest mtime among the dispatch's report and scratch files (files beside the report whose name holds the item id, except the brief itself), or null when none. */
  dispatchFiles(report: string, id: string): { at: number; what: string } | null;
  /** True when a process (other than this one) that started at or after `since` (epoch ms) has its working directory in the worktree, false when none, null when it cannot be told (no lsof). */
  live(dir: string, since: number): boolean | null;
}

const ledgerPath = (): string => join(LEDGER_ROOT || VAULT_ROOT, 'Projects', CONFIGURED_PROJECT || CONTAINER_PROJECT, 'Journal', 'ledger.jsonl');

/** False only when `ps` says the process started before `since`: a terminal tab or proxy that predates the dispatch is not the agent's. An unreadable start time counts. */
function startedSince(run: Run, pid: string, since: number): boolean {
  try {
    const r = run('ps', ['-o', 'lstart=', '-p', pid]);
    const started = r.status === 0 ? Date.parse(r.stdout.trim()) : NaN;
    return !Number.isFinite(started) || started >= since - 1000; // lstart has one-second resolution
  } catch { return true; }
}

export function realIo(target: string, run: Run): StallIo {
  const git = (dir: string, ...args: string[]): string | null => {
    try { const r = run('git', ['-C', dir, '--no-optional-locks', ...args]); return r.status === 0 ? r.stdout : null; } catch { return null; }
  };
  const repoDir = (repo: string): string | null => [join(target, repo), join(target, 'skills', repo)].find((d) => existsSync(join(d, '.git'))) ?? null;
  const mtime = (p: string): number => { try { return statSync(p).mtimeMs; } catch { return 0; } };
  return {
    stallMinutes: STALL_MINUTES,
    rows: () => { try { return parseLedger(readFileSync(ledgerPath(), 'utf8')); } catch { return []; } },
    worktrees: (repo) => {
      const dir = repoDir(repo);
      const out = dir && git(dir, 'worktree', 'list', '--porcelain');
      if (!out) return null;
      const blocks = out.split(/\n\n+/).map((b) => b.split('\n'));
      return blocks.slice(1).flatMap((lines) => {
        const path = lines.find((l) => l.startsWith('worktree '))?.slice(9);
        const branch = lines.find((l) => l.startsWith('branch '))?.slice(7).replace(/^refs\/heads\//, '') ?? '';
        return path ? [{ path, branch }] : [];
      });
    },
    reportAt: (report) => mtime(report),
    dispatchFiles: (report, id) => {
      let names: string[];
      try { names = readdirSync(dirname(report)); } catch { return null; }
      const stamps = names.filter((n) => n.includes(id) && !n.startsWith('brief-')).map((n) => ({ at: mtime(join(dirname(report), n)), what: `wrote ${n}` }));
      return stamps.length ? stamps.reduce((a, b) => (b.at > a.at ? b : a)) : null;
    },
    live: (dir, since) => {
      try {
        const r = run('lsof', ['-a', '-d', 'cwd', '-F', 'pn']);
        if (r.status !== 0 && !r.stdout) return null;
        const root = realpathSync(dir);
        let pid = '';
        for (const line of r.stdout.split('\n')) {
          if (line.startsWith('p')) pid = line.slice(1);
          else if (line.startsWith('n') && pid !== String(process.pid) && (line.slice(1) === root || line.slice(1).startsWith(root + sep)) && startedSince(run, pid, since)) return true;
        }
        return false;
      } catch { return null; }
    },
    activity: (dir) => {
      const gitDir = git(dir, 'rev-parse', '--absolute-git-dir')?.trim();
      const status = git(dir, 'status', '--porcelain', '--untracked-files=all');
      if (!gitDir || status === null) return null;
      const stamps: { at: number; what: string }[] = ['HEAD', 'logs/HEAD', 'index'].map((f) => ({ at: mtime(join(gitDir, f)), what: `git ${f}` }));
      for (const line of status.split('\n').filter(Boolean).slice(0, MAX_STAT_FILES)) {
        const file = line.slice(3).split(' -> ').pop() as string;
        stamps.push({ at: mtime(join(dir, file.replace(/^"|"$/g, '').replace(/\/$/, ''))), what: `edited ${file}` });
      }
      return stamps.reduce((a, b) => (b.at > a.at ? b : a));
    },
  };
}

const ms = (ts: unknown): number => { const t = typeof ts === 'string' ? Date.parse(ts) : NaN; return Number.isFinite(t) ? t : 0; };

interface Candidate { id: string; repo: string; scope: string; branch: string; dispatchedAt: number; report: string }

/** In-flight items with a live writer claim from `journal.ts brief`, and when each was dispatched. */
function candidates(rows: LedgerRow[]): Candidate[] {
  const { items } = fold(rows, null);
  return items.filter(isInFlight).flatMap((item) => {
    const id = item.id as string;
    const claims = rows.map((r, i) => ({ r, i })).filter(({ r }) => r.kind === 'claim' && typeof r.text === 'string' && r.text.endsWith(`: brief ${id}`) && typeof r.repo === 'string');
    const last = claims.at(-1);
    if (!last) return [];
    const { repo, scope, branch } = last.r as LedgerRow & { repo: string; scope?: string; branch?: string };
    const released = rows.some((r, i) => i > last.i && r.kind === 'released' && r.repo === repo && (r.scope ?? undefined) === (scope ?? undefined));
    if (released || (!scope && !branch)) return [];
    const briefs = rows.filter((r) => r.kind === 'brief' && r.briefs === id).map((r) => ms(r.ts));
    const dispatchedAt = Math.max(ms(item.ts), ms(item.stateTs), ms(last.r.ts), ...briefs);
    const report = rows.filter((r) => r.kind === 'brief' && r.briefs === id && typeof r.report === 'string').at(-1)?.report as string | undefined;
    return [{ id, repo, scope: scope ?? '', branch: branch ?? '', dispatchedAt, report: report ?? '' }];
  });
}

const isTheirs = (w: WorktreeRef, c: Candidate): boolean => (c.branch !== '' && w.branch === c.branch) || (c.scope !== '' && (claimScope(basename(w.path)) === c.scope || claimScope(w.branch) === c.scope));

export function check(_target: string, ctx: Pick<CheckContext, 'now' | 'prev' | 'run'>, io?: StallIo): StallState {
  const prev = (ctx.prev as StallState | null | undefined) ?? { announced: {}, fresh: [] };
  const use = io ?? realIo(_target, ctx.run);
  const limit = use.stallMinutes * 60_000;
  const cands = candidates(use.rows());
  const announced: Record<string, number> = {};
  const liveSeen: Record<string, number> = {};
  const fresh: Finding[] = [];
  const lists = new Map<string, WorktreeRef[] | null>();
  for (const c of cands) {
    if (prev.announced[c.id] !== undefined) announced[c.id] = prev.announced[c.id] as number; // kept until it progresses or leaves the board
    if (!lists.has(c.repo)) lists.set(c.repo, use.worktrees(c.repo));
    const wt = (lists.get(c.repo) ?? []).find((w) => isTheirs(w, c));
    const seen = wt ? use.activity(wt.path) : null;
    if (!wt || !seen) continue;
    // Progress outside the worktree counts too: the report and scratch files the dispatch writes (a suite run and a review write there, not in the tree).
    const files = c.report ? use.dispatchFiles(c.report, c.id) : null;
    const signals = [seen, { at: c.dispatchedAt, what: 'dispatch' }, ...(files ? [files] : [])];
    const base = signals.reduce((x, y) => (y.at > x.at ? y : x));
    // A live process in the worktree (one that started after the dispatch) is the last test, asked only once the files have been quiet for half the
    // limit: it covers a long run that writes nothing, and checking every tick from then on keeps the last-seen time within one tick of the run's end.
    // It is bounded: it can push the clock at most one more `stall_minutes` past the newest other sign, or a hung command or stray process would hide a stall for good.
    let liveAt = prev.liveSeen?.[c.id] ?? 0;
    if (ctx.now - base.at >= limit / 2 && use.live(wt.path, c.dispatchedAt) === true) liveAt = ctx.now;
    if (liveAt > base.at) liveSeen[c.id] = liveAt;
    const liveCounted = Math.min(liveAt, base.at + limit);
    const { at: lastAt, what: last } = liveCounted > base.at ? { at: liveCounted, what: 'live process in the worktree' } : base;
    if (ctx.now - lastAt < limit) { delete announced[c.id]; continue; }
    if (announced[c.id] === lastAt) continue;
    announced[c.id] = lastAt;
    const finished = c.report && use.reportAt(c.report) > c.dispatchedAt ? c.report : undefined;
    fresh.push({ id: c.id, repo: c.repo, worktree: basename(wt.path), idleMs: ctx.now - lastAt, lastAt, last, ...(finished ? { report: finished } : {}) });
  }
  return { announced, fresh, liveSeen };
}

const duration = (msec: number): string => { const m = Math.round(msec / 60_000); return m >= 120 ? `${Math.floor(m / 60)}h${String(m % 60).padStart(2, '0')}` : `${m}m`; };

/** One actionable event per stall newly found by this check. Evidence: how long, the newest signal and when, the worktree. */
export const diff = (_prev: StallState | null, next: StallState): WatchEvent[] =>
  next.fresh.map((f) => ({
    summary: f.report
      ? `finished ${f.id} (${f.repo}, worktree ${f.worktree}): report ${f.report} was written and nothing has moved for ${duration(f.idleMs)}, but no hand-back arrived. Read the report first; do not re-brief this item, a new brief writes to the same path and overwrites it.`
      : `stalled ${f.id} (${f.repo}, worktree ${f.worktree}): no progress for ${duration(f.idleMs)}; newest sign ${f.last} at ${new Date(f.lastAt).toISOString().slice(0, 16)}Z. Run the stall-reset playbook.`,
    actionable: true,
  }));
