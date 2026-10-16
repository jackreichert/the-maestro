/**
 * Registering a script: the entry, its block file, and the run-this ask that puts it in Needs you.
 *
 * The ask is a paste ask (`box: paste`, `paste: <block file>`), which is what gives it the reviewed Run button on its card; a paste ask takes none of the
 * recommend/default/door fields (journal.ts refuses them), because it is a command to run and not a decision. Its row carries `script: <id>`, so the card
 * links to the entry on the Scripts tab, and its text carries the what/why/after so the card explains itself. Registering the same script again while
 * it is still waiting (or a reusable one at any time) returns the existing entry: a producer may run twice without raising a second ask.
 */
import { fold, isOpen } from '../ledger-core.ts';
import type { LedgerRow } from '../ledger-core.ts';
import type { Store } from '../journal/store.ts';
import type { ExtraGuard } from '../run/command-guard.ts';
import { appendEntry, keyOf, newScriptId, readScripts, scriptsPath, validateScript, writeBlock } from './registry.ts';
import type { NewScript, ScriptEntry } from './registry.ts';

export type Registered = { ok: true; created: boolean; entry: ScriptEntry } | { ok: false; errors: string[] };

/** The ask's text: the headline, then the what/why/after as Markdown the card renders. */
export function askText(s: NewScript): string {
  return [`Run this script: ${s.title}`, '', `**What it does:** ${s.what}`, '', `**Why we need it:** ${s.why} (blocks ${s.blocks})`, '', `**After it runs:** ${s.after}`,
    ...(s.blockedBy ? ['', `**Blocked:** ${s.blockedBy}`] : []), '', `This is a ${s.kind} script. Review the command on the Scripts tab, then run it here or run it yourself and mark it done.`].join('\n');
}

export function registerScript(o: { store: Store; vault: string; project: string; script: NewScript; now: Date; today: string; extraGuard?: ExtraGuard; askExtras?: Record<string, unknown> }): Registered {
  const errors = validateScript(o.script, o.extraGuard);
  if (errors.length) return { ok: false, errors };
  const ledger: LedgerRow[] = o.store.readLedger();
  const items = fold(ledger, o.store.loadRegistry()).items;
  const { entries } = readScripts(scriptsPath(o.vault, o.project));
  const same = entries.find((e) => keyOf(e) === keyOf(o.script) && (e.kind === 'reusable' || items.some((i) => i.id === e.ask && isOpen(i))));
  if (same) return { ok: true, created: false, entry: same };
  const id = newScriptId(entries.map((e) => e.id));
  const askId = o.store.newId(ledger);
  // The block file first (the ask names it), then the ask, then the entry: a failure part-way leaves a runnable ask, never an entry with no way to run it.
  const block = writeBlock({ vault: o.vault, project: o.project, id, command: o.script.command });
  o.store.append({ id: askId, ts: o.now.toISOString(), date: o.today, kind: 'question', text: askText(o.script), box: 'paste', paste: block, script: id, ...o.askExtras });
  return { ok: true, created: true, entry: appendEntry({ vault: o.vault, project: o.project, id, script: o.script, ask: askId, now: o.now }) };
}
