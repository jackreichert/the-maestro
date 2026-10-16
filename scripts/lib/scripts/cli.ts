/**
 * `journal.ts script add|list|ran`: register a command the user has to run, list the registry, or record that it was run.
 *
 *   script add --kind one-time|reusable --title "<t>" --what "<what it does>" --why "<why we need it>" --after "<what happens after>" --blocks <id> [--blocked-by "<agent: task>"] -- <command>
 *   script list [--all] [--json]       the scripts waiting on the user and the reusable ones (--all adds History)
 *   script ran <id> [--result done|failed]   record that the user ran it; `done` also resolves its ask
 *
 * The command comes after `--` (one quoted word, or several that are re-quoted), or from `--command "<text>"` or `--command-file <path>`.
 * Nothing here runs the command: the user runs it from the Podium's Run button (the reviewed-run route) or copies it.
 */
import { readFileSync } from 'node:fs';
import type { Store } from '../journal/store.ts';
import type { CloseResult } from '../journal/close.ts';
import { registerScript } from './register.ts';
import { recordRan } from './registry.ts';
import type { NewScript, RanResult, ScriptKind } from './registry.ts';
import { markRefusal, viewsFor } from './view.ts';
import type { ScriptView } from './view.ts';

export const SCRIPT_USAGE: readonly string[] = [
  'journal.ts script add --kind one-time|reusable --title "<t>" --what "<what it does>" --why "<why we need it>" --after "<what happens after>" --blocks <ledger or ticket id> [--blocked-by "<agent: task>"] [--stream <name>] [--command "<text>" | --command-file <path> | -- <command>]',
  '    registers a command only the user can run and raises a Needs-you run-this ask that links to it on the Scripts tab; the command is shown verbatim, never run by this tool',
  'journal.ts script list [--all] [--json]       blocked and reusable scripts (--all adds History)',
  'journal.ts script ran <id> [--result done|failed]   record a run; done also resolves the ask',
];

export interface ScriptCli {
  store: Store; vault: string; project: string; argv: string[];
  arg: (name: string) => string | null; has: (name: string) => boolean; positional: string[];
  stream: () => string | undefined; usage: () => Record<string, unknown>;
  today: () => string; now: () => Date; dryRun: boolean;
  close: (askId: string, note: string) => CloseResult['kind'];
  out: (line: string) => void; err: (line: string) => void;
}

const quote = (w: string): string => (/^[\w@%+=:,./-]+$/.test(w) ? w : `'${w.replace(/'/g, `'\\''`)}'`);

/** The command: after `--`, from --command, or from --command-file. Exactly one source. */
function commandOf(c: ScriptCli): string | { error: string } {
  const stop = c.argv.indexOf('--');
  const literal = stop === -1 ? [] : c.argv.slice(stop + 1);
  const sources = [literal.length > 0, c.has('command'), c.has('command-file')].filter(Boolean).length;
  if (sources !== 1) return { error: 'Give the command exactly one way: after `--`, as --command "<text>", or as --command-file <path>.' };
  if (literal.length) return literal.length === 1 ? (literal[0] as string) : literal.map(quote).join(' ');
  if (c.has('command')) return c.arg('command') ?? { error: '--command needs the command text.' };
  const file = c.arg('command-file');
  if (!file) return { error: '--command-file needs a path.' };
  try { return readFileSync(file, 'utf8').replace(/\n+$/, ''); } catch { return { error: `--command-file ${file} cannot be read.` }; }
}

function add(c: ScriptCli): number {
  const command = commandOf(c);
  if (typeof command !== 'string') { c.err(command.error); return 1; }
  const script: NewScript = {
    kind: (c.arg('kind') ?? '') as ScriptKind, title: c.arg('title') ?? '', what: c.arg('what') ?? '', why: c.arg('why') ?? '', after: c.arg('after') ?? '', blocks: c.arg('blocks') ?? '',
    ...(c.arg('blocked-by') ? { blockedBy: c.arg('blocked-by') as string } : {}), command,
  };
  if (c.dryRun) { c.out(`script  (dry run)  ${script.title}  nothing written`); return 0; }
  const stream = c.stream();
  const out = registerScript({ store: c.store, vault: c.vault, project: c.project, script, now: c.now(), today: c.today(), askExtras: { ...(stream ? { stream } : {}), ...c.usage() } });
  if (!out.ok) { c.err(`script add: refused, nothing written.\n${out.errors.map((e) => `  - ${e}`).join('\n')}`); return 1; }
  c.out(`script  ${out.entry.id}  ${out.entry.title}${out.created ? '' : '  (already registered)'}`);
  c.out(`      ask ${out.entry.ask} is waiting on the user (${out.entry.kind}); it links to the Scripts tab`);
  return 0;
}

const line = (v: ScriptView): string => `${v.status.padEnd(8)}  ${v.id}  ${v.kind}  ${v.title}  (blocks ${v.blocks}, ask ${v.ask})${v.lastRun ? `  last run ${v.lastRun.at} ${v.lastRun.result}` : ''}`;

function list(c: ScriptCli): number {
  const all = viewsFor(c.store, c);
  const shown = c.has('all') ? all : all.filter((v) => v.status !== 'history');
  if (c.has('json')) c.out(JSON.stringify({ scripts: shown }, null, 2));
  else if (!shown.length) c.out('No scripts are waiting on the user.');
  else shown.forEach((v) => c.out(line(v)));
  return 0;
}

function ran(c: ScriptCli): number {
  const id = c.positional[1];
  const result = (c.arg('result') ?? 'done') as RanResult;
  if (result !== 'done' && result !== 'failed') { c.err('--result must be done or failed.'); return 1; }
  const view = viewsFor(c.store, c).find((v) => v.id === id);
  if (!view) { c.err(`No script ${id ?? ''}. \`journal.ts script list --all\` shows them.`); return 1; }
  const refusal = markRefusal(view);
  if (refusal) { c.err(refusal); return 1; }
  if (c.dryRun) { c.out(`script  (dry run)  ${view.id}  nothing written`); return 0; }
  if (result === 'done' && view.askOpen) c.close(view.ask, `Marked done from the CLI: ${view.title}.`);
  recordRan({ vault: c.vault, project: c.project, id: view.id, result, via: 'cli', now: c.now() });
  c.out(`script  ${view.id}  ${view.title}  ran: ${result}${result === 'done' && view.askOpen ? `  (ask ${view.ask} resolved)` : ''}`);
  return 0;
}

/** Dispatches the subcommand and returns the exit code. */
export function runScript(c: ScriptCli): number {
  const sub = c.positional[0];
  if (sub === 'add') return add(c);
  if (sub === 'list') return list(c);
  if (sub === 'ran') return ran(c);
  c.err(`Usage:\n${SCRIPT_USAGE.map((l) => `  ${l}`).join('\n')}`);
  return sub === undefined ? 2 : 1;
}
