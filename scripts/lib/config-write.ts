/**
 * Writes one setting into the `maestro-config` fenced block of the user config file (the file local-config.ts reads).
 *
 * `setConfigValue` is the pure text edit: it replaces the key's line in the block (keeping any trailing comment),
 * appends the line when the block lacks it, or appends a whole block when the text has none. Every other line,
 * comment and the prose around the block are untouched, and applying the same edit twice changes nothing.
 * `setAutoPull` is the file-level wrapper behind `journal.ts autopull on|off`.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

const FENCE = /^```maestro-config[^\n]*\n([\s\S]*?)^```/m;
const NEW_FILE = '# the-maestro config\n\nSettings the-maestro reads (see reference/local-config.md).\n';

/** Returns `text` with `key: value` set in the maestro-config block, creating the block when there is none. */
export function setConfigValue(text: string, key: string, value: string): string {
  const line = `${key}: ${value}`;
  const m = FENCE.exec(text);
  if (!m) {
    const gap = text === '' ? '' : text.endsWith('\n') ? '\n' : '\n\n';
    return `${text}${gap}\`\`\`maestro-config\n${line}\n\`\`\`\n`;
  }
  const body = m[1] ?? '';
  const keyed = new RegExp(`^(\\s*)${key}\\s*:[^\\n#]*?(\\s+#.*)?$`);
  let found = false;
  const lines = body.split('\n').map((l) => {
    const k = keyed.exec(l);
    if (!k) return l;
    found = true;
    return `${k[1] ?? ''}${line}${k[2] ?? ''}`;
  });
  const next = found ? lines.join('\n') : `${body}${body === '' || body.endsWith('\n') ? '' : '\n'}${line}\n`;
  const start = m.index + m[0].indexOf('\n') + 1;
  return text.slice(0, start) + next + text.slice(start + body.length);
}

/** Sets `auto_pull` to `on` or `off` in the config file at `path`, creating the file and its directory. Returns what changed. */
export function setAutoPull(path: string, value: string): 'created' | 'changed' | 'unchanged' {
  const v = value.trim().toLowerCase();
  if (v !== 'on' && v !== 'off') throw new Error(`auto_pull must be "on" or "off", got "${value}".`);
  if (!path) throw new Error('The user config file is disabled (MAESTRO_LOCAL_CONFIG is empty); nothing to write.');
  const existed = existsSync(path);
  const before = existed ? readFileSync(path, 'utf8') : NEW_FILE;
  const after = setConfigValue(before, 'auto_pull', v);
  if (existed && after === before) return 'unchanged';
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, after);
  renameSync(tmp, path);
  return existed ? 'changed' : 'created';
}
