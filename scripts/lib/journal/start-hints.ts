import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { LedgerItem } from '../ledger-core.ts';

/**
 * What makes `journal.ts start` cheap to get right: a stream inferred from the repo when the ledger names only one for it, a model
 * read from the agent type's definition, and a refusal that prints the command to run instead of the rule that was broken.
 */

/** A fill-in marker such as `<MODEL>`: printed bare, so a line still holding one is a shell syntax error and cannot run as printed. */
export const isPlaceholder = (s: string): boolean => /^<[A-Z_]+>$/.test(s);

const shq = (s: string): string => (/^[A-Za-z0-9_@%+=:,./-]+$/.test(s) || isPlaceholder(s) ? s : `'${s.replace(/'/g, "'\\''")}'`);
const skipsValue = (argv: readonly string[], i: number): boolean => !(argv[i] as string).includes('=') && argv[i + 1] !== undefined && !argv[i + 1]?.startsWith('--');

/**
 * The command line to run instead: `argv` (the words after the script) with each `set` flag given the new value, appended when
 * absent. A flag with no value in `set` is left as it was; `drop` removes flags (and their values) outright.
 */
export function correctedCommand(argv: readonly string[], set: Record<string, string>, drop: readonly string[] = []): string {
  const out: string[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] as string;
    const name = a.startsWith('--') ? a.slice(2).split('=')[0] as string : '';
    if (name && drop.includes(name)) { if (skipsValue(argv, i)) i++; continue; }
    if (name && name in set) {
      seen.add(name);
      out.push(`--${name}`, shq(set[name] as string));
      if (skipsValue(argv, i)) i++;
      continue;
    }
    out.push(shq(a));
  }
  for (const [name, value] of Object.entries(set)) if (!seen.has(name)) out.push(`--${name}`, shq(value));
  return `journal.ts ${out.join(' ')}`;
}

/**
 * The one stream the ledger has always used for `repo`, or undefined when it has used none or more than one. Unambiguous means
 * every stream-tagged row on that repo names the same canonical stream; a repo shared by two streams is never guessed at.
 */
export function inferStreamForRepo(items: readonly LedgerItem[], repo: string | undefined, canonical: (s: string) => string | null, usable: (s: string) => boolean = () => true): string | undefined {
  if (!repo) return undefined;
  const streams = new Set<string>();
  for (const i of items) {
    if (i.repo !== repo || !i.stream || i.stream === 'none') continue;
    streams.add(canonical(i.stream) ?? i.stream);
  }
  const only = streams.size === 1 ? [...streams][0] : undefined;
  // The one stream must also be one a row can be written to now (registered and not archived), or inferring it would refuse a start that used to work.
  return only && usable(only) ? only : undefined;
}

/**
 * The `model:` an agent type's definition file names (`<dir>/<type>.md` front matter), or undefined for no file, no `model:` line,
 * or `inherit`. The type is a bare name: anything with a path separator or a plugin prefix is refused rather than followed.
 */
export function modelOfAgentType(agentType: string, dirs: readonly string[]): string | undefined {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(agentType)) return undefined;
  for (const dir of dirs) {
    const file = join(dir, `${agentType}.md`);
    if (!existsSync(file)) continue;
    const head = readFileSync(file, 'utf8').split('\n---')[0] ?? '';
    const m = /^model:\s*['"]?([^'"\n]+?)['"]?\s*$/m.exec(head);
    const v = m?.[1]?.trim();
    return v && v !== 'inherit' ? v : undefined;
  }
  return undefined;
}
