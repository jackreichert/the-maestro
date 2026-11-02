/**
 * spend-watch: tells the orchestrator when Claude spend crosses the budget guardrail, with no model involved. Target is any existing directory
 * (use the status directory), one watch. Off unless `budget_monthly_usd` is set; session-start registers it only then.
 *
 * Every check reads the spend since the period start (lib/spend.ts: ccusage, cached 15 minutes; this machine's transcripts only) and judges it
 * (lib/budget.ts): today against the daily allowance (warn and hard fractions), the period against the pace, and any spend on a day that is not
 * a budget day. Each threshold is said once per day (State.announced); a new day starts clean. A figure that cannot be read for today raises one `cannot read spend` line a day (and the footer says so); old figures are never judged as today's. The event is actionable and notifies through notify_command like any other.
 * State { announced: { day, fired[] } | null, fresh (this tick's lines), error }.
 */
import { existsSync, statSync } from 'node:fs';
import { budgetOn, crossed, dedupe, evaluate } from '../lib/budget.ts';
import type { Announced, BudgetConfig } from '../lib/budget.ts';
import { spendCacheFile, spendSince } from '../lib/spend.ts';
import { localDate } from '../lib/status-page/priorities.ts';
import { BUDGET, EVENT_DIR, WATCH_TZ } from '../local-config.ts';
import type { CheckContext, WatchEvent } from '../lib/types.ts';

export interface SpendWatchState { announced: Announced | null; fresh: string[]; error: string }

export const interval = 900;
export const renews = true;
export const network = false;
export const backoff = false;
export const singleton = true;
export const notifies = 'default' as const;

const THREE_DAYS_MS = 3 * 24 * 3600 * 1000;
export const defaultTtlMs = (): number => THREE_DAYS_MS;

export const cacheFile = (): string => spendCacheFile(EVENT_DIR);

export function validate(target: string): void {
  if (!existsSync(target) || !statSync(target).isDirectory()) throw new Error(`spend-watch target must be an existing directory (use the status directory), got "${target}"`);
}

export function check(_target: string, ctx: Pick<CheckContext, 'now' | 'prev' | 'run'>, cfg: BudgetConfig = BUDGET, tz: string = WATCH_TZ, file: string = cacheFile()): SpendWatchState {
  const prev = (ctx.prev as SpendWatchState | null | undefined) ?? null;
  const base = { announced: prev?.announced ?? null, fresh: [] as string[] };
  if (!budgetOn(cfg)) return { ...base, error: '' };
  const today = localDate(new Date(ctx.now), tz);
  const view0 = evaluate(cfg, today, {});
  const spend = spendSince(file, ctx.run, view0.periodStart, tz, ctx.now);
  const view = evaluate(cfg, today, spend.daily);
  // A failed read must not leave the guardrail silently off: with no figure for today, say so once a day instead of judging stale numbers.
  const blind = !!spend.error && !(today in spend.daily);
  const alerts = blind ? [{ key: 'unreadable' as const, text: `spend-watch: cannot read spend (${spend.error}); the budget is not being enforced until ccusage works. This machine only.` }] : crossed(cfg, view);
  const { fresh, next } = dedupe(today, alerts, base.announced);
  return { announced: next, fresh: fresh.map((a) => a.text), error: spend.error ?? '' };
}

/** One actionable event per alert said this tick; a quiet tick is nothing. */
export const diff = (_prev: SpendWatchState | null, next: SpendWatchState): WatchEvent[] => next.fresh.map((summary) => ({ summary, actionable: true }));
