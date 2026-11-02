#!/usr/bin/env node
/**
 * settings.ts: see and change the cost-relevant maestro settings.
 *
 *   settings.ts list [--json]       every resolved setting by group (value, source), and today's spend against the budget
 *   settings.ts set <key> <value>   change one allowlisted key in the user config.md (a backup is kept next to it)
 *
 * `list` is lib/settings-model.ts; `set` is lib/settings-write.ts, which refuses every key outside its allowlist. Secret-named keys and commands are never printed.
 */
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { userPath } from './local-config.ts';
import { buildSettings } from './lib/settings-model.ts';
import type { SettingsData } from './lib/settings-model.ts';
import { ALLOWED, setSetting } from './lib/settings-write.ts';

const usd = (n: number | null): string => (n === null ? 'n/a' : `$${n < 100 ? n.toFixed(2) : Math.round(n)}`);

/** The plain-text listing. */
export function render(d: SettingsData): string {
  const s = d.spend;
  const spend = s.on
    ? [`Today:  ${usd(s.todaySpend)} of ${usd(s.todayAllowance)} allowed`, `Period: ${usd(s.periodSpend)} of ${usd(s.paceAllowance)} pace (${s.periodStart} to ${s.periodEnd})`, `Month projection: ${usd(s.projection)} against ${usd(s.monthlyUsd)}`, `Per weekday: ${usd(s.perWeekday)}`]
    : ['Budget: off (set budget_monthly_usd to turn it on)'];
  const groups = d.groups.flatMap((g) => ['', `${g.name}`, ...g.rows.flatMap((r) => [
    `  ${r.key} = ${r.value || '(unset)'}   [${r.source}]${ALLOWED[r.key] ? '  (editable)' : ''}${r.perWeekday !== null ? `  about ${usd(r.perWeekday)} per weekday` : ''}`,
    ...(r.what ? [`      ${r.what}`] : []),
  ])]);
  return [...spend, ...groups].join('\n');
}

/** Runs one command; returns the exit code. */
export function main(argv: string[], out: (s: string) => void = console.log, err: (s: string) => void = console.error): number {
  const [cmd, ...rest] = argv;
  if (cmd === 'list' && rest.every((a) => a === '--json')) {
    const d = buildSettings();
    out(rest.length ? JSON.stringify(d, null, 2) : render(d));
    return 0;
  }
  if (cmd === 'set' && rest.length === 2) {
    try {
      out(`${rest[0]}: ${setSetting(userPath, rest[0] as string, rest[1] as string)}`);
      return 0;
    } catch (e) { err(e instanceof Error ? e.message : String(e)); return 2; }
  }
  err('Usage: settings.ts list [--json] | settings.ts set <key> <value>');
  return 2;
}

const isMain = (): boolean => { try { return realpathSync(process.argv[1] ?? '') === fileURLToPath(import.meta.url); } catch { return false; } };
if (isMain()) process.exitCode = main(process.argv.slice(2));
