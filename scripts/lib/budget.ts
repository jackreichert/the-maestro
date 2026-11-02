/**
 * The spend guardrail's arithmetic and settings, with no I/O. A monthly budget is split evenly over the budget days of the current period
 * (start day to the day before the next start day); today is judged against that daily allowance and the period so far against the
 * allowance times the budget days elapsed (the pace). Each day carries a weight: 1 for a weekday, and for a weekend day 1 in `all` mode or
 * `weekendWeight` in `weekdays` mode (0 by default). The allowance per weekday is the budget over the period's summed weights, and a day's allowance
 * is that times its weight. Spend on a day of weight 0 has no allowance, so it is over by definition.
 * Dates are `YYYY-MM-DD` strings in the watch time zone; nothing here reads a clock.
 */

export type BudgetDays = 'weekdays' | 'all';

/** Every key is optional; `monthlyUsd` of 0 means the guardrail is off. */
export interface BudgetConfig { monthlyUsd: number; startDay: number; days: BudgetDays; warnFraction: number; hardFraction: number;
  /** Scales ccusage's estimate toward the real bill (long-context turns cost more than ccusage prices them). 1 = take ccusage as is. */
  costMultiplier: number;
  /** Weight of a Saturday or Sunday in `weekdays` mode, 0 to 1 (0.333 = a third of a weekday's allowance). Ignored in `all` mode. */
  weekendWeight: number }

/** The raw settings as read from the config (strings, empty when unset). */
export interface BudgetRaw { monthly: string; startDay: string; days: string; warn: string; hard: string; multiplier?: string; weekendWeight?: string }

const num = (raw: string): number => (/^\d+(\.\d+)?$/.test(raw.trim()) ? Number(raw) : NaN);

/** Parses the raw settings; anything unset or invalid falls back to its default, and an unset or invalid budget means off. */
export function parseBudget(raw: BudgetRaw): BudgetConfig {
  const monthly = num(raw.monthly);
  const start = num(raw.startDay);
  const warn = num(raw.warn);
  const hard = num(raw.hard);
  const warnFraction = warn > 0 ? warn : 0.8;
  const weekend = num(raw.weekendWeight ?? '');
  return {
    monthlyUsd: monthly > 0 ? monthly : 0,
    startDay: Number.isInteger(start) && start >= 1 && start <= 28 ? start : 1,
    days: raw.days.trim().toLowerCase() === 'weekdays' ? 'weekdays' : 'all',
    warnFraction,
    costMultiplier: num(raw.multiplier ?? '') > 0 ? num(raw.multiplier ?? '') : 1,
    weekendWeight: weekend >= 0 && weekend <= 1 ? weekend : 0,
    hardFraction: hard > 0 ? Math.max(hard, warnFraction) : Math.max(1, warnFraction),
  };
}

export const budgetOn = (c: BudgetConfig): boolean => c.monthlyUsd > 0;

const toUtc = (d: string): number => Date.parse(`${d}T00:00:00Z`);
const fromUtc = (ms: number): string => new Date(ms).toISOString().slice(0, 10);
const DAY = 86_400_000;

/** True when `date` counts toward the budget: any day in `all` mode, Monday to Friday in `weekdays` mode. */
export function isBudgetDay(date: string, days: BudgetDays): boolean {
  if (days === 'all') return true;
  const dow = new Date(toUtc(date)).getUTCDay();
  return dow >= 1 && dow <= 5;
}

/** A day's share of a weekday's allowance: 1 for a budget day, else the weekend weight. */
export const dayWeight = (date: string, cfg: Pick<BudgetConfig, 'days' | 'weekendWeight'>): number => (isBudgetDay(date, cfg.days) ? 1 : cfg.weekendWeight);

/** First and last day (inclusive) of the period holding `today`: it starts on the latest `startDay` on or before today and ends the day before the next one. */
export function periodOf(today: string, startDay: number): { start: string; end: string } {
  const [y, m, d] = today.split('-').map(Number);
  const startMs = d >= startDay ? Date.UTC(y, m - 1, startDay) : Date.UTC(y, m - 2, startDay);
  const s = new Date(startMs);
  const nextMs = Date.UTC(s.getUTCFullYear(), s.getUTCMonth() + 1, startDay);
  return { start: fromUtc(startMs), end: fromUtc(nextMs - DAY) };
}

/** The dates from `from` to `to`, inclusive. */
function span(from: string, to: string): string[] {
  const out: string[] = [];
  for (let t = toUtc(from); t <= toUtc(to); t += DAY) out.push(fromUtc(t));
  return out;
}

export interface BudgetView {
  periodStart: string; periodEnd: string;
  /** Weighted budget days in the whole period, and how many of them are over once today is counted (a weekend day adds its weight). */
  budgetDays: number; elapsed: number;
  todayIsBudgetDay: boolean;
  /** Dollars allowed per weekday, and today (the weekday figure times today's weight). */
  dailyAllowance: number; todayAllowance: number;
  todaySpend: number; periodSpend: number;
  /** Allowance times budget days elapsed, today included. */
  paceAllowance: number;
  overPace: boolean;
}

