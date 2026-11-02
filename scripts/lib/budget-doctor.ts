/**
 * budget-doctor.ts: the budget guardrail checks behind `scripts/doctor.ts`. Each is a pure function of facts the CLI reads (settings object,
 * resolved config values, crontab text, plist text, the spend cache), so a test feeds fixtures. Only the two autocompact env values are ever
 * echoed; no other settings env value is read into a result.
 */
import { basename } from 'node:path';
import { checkRegistered } from './doctor.ts';
import type { CheckResult, HookCommand } from './doctor.ts';

/** The day the company's monthly Claude budget begins (YYYY-MM-DD). */
export const BUDGET_START = '2026-11-05';
/** Largest context, in tokens, at which autocompact may be left to fire. */
export const AUTOCOMPACT_MAX_TOKENS = 150_000;
/** A spend cache older than this is stale: the footer and spend-watch are not refreshing it. */
export const SPEND_CACHE_MAX_AGE_MS = 3 * 3_600_000;

export interface BudgetFacts {
  /** Today as YYYY-MM-DD, and now in epoch ms. */
  today: string; now: number;
  mode: string; costProfile: string;
  /** Parsed settings file, or null when it could not be read. */
  settings: { env?: Record<string, unknown>; enabledPlugins?: Record<string, unknown> } | null;
  wakeLaunchCommand: string[]; notifyCommand: string[];
  /** `crontab -l` output ('' when none) and the text of each LaunchAgents plist. */
  crontab: string; plists: { file: string; text: string }[];
  expectedHooks: string[]; registeredHooks: HookCommand[]; settingsFile: string;
  /** The spend cache file's parsed content, or null when it is absent or unreadable. */
  spendCache: { at?: unknown; error?: unknown } | null;
}

const res = (name: string, status: CheckResult['status'], detail: string): CheckResult => ({ name, status, detail });

export function checkModeProfile(f: BudgetFacts): CheckResult {
  const name = 'mode and cost profile';
  const detail = `mode ${f.mode}, cost_profile ${f.costProfile}`;
  return f.mode === 'full' && f.today >= BUDGET_START
    ? res(name, 'warn', `${detail}; the budget began ${BUDGET_START}. Set mode: slim in the maestro config`)
    : res(name, 'ok', detail);
}

const wholeNumber = (v: unknown): number => ((typeof v === 'string' || typeof v === 'number') && /^\d+$/.test(String(v).trim()) ? Number(v) : NaN);

export function checkAutocompact(f: BudgetFacts): CheckResult {
  const name = 'autocompact';
  if (!f.settings) return res(name, 'fail', `${f.settingsFile} could not be read. Check the claude_settings path in the maestro config`);
  const pct = wholeNumber(f.settings.env?.CLAUDE_AUTOCOMPACT_PCT_OVERRIDE);
  const win = wholeNumber(f.settings.env?.CLAUDE_CODE_AUTO_COMPACT_WINDOW);
  if (!(pct >= 1 && pct <= 100) || !(win > 0)) {
    return res(name, 'fail', `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE and CLAUDE_CODE_AUTO_COMPACT_WINDOW must both be set in the env of ${f.settingsFile} (pct 1 to 100, window above 0)`);
  }
  const trigger = Math.floor((win * pct) / 100);
  const detail = `window ${win} at ${pct}% compacts at ${trigger} tokens`;
  return trigger <= AUTOCOMPACT_MAX_TOKENS ? res(name, 'ok', detail) : res(name, 'fail', `${detail}, above ${AUTOCOMPACT_MAX_TOKENS}. Lower the pct or the window in the settings env`);
}

/** True when a command line or argv runs an executable named `claude`. A path that only passes through a `.claude` directory does not count. */
export const launchesClaude = (text: string): boolean => text.split(/[\s;&|()"'<>]+/).some((t) => t && basename(t) === 'claude');

const plistArgs = (text: string): string => {
  const block = /<key>ProgramArguments<\/key>\s*<array>([\s\S]*?)<\/array>/.exec(text)?.[1] ?? '';
  const prog = /<key>Program<\/key>\s*<string>([^<]*)<\/string>/.exec(text)?.[1] ?? '';
  return [prog, ...[...block.matchAll(/<string>([^<]*)<\/string>/g)].map((m) => m[1])].join(' ');
};

export function checkNoScheduledLaunches(f: BudgetFacts): CheckResult {
  const name = 'no scheduled LLM launches';
  const bad: string[] = [];
  if (f.wakeLaunchCommand.length) bad.push('wake_launch_command is set');
  for (const line of f.crontab.split('\n')) if (!line.trim().startsWith('#') && launchesClaude(line)) bad.push('a crontab line runs claude');
  for (const p of f.plists) {
    const args = plistArgs(p.text);
    if (launchesClaude(args) || (!args.trim() && /claude/i.test(p.text))) bad.push(`${basename(p.file)} runs claude`);
  }
  return bad.length
    ? res(name, 'fail', `${[...new Set(bad)].join('; ')}. Empty wake_launch_command and remove the entry (crontab -e, or launchctl bootout then delete the plist)`)
    : res(name, 'ok', 'wake_launch_command is empty and no crontab line or LaunchAgent runs claude');
}

export function checkNotifications(f: BudgetFacts): CheckResult {
  const name = 'notifications';
  return f.notifyCommand.length
    ? res(name, 'warn', 'notify_command is set, so alerts can send texts. Empty it in the maestro config')
    : res(name, 'ok', 'notify_command is empty (texts are off)');
}

/** Registration of every hook the snippet prints; for the budget doctor a missing hook is a FAIL, not a WARN. */
export function checkHooksInstalled(f: BudgetFacts): CheckResult {
  const r = checkRegistered(f.expectedHooks, f.registeredHooks, f.settings ? [f.settingsFile] : []);
  return { ...r, status: r.status === 'ok' ? 'ok' : 'fail' };
}

export function checkSpendCache(f: BudgetFacts): CheckResult {
  const name = 'spend cache fresh';
  const fix = 'Run journal.ts status --footer to refresh it (needs ccusage)';
  if (!f.spendCache) return res(name, 'warn', `no spend cache file yet. ${fix}`);
  if (typeof f.spendCache.at !== 'number') return res(name, 'warn', `the spend cache has no timestamp. ${fix}`);
  const ageMin = Math.round((f.now - f.spendCache.at) / 60_000);
  if (f.now - f.spendCache.at > SPEND_CACHE_MAX_AGE_MS) return res(name, 'warn', `last refreshed ${ageMin} minutes ago. ${fix}`);
  return f.spendCache.error ? res(name, 'warn', `the last ccusage read failed (${ageMin} minutes ago). ${fix}`) : res(name, 'ok', `refreshed ${ageMin} minutes ago`);
}

export function checkPlugins(f: BudgetFacts): CheckResult {
  const name = 'enabled plugins';
  if (!f.settings) return res(name, 'skip', `${f.settingsFile} could not be read`);
  const on = Object.values(f.settings.enabledPlugins ?? {}).filter((v) => v === true).length;
  return res(name, 'ok', `${on} enabled (each one adds to every session's context)`);
}

export const budgetChecks = (f: BudgetFacts): CheckResult[] => [
  checkModeProfile(f), checkAutocompact(f), checkNoScheduledLaunches(f), checkNotifications(f), checkHooksInstalled(f), checkSpendCache(f), checkPlugins(f),
].map((c) => ({ ...c, name: `budget: ${c.name}` }));
