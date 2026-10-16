/**
 * The scripts as the Scripts tab shows them: each entry with where it stands, folded from the registry and the ledger.
 *
 * Nothing here is stored twice. A script is `blocked` while the run-this ask raised for it is open; once that ask closes (the Podium ran it, the user
 * marked it done, the CLI did, anyone dropped it) a one-time script moves to `history` and a reusable one to `reusable`. The last run is the newest of
 * the registry's `ran` rows and the ledger's `run` rows for the script's ask (what the Podium's Run button leaves), so the two paths agree.
 */
import { fold, isOpen } from '../ledger-core.ts';
import type { LedgerRow, Registry } from '../ledger-core.ts';
import { readFileSync } from 'node:fs';
import { blockPath, MAX_COMMAND, readScripts, scriptsPath } from './registry.ts';
import type { ScriptEntry } from './registry.ts';

export type ScriptStatus = 'blocked' | 'reusable' | 'history';
export interface LastRun { at: string; result: 'done' | 'failed' | 'killed' | 'timeout'; via: 'podium' | 'marked' | 'cli' }
export interface ScriptView extends ScriptEntry { status: ScriptStatus; lastRun?: LastRun; runs: number; askOpen: boolean }

/**
 * The command the page shows: the block file's text, which is the only copy the Run button executes, so what is reviewed is what runs. Falls back to the
 * registry row when the file is gone or oversized (the entry is then still readable, and a run would be refused).
 */
function shownCommand(o: { vault: string; project: string }, e: ScriptEntry): string {
  try {
    const text = readFileSync(blockPath(o.vault, o.project, e.id), 'utf8');
    return text.length <= MAX_COMMAND + 1 ? text.replace(/\n$/, '') : e.command;
  } catch { return e.command; }
}

const RESULTS = ['done', 'failed', 'killed', 'timeout'];

/** Every run of this ask: the Podium's `run` rows and the registry's `ran` rows, oldest first. */
function runsOf(e: ScriptEntry, rows: LedgerRow[], ran: ReturnType<typeof readScripts>['ran']): LastRun[] {
  const podium = rows.filter((r) => r.kind === 'run' && r.runSource === 'ask' && r.runTarget === e.ask && typeof r.ts === 'string' && RESULTS.includes(String(r.status)))
    .map((r): LastRun => ({ at: String(r.ts), result: r.status as LastRun['result'], via: 'podium' }));
  const marked = ran.filter((r) => r.id === e.id).map((r): LastRun => ({ at: r.at, result: r.result, via: r.via === 'podium' ? 'marked' : 'cli' }));
  return [...podium, ...marked].sort((a, b) => a.at.localeCompare(b.at));
}

/** The registry file folded with the ledger rows. Blocked first (oldest first: the longest wait), then reusable, then history (newest first). */
export function buildScriptViews(o: { vault: string; project: string; ledger: LedgerRow[]; registry: Registry | null }): ScriptView[] {
  const { entries, ran } = readScripts(scriptsPath(o.vault, o.project));
  const items = fold(o.ledger, o.registry).items;
  const views = entries.map((e): ScriptView => {
    const ask = items.find((i) => i.id === e.ask);
    // The ask must be the one registration raised for this entry (its row names the script and its block file); a hand-edited entry cannot point at another ask.
    const askOpen = ask !== undefined && isOpen(ask) && ask.script === e.id && ask.paste === blockPath(o.vault, o.project, e.id);
    const runs = runsOf(e, o.ledger, ran);
    const last = runs.at(-1);
    const status: ScriptStatus = askOpen ? 'blocked' : e.kind === 'reusable' ? 'reusable' : 'history';
    return { ...e, command: shownCommand(o, e), status, askOpen, runs: runs.length, ...(last ? { lastRun: last } : {}) };
  });
  const rank: Record<ScriptStatus, number> = { blocked: 0, reusable: 1, history: 2 };
  const when = (v: ScriptView): string => v.lastRun?.at ?? v.createdAt;
  return views.sort((a, b) => rank[a.status] - rank[b.status] || (a.status === 'blocked' ? a.createdAt.localeCompare(b.createdAt) : a.status === 'reusable' ? a.title.localeCompare(b.title) : when(b).localeCompare(when(a))));
}

/** Why a script cannot be marked run now, or null. A one-time script that already ran (or whose ask was closed) is finished; a reusable one is marked as often as it is run. */
export const markRefusal = (v: ScriptView): string | null => (v.status === 'history' ? 'That one-time script is already finished. It is kept in History.' : null);

/** The views for one store: the registry file folded with the store's ledger and registry. */
export const viewsFor = (store: { readLedger(): LedgerRow[]; loadRegistry(): Registry | null }, o: { vault: string; project: string }): ScriptView[] => buildScriptViews({ ...o, ledger: store.readLedger(), registry: store.loadRegistry() });
