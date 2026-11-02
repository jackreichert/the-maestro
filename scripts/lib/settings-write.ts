/**
 * The allowlisted writer for the user config file (`config.md`). Only the keys in `ALLOWED` can be set, each to a value its check accepts;
 * every other key (any command, gate, notify, path or security key) is refused, and so is a value that fails its check.
 * The edit is `setConfigValue` (that key's line only, trailing comment and all other text kept). When the file would change, the
 * old file is first copied to `<file>.bak-<UTC timestamp>` next to it, then the new text is written through a temp file and renamed.
 * Setting the value already there changes nothing and writes no backup.
 */
import { copyFileSync, existsSync, readFileSync, realpathSync, renameSync, statSync, chmodSync, writeFileSync } from 'node:fs';
import { setConfigValue } from './config-write.ts';

/** Each editable key and the check on its value: the check returns the value to write, or null when it is not acceptable. */
export const ALLOWED: Record<string, { rule: string; check: (v: string) => string | null }> = {
  mode: { rule: 'full or slim', check: (v) => (/^(full|slim)$/.test(v) ? v : null) },
  cost_profile: { rule: 'full or lean', check: (v) => (/^(full|lean)$/.test(v) ? v : null) },
  watch_quiet_hours: { rule: 'HH:MM-HH:MM (24-hour)', check: (v) => (/^([01]\d|2[0-3]):[0-5]\d-([01]\d|2[0-3]):[0-5]\d$/.test(v) ? v : null) },
  budget_weekend_weight: { rule: 'a number from 0 to 1', check: (v) => (/^(0(\.\d{1,3})?|1(\.0{1,3})?)$/.test(v) ? v : null) },
};

const stamp = (now: Date): string => now.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');

/** Sets one allowlisted key in the config file at `path`. Returns whether the file changed; throws on a refused key or value, a disabled path or a missing file. */
export function setSetting(path: string, key: string, value: string, now: Date = new Date()): 'changed' | 'unchanged' {
  const entry = Object.hasOwn(ALLOWED, key) ? ALLOWED[key] : undefined;
  if (!entry) throw new Error(`${key}: not an editable setting (editable: ${Object.keys(ALLOWED).join(', ')}).`);
  const v = entry.check(value.trim());
  if (v === null) throw new Error(`${key} must be ${entry.rule}, got "${value}".`);
  if (!path) throw new Error('The user config file is disabled (MAESTRO_LOCAL_CONFIG is empty); nothing to write.');
  if (!existsSync(path)) throw new Error(`There is no config file at ${path}; create it first.`);
  const real = realpathSync(path);   // write through a symlinked (dotfile-managed) config, not over the link
  const before = readFileSync(real, 'utf8');
  const after = setConfigValue(before, key, v);
  if (after === before) return 'unchanged';
  copyFileSync(real, `${real}.bak-${stamp(now)}`);
  const tmp = `${real}.tmp-${process.pid}`;
  writeFileSync(tmp, after);
  chmodSync(tmp, statSync(real).mode & 0o777);
  renameSync(tmp, real);
  return 'changed';
}
