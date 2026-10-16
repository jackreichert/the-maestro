/**
 * The script registry: commands only the user can run (a denied tool call, an allow rule, a ticket close), each with what it does and why it is needed.
 *
 * Storage is an append-only JSONL file beside the ledger (`<ledger root>/Projects/<project>/Journal/scripts.jsonl`), like drafts.jsonl: an `add` row
 * holds the entry, a `ran` row records that the user ran it (the Podium's own runs are read from the ledger's `run` rows, see view.ts). Nothing is rewritten.
 * The command is stored as plain text and written once more to a block file (`Journal/script-blocks/<id>.sh`), which is what the entry's run-this
 * ask points at, so the existing reviewed-run route (run-source.ts) is the only thing that can ever execute it. This module never runs anything.
 * `validateScript` refuses a command the reviewed-run guard would refuse, a secret-shaped value anywhere in the entry, and anything over a length cap.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';
import { dirname, join } from 'node:path';
import { checkBlock, describe } from '../run/command-guard.ts';
import type { ExtraGuard } from '../run/command-guard.ts';
import { secretShaped } from '../withhold.ts';

export const SCRIPT_KINDS = ['one-time', 'reusable'] as const;
export type ScriptKind = typeof SCRIPT_KINDS[number];
export const MAX_TITLE = 120;
export const MAX_PROSE = 600;
export const MAX_COMMAND = 8000;
const REF = /^[A-Za-z0-9][A-Za-z0-9._-]{1,47}$/;
const ID = /^sc-[0-9a-f]{8}$/;
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\p{Cf}]/u;
/** Bidi controls can make a command read differently from what it runs (Trojan Source); refused in the command as well as the prose. */
const BIDI = /[\u202a-\u202e\u2066-\u2069]/;

/** What a caller supplies. `blocks` is the ledger or ticket id of the work this unblocks; `blockedBy` names the agent and task that hit the wall. */
export interface NewScript { kind: ScriptKind; title: string; what: string; why: string; after: string; blocks: string; blockedBy?: string; command: string }
/** One entry as stored: the input, an id, when it was made and the id of the ask raised for it. */
export interface ScriptEntry extends NewScript { id: string; createdAt: string; ask: string }
export type RanResult = 'done' | 'failed';
export interface RanEvent { id: string; at: string; result: RanResult; via: 'podium' | 'cli' }

export const scriptsPath = (vault: string, project: string): string => join(vault, 'Projects', project, 'Journal', 'scripts.jsonl');
export const blockPath = (vault: string, project: string, id: string): string => join(vault, 'Projects', project, 'Journal', 'script-blocks', `${id}.sh`);
export const isScriptId = (v: unknown): v is string => typeof v === 'string' && ID.test(v);

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown, max: number): v is string => typeof v === 'string' && v.trim().length > 0 && v.length <= max;

/** The reasons an entry is refused; empty when it may be stored. Prose is one plain line each; the command may span lines. */
export function validateScript(s: NewScript, extra?: ExtraGuard): string[] {
  const errors: string[] = [];
  if (!SCRIPT_KINDS.includes(s.kind)) errors.push(`--kind must be one of: ${SCRIPT_KINDS.join(', ')}.`);
  const prose: [string, string, number][] = [['title', s.title, MAX_TITLE], ['what', s.what, MAX_PROSE], ['why', s.why, MAX_PROSE], ['after', s.after, MAX_PROSE]];
  for (const [name, value, max] of prose) {
    if (!str(value, max)) errors.push(`--${name} is required, plain text, at most ${max} characters.`);
    else if (CONTROL.test(value) || value.includes('\n')) errors.push(`--${name} must be one plain line.`);
  }
  if (!REF.test(s.blocks ?? '')) errors.push('--blocks needs the ledger or ticket id of the work this unblocks (letters, digits, . _ -).');
  if (s.blockedBy !== undefined && (!str(s.blockedBy, MAX_TITLE) || CONTROL.test(s.blockedBy))) errors.push(`--blocked-by must be plain text, at most ${MAX_TITLE} characters (the agent and its task).`);
  if (typeof s.command !== 'string' || !s.command.trim()) errors.push('The command is empty: give it after `--`.');
  else if (s.command.length > MAX_COMMAND) errors.push(`The command is over ${MAX_COMMAND} characters.`);
  else {
    if (CONTROL.test(s.command.replace(/[\n\t]/g, '')) || BIDI.test(s.command)) errors.push('The command holds control or direction-changing characters.');
    const verdict = checkBlock(s.command, extra);
    if (!verdict.ok) errors.push(`The command would not pass the run-this guard:\n${describe(verdict)}`);
  }
  for (const [name, value] of [...prose.map(([n, v]) => [n, v] as const), ['blocked-by', s.blockedBy ?? ''] as const]) if (secretShaped(value)) errors.push(`--${name} looks like a secret. Name a variable, never its value.`);
  return errors;
}