/** Where `today` stands. `ccusageDaily` maps a date to ccusage's dollars for that day (a missing day is zero); every figure is scaled by `costMultiplier` before any comparison. */
export function evaluate(cfg: BudgetConfig, today: string, ccusageDaily: Record<string, number>): BudgetView {
  const daily = Object.fromEntries(Object.entries(ccusageDaily).map(([d, n]) => [d, n * cfg.costMultiplier]));
  const { start, end } = periodOf(today, cfg.startDay);
  const weigh = (from: string, to: string): number => span(from, to).reduce((n, d) => n + dayWeight(d, cfg), 0);
  const budgetDays = weigh(start, end);
  const elapsed = weigh(start, today);
  const dailyAllowance = budgetDays > 0 ? cfg.monthlyUsd / budgetDays : 0;
  const todayWeight = dayWeight(today, cfg);
  const todayIsBudgetDay = todayWeight > 0;
  const periodSpend = span(start, today).reduce((n, d) => n + (daily[d] ?? 0), 0);
  const paceAllowance = dailyAllowance * elapsed;
  return {
    periodStart: start, periodEnd: end, budgetDays, elapsed, todayIsBudgetDay,
    dailyAllowance, todayAllowance: dailyAllowance * todayWeight,
    todaySpend: daily[today] ?? 0, periodSpend, paceAllowance,
    overPace: periodSpend > paceAllowance + 0.005,
  };
}

const usd = (n: number): string => `$${n < 100 ? n.toFixed(2) : Math.round(n).toString()}`;
const usdWhole = (n: number): string => `$${Math.round(n)}`;
/** Weighted day counts: whole numbers as is, fractions to one decimal. */
const days = (n: number): string => (Number.isInteger(n) ? String(n) : n.toFixed(1));

/**
 * The footer segment: `Spend: $14.20 today of $23.81 · period $96 of $500 (on pace) · this machine`. With a multiplier other than 1 the figures read `~$14.20` and the
 * segment ends `(x1.47 est.)`; with `ctxK` above 200 it adds `ctx >200k: premium pricing` (turns over 200k input tokens bill at a premium).
 */
export function spendText(cfg: BudgetConfig, v: BudgetView, ctxK = 0): string {
  const est = cfg.costMultiplier !== 1;
  const m = (n: string): string => (est ? `~${n}` : n);
  const today = v.todayIsBudgetDay ? `${m(usd(v.todaySpend))} today of ${usd(v.todayAllowance)}` : `${m(usd(v.todaySpend))} today (not a budget day, $0 allowed)`;
  const tail = [`this machine`, ...(est ? [`x${cfg.costMultiplier} est.`] : []), ...(ctxK > 200 ? ['ctx >200k: premium pricing'] : [])].join(' · ');
  return `Spend: ${today} · period ${m(usdWhole(v.periodSpend))} of ${usdWhole(cfg.monthlyUsd)} (${v.overPace ? 'OVER pace' : 'on pace'}) · ${tail}`;
}

export type AlertKey = 'warn' | 'hard' | 'pace' | 'offday' | 'unreadable';
export interface Alert { key: AlertKey; text: string }

/** The thresholds crossed right now, in the order of how bad they are. Spend of a cent or less on a non-budget day is rounding, not spend. */
export function crossed(cfg: BudgetConfig, v: BudgetView): Alert[] {
  const out: Alert[] = [];
  const est = cfg.costMultiplier !== 1 ? ` (ccusage x${cfg.costMultiplier}, an estimate; the Console cost for the API key is authoritative)` : '';
  const spent = `${usd(v.todaySpend)} today`;
  if (!v.todayIsBudgetDay) {
    if (v.todaySpend > 0.01) out.push({ key: 'offday', text: `spend-watch: ${spent} on a day that is not a budget day (allowed $0). Stop dispatching agents; the company raises the budget if weekend work is wanted. Counted on this machine only${est}.` });
  } else if (v.todayAllowance > 0) {
    if (v.todaySpend >= cfg.hardFraction * v.todayAllowance) out.push({ key: 'hard', text: `spend-watch HARD: ${spent} is ${Math.round((100 * v.todaySpend) / v.todayAllowance)}% of the ${usd(v.todayAllowance)} daily allowance. Do only what the user explicitly asks. Counted on this machine only${est}.` });
    else if (v.todaySpend >= cfg.warnFraction * v.todayAllowance) out.push({ key: 'warn', text: `spend-watch WARN: ${spent} is ${Math.round((100 * v.todaySpend) / v.todayAllowance)}% of the ${usd(v.todayAllowance)} daily allowance. Tell the user and stop dispatching agents. Counted on this machine only${est}.` });
  }
  if (v.overPace) out.push({ key: 'pace', text: `spend-watch PACE: period ${usdWhole(v.periodSpend)} is over the ${usdWhole(v.paceAllowance)} pace (${days(v.elapsed)} of ${days(v.budgetDays)} budget days, ${usdWhole(cfg.monthlyUsd)} budget). Counted on this machine only${est}.` });
  return out;
}

/** What has been announced: the day, and the thresholds already said that day. */
export interface Announced { day: string; fired: AlertKey[] }

/**
 * The alerts not yet said today, and the new record. A new day starts a clean record. `warn` and `hard` are one ladder: once `hard` has been said,
 * a later `warn` is not (spend does not go back down within a day, and the cache can wobble at the line).
 */
export function dedupe(day: string, now: Alert[], prev: Announced | null): { fresh: Alert[]; next: Announced } {
  const fired = prev && prev.day === day ? prev.fired : [];
  const said = new Set<AlertKey>(fired);
  if (said.has('hard')) said.add('warn');
  const fresh = now.filter((a) => !said.has(a.key));
  return { fresh, next: { day, fired: [...new Set([...fired, ...fresh.map((a) => a.key)])] } };
}
