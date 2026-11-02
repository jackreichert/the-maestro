/**
 * The settings model: every setting this process resolved, grouped, with its value and where the value came from,
 * plus the spend picture for the cost-relevant ones. Read-only; the allowlisted write is settings-write.ts.
 *
 * `buildSettingsData` is pure (the caller passes the resolved settings, the budget, the cached spend and the date). `buildSettings` reads them
 * from local-config and the spend cache file; it never runs ccusage, so a request is cheap and a missing cache reads as "n/a", never a made-up number.
 * A value whose key looks secret (token, secret, key, password) is masked, and so is any command (it may carry a credential in its arguments).
 */
import { basename } from 'node:path';
import { BUDGET, EVENT_DIR, WATCH_TZ, overlayPath, resolvedSettings, userPath } from '../local-config.ts';
import type { ResolvedSetting } from '../local-config.ts';
import { budgetOn, evaluate } from './budget.ts';
import type { BudgetConfig } from './budget.ts';
import { readCache, spendCacheFile } from './spend.ts';
import type { SpendCache } from './spend.ts';
import { localDate } from './status-page/priorities.ts';

export type SettingGroup = 'Mode & cost' | 'Watches & notifications' | 'PR gates' | 'Paths' | 'Other';
export const GROUPS: SettingGroup[] = ['Mode & cost', 'Watches & notifications', 'PR gates', 'Paths', 'Other'];

export interface SettingRow { key: string; value: string; source: string; group: SettingGroup; what: string; masked: boolean; perWeekday: number | null }
export interface SpendView {
  on: boolean; monthlyUsd: number; periodStart: string; periodEnd: string;
  /** Spend figures are null when no spend reading is cached (the loop's spend watch writes it), never estimated here. */
  todaySpend: number | null; todayAllowance: number; periodSpend: number | null; paceAllowance: number; projection: number | null; perWeekday: number | null;
  readAt: string | null; error: string | null;
}
export interface SettingsData { generatedAt: string; groups: { name: SettingGroup; rows: SettingRow[] }[]; spend: SpendView }

const SECRET_KEY = /token|secret|key|password/i;
const COMMAND_KEY = /_command$/;
export const MASK = '(hidden)';

/** What a cost-group setting does, in a line. Keys not listed here have no description (shown as an empty line, not a guess). */
const WHAT: Record<string, string> = {
  mode: 'full loads the whole maestro; slim loads one single-threaded orchestrator that builds in-thread with cheaper helpers.',
  cost_profile: 'lean drops every watch whose only job is to start an LLM agent (retro, repost and library nudges, teammate reviews).',
  budget_monthly_usd: 'Monthly spend budget in dollars; unset turns the guardrail off. Split over the budget days of the period.',
  budget_period_start_day: 'Day of the month (1 to 28) the budget period starts.',
  budget_days: 'weekdays budgets Monday to Friday only; all budgets every day.',
  budget_weekend_weight: 'Share of a weekday allowance a weekend day gets in weekdays mode (0 to 1).',
  budget_warn_fraction: 'Fraction of the daily allowance at which the spend watch warns.',
  budget_hard_fraction: 'Fraction of the daily allowance at which the spend watch raises the hard alert.',
  budget_cost_multiplier: 'Scales ccusage\'s estimate toward the real bill (1 takes it as is).',
  autocompact_floor: 'Smallest auto-compact threshold, in tokens, the context check accepts.',
  cost_targets: 'Targets the token table compares each day against.',
  model_prices: 'Per-model prices used to turn token counts into dollars.',
};

/** The group a setting key belongs to, by name. */
export function groupOf(key: string): SettingGroup {
  if (/^(mode|cost_profile|cost_targets|model_prices|autocompact_.*|budget_.*|roll_.*|teammate_review_minutes)$/.test(key)) return 'Mode & cost';
  if (/^(watch_.*|notify_command|inbox_command|wake_launch_command|event_dir|sweep_.*|stall_minutes|lease_ttl_minutes)$/.test(key)) return 'Watches & notifications';
  if (/^(pr_.*|one_pr_.*|rereview_.*|review_queue_.*|self_review_repos|waive_size_gate_owners|stack_max_.*|reviewer_checklist_path|review_note_repos)$/.test(key)) return 'PR gates';
  if (/(_root|_dir|_dirs|_path|_roots|_file)$/.test(key)) return 'Paths';
  return 'Other';
}

/** The value as shown: a secret-named key or a command is hidden (a command only says whether it is set). */
export function shown(key: string, value: string): { value: string; masked: boolean } {
  if (SECRET_KEY.test(key)) return { value: value ? MASK : '', masked: true };
  if (COMMAND_KEY.test(key)) return { value: value ? '(set)' : '', masked: true };
  return { value, masked: false };
}

/** A source as a person reads it: the file's name for a config file, the variable for the environment. */
export function sourceLabel(source: string, user: string, overlay: string): string {
  if (source === 'default' || source.startsWith('env ')) return source;
  if (source === user) return `config.md (${basename(user)})`;
  if (source === overlay) return `overlay (${basename(overlay)})`;
  return 'config file';
}

export interface SettingsInputs {
  settings: ResolvedSetting[]; budget: BudgetConfig; cache: SpendCache | null; today: string; now: Date; userFile: string; overlayFile: string;
}

const spendOf = (i: SettingsInputs): SpendView => {
  const on = budgetOn(i.budget);
  const v = evaluate(i.budget, i.today, i.cache?.daily ?? {});
  const have = i.cache !== null && Object.keys(i.cache.daily).length > 0;
  const projection = on && have && v.elapsed > 0 ? (v.periodSpend / v.elapsed) * v.budgetDays : null;
  return {
    on, monthlyUsd: i.budget.monthlyUsd, periodStart: v.periodStart, periodEnd: v.periodEnd,
    todaySpend: have ? v.todaySpend : null, todayAllowance: v.todayAllowance, periodSpend: have ? v.periodSpend : null, paceAllowance: v.paceAllowance,
    projection, perWeekday: on ? v.dailyAllowance : null,
    readAt: i.cache ? new Date(i.cache.goodAt ?? i.cache.at).toISOString() : null, error: i.cache?.error ?? null,
  };
};

/** The tab's data from its inputs. Pure. */
export function buildSettingsData(i: SettingsInputs): SettingsData {
  const spend = spendOf(i);
  const rows: SettingRow[] = i.settings.map((s) => ({
    key: s.key, ...shown(s.key, s.value), source: sourceLabel(s.source, i.userFile, i.overlayFile), group: groupOf(s.key), what: WHAT[s.key] ?? '',
    perWeekday: s.key === 'budget_monthly_usd' ? spend.perWeekday : null,
  }));
  return { generatedAt: i.now.toISOString(), groups: GROUPS.map((name) => ({ name, rows: rows.filter((r) => r.group === name) })).filter((g) => g.rows.length), spend };
}

/** Reads local-config and the spend cache, then builds the data. */
export function buildSettings(now: Date = new Date()): SettingsData {
  return buildSettingsData({
    settings: resolvedSettings(), budget: BUDGET, cache: readCache(spendCacheFile(EVENT_DIR)), today: localDate(now, WATCH_TZ), now, userFile: userPath, overlayFile: overlayPath,
  });
}
