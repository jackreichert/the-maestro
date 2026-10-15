/**
 * SCRIPT CATALOG: the declared list of scripts the Podium may run, and how a request for one becomes an argv.
 *
 * The catalog is a data file in the repo (`podium/scripts.json`): per entry an id, a description, the command as an argv vector, an args schema, whether it
 * is read-only, and a model tier. An entry that does not validate is dropped and listed as a problem, never run. A run never goes through a shell: the
 * command is spawned as argv, and each arg is validated against its schema and appended as its own argv element, so nothing the page sends is ever expanded or
 * split. Placeholders in the command (`{node}`, `{home}`, `{ledger}`, `{vault}`, `{project}`) come from the server's own settings, never from the request.
 */
import { readFileSync } from 'node:fs';
import { secretFileRefs } from './command-guard.ts';

export type ArgType = 'string' | 'integer' | 'enum' | 'boolean';
export interface ArgSpec { name: string; type: ArgType; flag?: string; required?: boolean; default?: string | number | boolean; pattern?: string; maxLength?: number; min?: number; max?: number; values?: string[]; description?: string }
export interface Entry { id: string; name: string; description: string; group: string; command: string[]; args: ArgSpec[]; readOnly: boolean; tier: 'haiku' | 'sonnet' | 'opus' | 'none'; timeoutSeconds: number }
export interface Catalog { entries: Entry[]; problems: string[] }
export type ArgValues = Record<string, string | number | boolean>;
export interface Context { node: string; home: string; ledger: string; vault: string; project: string }

export const MAX_TIMEOUT_SECONDS = 600;
const ID = /^[a-z0-9][a-z0-9-]{0,47}$/;
const NAME = /^[a-z][A-Za-z0-9_]{0,23}$/;
const FLAG = /^--[a-z][a-z0-9-]{0,31}$/;
const PLACEHOLDER = /\{(node|home|ledger|vault|project)\}/g;
const DEFAULT_MAX_LENGTH = 80;
const TIERS = ['haiku', 'sonnet', 'opus', 'none'];

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown, max: number): v is string => typeof v === 'string' && v.length > 0 && v.length <= max;

/** Why an arg spec is not acceptable, or null. A string arg must carry a pattern: no free text reaches an argv. */
function argProblem(a: unknown): string | null {
  if (!isObj(a)) return 'an arg is not an object';
  if (typeof a.name !== 'string' || !NAME.test(a.name)) return 'an arg has a bad name';
  if (!['string', 'integer', 'enum', 'boolean'].includes(String(a.type))) return `arg ${a.name}: unknown type`;
  if (a.flag !== undefined && (typeof a.flag !== 'string' || !FLAG.test(a.flag))) return `arg ${a.name}: bad flag`;
  if (a.type === 'boolean' && a.flag === undefined) return `arg ${a.name}: a boolean needs a flag`;
  if (a.type === 'string') {
    if (typeof a.pattern !== 'string') return `arg ${a.name}: a string arg needs a pattern`;
    try { new RegExp(a.pattern); } catch { return `arg ${a.name}: the pattern does not compile`; }
    if (!a.pattern.startsWith('^') || !a.pattern.endsWith('$')) return `arg ${a.name}: the pattern must be anchored (^...$)`;
  }
  if (a.type === 'enum' && (!Array.isArray(a.values) || !a.values.length || a.values.some((x) => typeof x !== 'string' || !x))) return `arg ${a.name}: an enum needs values`;
  if (a.type === 'integer' && (!Number.isInteger(a.min) || !Number.isInteger(a.max))) return `arg ${a.name}: an integer needs min and max`;
  return null;
}

/** Why an entry is not acceptable, or null. */
function entryProblem(e: unknown): string | null {
  if (!isObj(e)) return 'an entry is not an object';
  if (typeof e.id !== 'string' || !ID.test(e.id)) return 'an entry has a bad id';
  const who = `entry ${e.id}`;
  if (!str(e.name, 80) || !str(e.description, 300) || !str(e.group, 40)) return `${who}: name, description and group are required`;
  if (!Array.isArray(e.command) || !e.command.length || e.command.some((t) => !str(t, 300))) return `${who}: command must be a list of strings`;
  if (e.command[0] !== '{node}' && !String(e.command[0]).startsWith('/')) return `${who}: the program must be {node} or an absolute path`;
  if (secretFileRefs(e.command.join(' ')).length) return `${who}: the command names a secret file`;
  if (typeof e.readOnly !== 'boolean') return `${who}: readOnly must be true or false`;
  if (!TIERS.includes(String(e.tier))) return `${who}: tier must be one of ${TIERS.join(', ')}`;
  if (!Number.isInteger(e.timeoutSeconds) || (e.timeoutSeconds as number) < 1 || (e.timeoutSeconds as number) > MAX_TIMEOUT_SECONDS) return `${who}: timeoutSeconds must be 1..${MAX_TIMEOUT_SECONDS}`;
  if (!Array.isArray(e.args)) return `${who}: args must be a list`;
  const names = new Set<string>();
  for (const a of e.args) {
    const p = argProblem(a);
    if (p) return `${who}: ${p}`;
    const n = (a as ArgSpec).name;
    if (names.has(n)) return `${who}: duplicate arg ${n}`;
    names.add(n);
  }
  return null;
}

