import { readFileSync } from 'node:fs';
import { CONFIGURED_PROJECT, LEDGER_ROOT, VAULT_ROOT } from '../local-config.ts';
import { join } from 'node:path';
import { saveBrief } from '../lib/journal/brief-link.ts';
import { openStore } from '../lib/journal/store.ts';
import type { LedgerRow } from '../lib/ledger-core.ts';
import { resolveWindowId, windowEnv } from '../lib/window-id.ts';

/**
 * What the small ledger hooks (agent dispatch, agent return, session-end requeue) share: the ledger read and append that go
 * straight to the store, not through a spawned journal.ts (a spawn alone costs more than the 300 ms these hooks get), the window
 * id, and the fail-open wrapper. A hook that blocks or errors would stall the session, so a failure goes to stderr and the exit
 * code stays 0.
 */
export const HOOK_MARKS = { model: 'n/a', used: ['hook:ledger'], tokens: 'n/a' } as const;

export interface HookLedger {
  readLedger: () => LedgerRow[];
  /** Appends rows in order; each already has its id. */
  append: (rows: LedgerRow[]) => void;
  now: () => number;
  /** A fresh row id not in `existing`. */
  newId: (existing: { id?: string }[]) => string;
  /** Saves a dispatch prompt as a brief file and returns its path; null when it cannot be saved (a secret in it, no folder). Absent: no brief is kept. */
  saveBrief?: (text: string, title: string, id: string, day: string) => string | null;
}

const flag = (argv: string[], name: string): string => { const k = argv.indexOf(`--${name}`); return k >= 0 ? argv[k + 1] ?? '' : ''; };

export function realLedger(argv: string[]): HookLedger {
  const store = openStore({ vault: flag(argv, 'vault') || LEDGER_ROOT || VAULT_ROOT, project: flag(argv, 'project') || CONFIGURED_PROJECT, dryRun: false, warn: () => {} });
  return { readLedger: () => store.readLedger(), append: (rows) => { store.appendMany(rows); }, now: () => Date.now(), newId: (existing) => store.newId(existing),
    saveBrief: (text, title, id, day) => { try { return saveBrief(join(store.dir, 'Briefs'), text, { day, title, id }); } catch { return null; } } };
}

/** An id source that never repeats one already in `rows` or handed out before. */
export function idSource(rows: readonly LedgerRow[], pick: (existing: { id?: string }[]) => string): () => string {
  const taken: { id?: string }[] = [...rows];
  return () => { const id = pick(taken); taken.push({ id }); return id; };
}

/** The window id for a hook run: the session id the hook is given, else the environment, as `precompact.ts` resolves it. */
export const hookWindow = (sessionId: string | undefined): string => resolveWindowId({ session: sessionId, ...windowEnv() });

/** The hook's JSON stdin as an object; `{}` when it is empty or not JSON. */
export function readInput(): Record<string, unknown> {
  try { const v: unknown = JSON.parse(readFileSync(0, 'utf8') || '{}'); return v && typeof v === 'object' ? (v as Record<string, unknown>) : {}; } catch { return {}; }
}

/** Runs `body`; any throw is reported on stderr and swallowed, so the caller can exit 0. */
export function failOpen(name: string, body: () => void): void {
  try { body(); } catch (e) { console.error(`${name} hook: ${e instanceof Error ? e.message : String(e)}`); }
}
