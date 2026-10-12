import { readFileSync } from 'node:fs';
import { AUTOCOMPACT_FLOOR, CLAUDE_SETTINGS_PATH } from '../local-config.ts';

/**
 * The effective Claude Code autocompact setting, read from the process environment first (inside a session the harness has
 * already applied the settings `env` block) and then from the settings file. Only the two named keys are ever picked: nothing
 * else in the file is returned, logged or thrown.
 */
export interface AutocompactSetting { pct: number | null; window: number | null; source: 'env' | 'settings' | 'default' }

export const DEFAULT_WINDOW = 1_000_000;
/** The documented native trigger, about 967k of a 1M window. */
export const DEFAULT_TRIGGER_FRACTION = 0.967;
const PCT_KEY = 'CLAUDE_AUTOCOMPACT_PCT_OVERRIDE';
const WINDOW_KEY = 'CLAUDE_CODE_AUTO_COMPACT_WINDOW';

/** An integer percent in 1..100, else null. */
const parsePct = (v: unknown): number | null => {
  const n = typeof v === 'number' ? v : typeof v === 'string' && /^\d+$/.test(v.trim()) ? Number(v) : NaN;
  return Number.isInteger(n) && n >= 1 && n <= 100 ? n : null;
};
/** An integer window of at least 100k tokens, else null. */
const parseWindow = (v: unknown): number | null => {
  const n = typeof v === 'number' ? v : typeof v === 'string' && /^\d+$/.test(v.trim()) ? Number(v) : NaN;
  return Number.isInteger(n) && n >= 100_000 ? n : null;
};

/** Reads the setting; a missing or unparseable settings file is the default, never an error. */
export function readAutocompact(env: NodeJS.ProcessEnv = process.env, settingsPath: string = CLAUDE_SETTINGS_PATH): AutocompactSetting {
  const fromEnv = { pct: parsePct(env[PCT_KEY]), window: parseWindow(env[WINDOW_KEY]) };
  if (fromEnv.pct !== null || fromEnv.window !== null) return { ...fromEnv, source: 'env' };
  try {
    const parsed: unknown = JSON.parse(readFileSync(settingsPath, 'utf8'));
    const block = typeof parsed === 'object' && parsed !== null ? (parsed as { env?: unknown }).env : undefined;
    const settingsEnv = typeof block === 'object' && block !== null ? (block as Record<string, unknown>) : {};
    const fromFile = { pct: parsePct(settingsEnv[PCT_KEY]), window: parseWindow(settingsEnv[WINDOW_KEY]) };
    if (fromFile.pct !== null || fromFile.window !== null) return { ...fromFile, source: 'settings' };
  } catch { /* no settings file, or not JSON: the native default applies */ }
  return { pct: null, window: null, source: 'default' };
}

/** Tokens at which the setting compacts: the window (capped at the model's) times the percent, else the native fraction. */
export function triggerTokens(s: AutocompactSetting, modelWindow: number = DEFAULT_WINDOW): number {
  const w = Math.min(s.window ?? modelWindow, modelWindow);
  return s.pct ? Math.round((w * s.pct) / 100) : Math.round(w * DEFAULT_TRIGGER_FRACTION);
}

const k = (n: number): string => `${Math.round(n / 1000)}k`;

/** Describes the setting for the snippet command: value, source and trigger. */
export function describeSetting(s: AutocompactSetting): string {
  return `autocompact: ${s.pct ?? 'unset'}% of ${k(s.window ?? DEFAULT_WINDOW)} window (source ${s.source}), trigger ${k(triggerTokens(s))}`;
}

/** One warning line when the trigger sits below the floor; nothing is written anywhere. */
export function floorWarnings(s: AutocompactSetting, floor: number = AUTOCOMPACT_FLOOR): string[] {
  const trigger = triggerTokens(s);
  if (trigger >= floor) return [];
  return [`${PCT_KEY}=${s.pct ?? 'unset'} puts the autocompact trigger at ${k(trigger)}, below the ${k(floor)} floor: a trigger near the post-compaction base of about 50 to 60k compacts every 1 to 2 minutes (6 in 10 minutes on 2026-10-10).`];
}

/** Informational only: what the percentage means for a 200k-window model (inferred, not verified). */
export function subagentNote(s: AutocompactSetting): string {
  const w = 200_000;
  return `a 200k-window model (Haiku) compacts at about ${k(s.pct ? Math.round((w * s.pct) / 100) : Math.round(w * DEFAULT_TRIGGER_FRACTION))} with this percentage (inferred, not verified).`;
}
