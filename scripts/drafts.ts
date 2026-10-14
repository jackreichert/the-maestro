#!/usr/bin/env node
/**
 * drafts.ts: put a drafted GitHub comment in the approval queue, or list the queue.
 *
 *   drafts.ts add [--vault <ledger root>] [--project <name>] < draft.json     one NewDraft as JSON on stdin (lib/drafts/queue.ts)
 *   drafts.ts list [--vault ...] [--project ...]                               the open drafts, one line each
 *
 * There is no approve, edit or reject here, and no state can be passed to `add`: a draft always starts pending, and only the Podium's
 * Approve button posts it. Adding the same `key` again is a no-op, so a producer may run twice.
 */
import { readFileSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { CONFIGURED_PROJECT, CONTAINER_PROJECT, LEDGER_ROOT, VAULT_ROOT } from './local-config.ts';
import { addDraft, draftsPath, listDrafts } from './lib/drafts/queue.ts';
import type { NewDraft } from './lib/drafts/queue.ts';

const USAGE = 'Usage: drafts.ts add|list [--vault <ledger root>] [--project <name>]   (add reads one draft as JSON on stdin)';

function main(argv: string[]): number {
  const { values: v, positionals } = parseArgs({ args: argv, allowPositionals: true, options: { vault: { type: 'string' }, project: { type: 'string' }, help: { type: 'boolean', short: 'h' } } });
  const [cmd] = positionals;
  if (v.help || (cmd !== 'add' && cmd !== 'list')) { console.log(USAGE); return v.help ? 0 : 2; }
  const vault = v.vault || LEDGER_ROOT || VAULT_ROOT;
  if (!vault) { console.error('Ledger root is not set. Set ledger_root or pass --vault <path>.'); return 2; }
  const file = draftsPath(vault, v.project || CONFIGURED_PROJECT || CONTAINER_PROJECT);
  if (cmd === 'list') {
    for (const d of listDrafts(file).filter((x) => x.state !== 'posted' && x.state !== 'rejected')) console.log(`${d.id} ${d.state} ${d.severity} ${d.repo}#${d.pr}`);
    return 0;
  }
  const raw: unknown = JSON.parse(readFileSync(0, 'utf8'));
  if (typeof raw !== 'object' || raw === null) { console.error('stdin must be one JSON object'); return 2; }
  const { key, source, repo, pr, severity, text, target, context, replyTo } = raw as NewDraft;
  const out = addDraft(file, { key, source, repo, pr, severity, text, target, ...(context ? { context } : {}), ...(replyTo ? { replyTo } : {}) });
  console.log(`${out.created ? 'queued' : 'already queued'} ${out.id}`);
  return 0;
}

const isMain = (): boolean => { try { return realpathSync(process.argv[1] ?? '') === fileURLToPath(import.meta.url); } catch { return false; } };
if (isMain()) {
  try { process.exitCode = main(process.argv.slice(2)); } catch (e) { console.error(`drafts: ${(e instanceof Error ? e.message : String(e)).split('\n')[0]}`); process.exitCode = 1; }
}