/** Validates a parsed catalog document. Entries that fail are dropped with a reason; duplicates keep the first. */
export function parseCatalog(doc: unknown): Catalog {
  const problems: string[] = [];
  if (!isObj(doc) || !Array.isArray(doc.scripts)) return { entries: [], problems: ['the catalog has no "scripts" list'] };
  const entries: Entry[] = [];
  for (const raw of doc.scripts) {
    const p = entryProblem(raw);
    if (p) { problems.push(p); continue; }
    const e = raw as Entry;
    if (entries.some((x) => x.id === e.id)) { problems.push(`entry ${e.id}: duplicate id`); continue; }
    entries.push(e);
  }
  return { entries, problems };
}

/** Reads the catalog file. A missing or malformed file is an empty catalog with a problem, never a throw. */
export function loadCatalog(path: string): Catalog {
  try { return parseCatalog(JSON.parse(readFileSync(path, 'utf8'))); } catch { return { entries: [], problems: ['the catalog file cannot be read'] }; }
}

/** The args as argv elements, or the reason they are refused. Unknown names, a bad type, a value off its schema, a missing required arg: all refused. */
export function buildArgs(spec: ArgSpec[], given: unknown): { ok: true; argv: string[] } | { ok: false; message: string } {
  if (given !== undefined && !isObj(given)) return { ok: false, message: 'args must be an object' };
  const values = (given ?? {}) as Record<string, unknown>;
  for (const k of Object.keys(values)) if (!spec.some((a) => a.name === k)) return { ok: false, message: `Unknown argument: ${k.slice(0, 30)}` };
  const argv: string[] = [];
  for (const a of spec) {
    const v = Object.hasOwn(values, a.name) ? values[a.name] : a.default;
    if (v === undefined) { if (a.required) return { ok: false, message: `Missing argument: ${a.name}` }; continue; }
    const text = checkValue(a, v);
    if (text === null) return { ok: false, message: `Bad value for ${a.name}` };
    if (a.type === 'boolean') { if (v === true) argv.push(a.flag!); continue; }
    if (a.flag) argv.push(a.flag, text); else argv.push(text);
  }
  return { ok: true, argv };
}

/** One value as the argv text it becomes, or null when it is off its schema. Text starting with `-` is never accepted as a bare positional. */
function checkValue(a: ArgSpec, v: unknown): string | null {
  if (a.type === 'boolean') return typeof v === 'boolean' ? String(v) : null;
  if (a.type === 'integer') return typeof v === 'number' && Number.isInteger(v) && v >= a.min! && v <= a.max! ? String(v) : null;
  if (typeof v !== 'string' || v.length === 0 || /[\0\r\n]/.test(v)) return null;
  if (a.type === 'enum') return a.values!.includes(v) ? v : null;
  if (v.length > (a.maxLength ?? DEFAULT_MAX_LENGTH) || !new RegExp(a.pattern!).test(v)) return null;
  if (!a.flag && v.startsWith('-')) return null;
  return v;
}

/** The command with its placeholders filled from the server's own settings, then the validated args. */
export function buildArgv(e: Entry, given: unknown, ctx: Context): { ok: true; argv: string[] } | { ok: false; message: string } {
  const args = buildArgs(e.args, given);
  if (!args.ok) return args;
  const fill = (t: string): string => t.replace(PLACEHOLDER, (_m, k: keyof Context) => ctx[k]);
  return { ok: true, argv: [...e.command.map(fill), ...args.argv] };
}

/** An argv as one line a person can read: words with anything beyond a plain path or flag in single quotes. Display only; it is never run. */
export const displayArgv = (argv: string[]): string => argv.map((t) => (/^[A-Za-z0-9_@%+=:,./-]+$/.test(t) ? t : `'${t.replace(/'/g, `'\\''`)}'`)).join(' ');

/** What the Scripts tab lists: the entry without the command (it is shown on review, filled in). */
export const publicEntry = (e: Entry): Omit<Entry, 'command'> => { const { command: _command, ...rest } = e; return rest; };