const entryOf = (v: unknown): ScriptEntry | null => {
  if (!isObj(v) || v.ev !== 'add' || !isScriptId(v.id) || !SCRIPT_KINDS.includes(v.kind as ScriptKind)) return null;
  const ok = str(v.title, MAX_TITLE) && str(v.what, MAX_PROSE) && str(v.why, MAX_PROSE) && str(v.after, MAX_PROSE) && typeof v.blocks === 'string' && REF.test(v.blocks)
    && typeof v.command === 'string' && v.command.length <= MAX_COMMAND && str(v.createdAt, 40) && typeof v.ask === 'string' && /^[a-z0-9]{4,6}$/.test(v.ask);
  if (!ok || (v.blockedBy !== undefined && !str(v.blockedBy, MAX_TITLE))) return null;
  return { id: v.id as string, kind: v.kind as ScriptKind, title: v.title as string, what: v.what as string, why: v.why as string, after: v.after as string, blocks: v.blocks as string, ...(v.blockedBy ? { blockedBy: v.blockedBy as string } : {}), command: v.command as string, createdAt: v.createdAt as string, ask: v.ask as string };
};
const ranOf = (v: unknown): RanEvent | null => (isObj(v) && v.ev === 'ran' && isScriptId(v.id) && str(v.at, 40) && (v.result === 'done' || v.result === 'failed') && (v.via === 'podium' || v.via === 'cli') ? { id: v.id, at: v.at, result: v.result, via: v.via } : null);

/** The file's entries and runs; a line that is not a known row is skipped, never trusted. The first `add` of an id wins. */
export function readScripts(file: string): { entries: ScriptEntry[]; ran: RanEvent[] } {
  const entries = new Map<string, ScriptEntry>();
  const ran: RanEvent[] = [];
  if (!existsSync(file)) return { entries: [], ran };
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    let row: unknown;
    try { row = JSON.parse(line); } catch { continue; }
    const e = entryOf(row);
    if (e) { if (!entries.has(e.id)) entries.set(e.id, e); continue; }
    const r = ranOf(row);
    if (r) ran.push(r);
  }
  return { entries: [...entries.values()], ran: ran.filter((r) => entries.has(r.id)) };
}

const append = (file: string, row: object): void => { mkdirSync(dirname(file), { recursive: true }); appendFileSync(file, `${JSON.stringify(row)}\n`); };

/** The identity of a registration, so a producer that runs twice does not raise a second ask for the same wall. */
export const keyOf = (s: Pick<NewScript, 'kind' | 'title' | 'command' | 'blocks'>): string => createHash('sha256').update([s.kind, s.title, s.command, s.blocks].join('\0')).digest('hex');

export function newScriptId(taken: Iterable<string>): string {
  const used = new Set(taken);
  for (;;) { const id = `sc-${randomBytes(4).toString('hex')}`; if (!used.has(id)) return id; }
}

/** Writes the command's block file: the file the run-this ask points at, and the only copy of the command anything can run. */
export function writeBlock(o: { vault: string; project: string; id: string; command: string }): string {
  const block = blockPath(o.vault, o.project, o.id);
  mkdirSync(dirname(block), { recursive: true });
  writeFileSync(block, o.command.endsWith('\n') ? o.command : `${o.command}\n`, { mode: 0o600 });
  return block;
}

/** Appends the `add` row. Called after the ask exists, so an entry always has a way to run. */
export function appendEntry(o: { vault: string; project: string; id: string; script: NewScript; ask: string; now: Date }): ScriptEntry {
  const { blockedBy, ...rest } = o.script;
  const entry: ScriptEntry = { ...rest, ...(blockedBy ? { blockedBy } : {}), id: o.id, createdAt: o.now.toISOString(), ask: o.ask };
  append(scriptsPath(o.vault, o.project), { ev: 'add', ...entry });
  return entry;
}

/** Records that the user ran a script. One row per call: a reusable script is run again and again, each leaves its own. */
export function recordRan(o: { vault: string; project: string; id: string; result: RanResult; via: RanEvent['via']; now: Date }): void {
  append(scriptsPath(o.vault, o.project), { ev: 'ran', id: o.id, at: o.now.toISOString(), result: o.result, via: o.via });
}
