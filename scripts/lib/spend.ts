/**
 * Reads daily Claude spend from `ccusage daily --since <period start> --json` and caches it, so the footer and the spend-watch type can ask
 * as often as they like and ccusage runs about once per CACHE_MS. ccusage reads this machine's transcripts only: every figure is this machine's.
 * A failed read is cached too (for RETRY_MS) so a missing ccusage is not retried on every reply; the last good figures are kept beside the error.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { budgetOn, evaluate, spendText } from './budget.ts';
import type { BudgetConfig } from './budget.ts';
import { localDate } from './status-page/priorities.ts';
import type { Run } from './types.ts';

export const CACHE_MS = 15 * 60_000;
export const RETRY_MS = 5 * 60_000;

export interface SpendCache { at: number; since: string; daily: Record<string, number>; error?: string }

/** `{ daily: [{ date, totalCost }] }` (or the bare array) to a date-to-dollars map; throws on anything else. */
export function parseCcusage(stdout: string): Record<string, number> {
  const data: unknown = JSON.parse(stdout);
  const rows = Array.isArray(data) ? data : (data as { daily?: unknown })?.daily;
  if (!Array.isArray(rows)) throw new Error('ccusage output has no daily list');
  const out: Record<string, number> = {};
  for (const r of rows as { date?: unknown; totalCost?: unknown }[]) {
    if (typeof r?.date !== 'string' || typeof r.totalCost !== 'number') continue;
    out[r.date] = (out[r.date] ?? 0) + r.totalCost;
  }
  return out;
}

/** Runs ccusage for the days since `since` (YYYY-MM-DD) in `tz`; returns the daily map or the reason it could not. */
export function runCcusage(run: Run, since: string, tz: string): { daily: Record<string, number> } | { error: string } {
  const r = run('npx', ['--yes', 'ccusage', 'daily', '--since', since.replace(/-/g, ''), '--timezone', tz, '--json']);
  if (r.status !== 0) return { error: `ccusage exit ${r.status}: ${(r.stderr || r.stdout || '').trim().split('\n').pop()?.slice(0, 160) ?? ''}` };
  try { return { daily: parseCcusage(r.stdout) }; } catch (e) { return { error: `ccusage output unreadable: ${(e instanceof Error ? e.message : String(e)).slice(0, 120)}` }; }
}

export function readCache(file: string): SpendCache | null {
  try {
    const c = JSON.parse(readFileSync(file, 'utf8')) as SpendCache;
    return typeof c.at === 'number' && typeof c.since === 'string' && c.daily && typeof c.daily === 'object' ? c : null;
  } catch { return null; }
}

function writeCache(file: string, c: SpendCache): void {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(c));
  renameSync(tmp, file);
}

/** True when the cache answers for this period and is young enough (a cached failure is young for RETRY_MS, a good read for CACHE_MS). */
export function fresh(c: SpendCache | null, since: string, now: number): boolean {
  if (!c || c.since !== since) return false;
  return now - c.at < (c.error ? RETRY_MS : CACHE_MS);
}

/** The spend since `since`: from the cache when fresh, else from ccusage (cached either way). `error` is set when the figures are the last good ones or empty. */
export function spendSince(file: string, run: Run, since: string, tz: string, now: number): SpendCache {
  const cached = existsSync(file) ? readCache(file) : null;
  if (cached && fresh(cached, since, now)) return cached;
  const got = runCcusage(run, since, tz);
  const keep = cached && cached.since === since ? cached.daily : {};
  const next: SpendCache = 'daily' in got ? { at: now, since, daily: got.daily } : { at: now, since, daily: keep, error: got.error };
  try { writeCache(file, next); } catch { /* an unwritable cache only costs the next call a ccusage run */ }
  return next;
}

/** The footer's `Spend:` segment, or '' when no budget is set. Never throws: an unreadable figure reads `Spend: unavailable (reason)`. `ctxK` is the session's context in thousands of tokens. */
export function spendFooter(cfg: BudgetConfig, file: string, run: Run, tz: string, now: number, ctxK = 0): string {
  if (!budgetOn(cfg)) return '';
  try {
    const today = localDate(new Date(now), tz);
    const since = evaluate(cfg, today, {}).periodStart;
    const got = spendSince(file, run, since, tz, now);
    if (got.error && !Object.keys(got.daily).length) return `Spend: unavailable (${got.error}) · this machine`;
    return spendText(cfg, evaluate(cfg, today, got.daily), ctxK);
  } catch (e) { return `Spend: unavailable (${(e instanceof Error ? e.message : String(e)).slice(0, 100)})`; }
}
