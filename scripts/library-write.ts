#!/usr/bin/env node
/**
 * LIBRARY WRITE: the only way a composer pass writes a library page or closes a learned row.
 *
 *   library-write.ts begin                                       take the composer lock (a ledger lease), print the holder id
 *   library-write.ts write <page> --from <staged> [--accept-hand-edit] --holder <id>  replace one page after every check passes
 *   library-write.ts curate <learned id> (--page <page> [--refresh] [--accept-hand-edit] | --reject "<why>") --holder <id> --model M --used a,b
 *   library-write.ts retros [--json]                             list the agent retros waiting for the composer (read-only, no lock): each lesson with its source
 *   library-write.ts seed --holder <id>                          one time: record the sha of pages composed before the write record existed
 *   library-write.ts end --holder <id>                           free the lock
 *
 * <page> is vault-relative: Projects/<repo>/(Knowledge|Runbooks)/<name>.md. Options: --vault <root> (pages), --ledger-root <root>,
 * --project <ledger project> (defaults come from the local config), --tokens N, --allow-unmarked (tests).
 * `curate --page` (first close or --refresh) refuses (exit 1) unless the page on disk is what the last `write` left; `--accept-hand-edit` overrides that on purpose.
 * An identical-bytes `write` is recorded only when the record already matches the disk; `write --accept-hand-edit` records the disk as it is.
 * Exit 0 done; 1 a check refused the work (nothing written); 2 usage; 3 the lock is not this pass's (held by another, lapsed, wrong holder).
 * See lib/library/write.ts for what the checks are and lib/library/composer.ts for the lock.
 */
import { realpathSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CONFIGURED_PROJECT, LEDGER_ROOT, VAULT_ROOT } from './local-config.ts';
import { openStore } from './lib/journal/store.ts';
import { pendingRetroLessons } from './lib/library/composer.ts';
import { withholdJson } from './lib/json-out.ts';
import { begin, curate, seedLastWrites, end, fileLastWrites, writePage } from './lib/library/write.ts';
import type { Marks, Outcome, WriteEnv } from './lib/library/write.ts';

const USAGE = 'Usage: library-write.ts begin | write <page> --from <staged> [--accept-hand-edit] --holder <id> | curate <learned id> (--page <page> [--refresh] [--accept-hand-edit] | --reject "<why>") --holder <id> --model <m> --used <a,b> | retros [--json] | seed --holder <id> | end --holder <id>   [--vault <root>] [--ledger-root <root>] [--project <name>]';

interface Args { cmd: string; positional: string[]; flags: Map<string, string> }

const VALUE_FLAGS = new Set(['vault', 'ledger-root', 'project', 'holder', 'from', 'page', 'reject', 'model', 'used', 'tokens']);
const BOOL_FLAGS = new Set(['json', 'allow-unmarked', 'refresh', 'accept-hand-edit']);

export function parseArgs(argv: string[]): Args | string {
  const [cmd, ...rest] = argv;
  if (!cmd || !['begin', 'write', 'curate', 'end', 'seed', 'retros'].includes(cmd)) return 'first argument must be begin, write, curate, end, seed or retros';
  const flags = new Map<string, string>();
  const positional: string[] = [];
  for (let i = 0; i < rest.length; i += 1) {
    const a = rest[i] as string;
    if (!a.startsWith('--')) { positional.push(a); continue; }
    const name = a.slice(2);
    if (BOOL_FLAGS.has(name)) flags.set(name, 'true');
    else if (VALUE_FLAGS.has(name)) {
      const v = rest[i + 1];
      if (v === undefined) return `--${name} needs a value`;
      flags.set(name, v);
      i += 1;
    } else return `unknown argument ${a}`;
  }
  return { cmd, positional, flags };
}

function marks(flags: Map<string, string>): Marks | string {
  const model = flags.get('model')?.trim();
  const used = flags.get('used')?.split(',').map((s) => s.trim()).filter(Boolean);
  if (!flags.has('allow-unmarked') && (!model || !used?.length)) return 'every ledger row needs --model "<name>" and --used "skill:x,tool:y" (unknown is --model unrecorded --used unrecorded)';
  return { ...(model ? { model } : {}), ...(used?.length ? { used } : {}), ...(flags.get('tokens') ? { tokens: flags.get('tokens') as string } : {}) };
}

/** Runs one subcommand and returns the exit code; `out` and `err` receive its lines (the CLI passes the console). */
export function run(argv: string[], io: { out: (s: string) => void; err: (s: string) => void } = { out: console.log, err: console.error }, defaults = { vault: VAULT_ROOT, ledgerRoot: LEDGER_ROOT || VAULT_ROOT, project: CONFIGURED_PROJECT }): number {
  const a = parseArgs(argv);
  if (typeof a === 'string') { io.err(`library-write: ${a}\n${USAGE}`); return 2; }
  const vault = a.flags.get('vault') ?? defaults.vault;
  const ledgerRoot = a.flags.get('ledger-root') ?? (a.flags.has('vault') ? vault : defaults.ledgerRoot);
  const project = a.flags.get('project') ?? defaults.project;
  if (!vault || !ledgerRoot || !project) { io.err('library-write: set the vault and ledger roots and the project (local config), or pass --vault, --ledger-root and --project'); return 2; }
  const store = openStore({ vault: ledgerRoot, project, dryRun: false });
  const env: WriteEnv = { vault, readLedger: store.readLedger, append: store.append, newId: store.newId, now: () => new Date().toISOString(), lastWrites: fileLastWrites(join(store.dir, 'library-writes.json')) };
  const holder = a.flags.get('holder');
  const finish = <T>(res: Outcome<T>, ok: (r: T) => string): number => {
    if (res.ok) { io.out(ok(res)); return 0; }
    res.messages.forEach((m) => io.err(`library-write: ${m}`));
    return res.code;
  };
  store.ensureDir();
  switch (a.cmd) {
    case 'begin': return finish(begin(env), (r) => `holder ${r.holder} (lock until ${r.until.slice(11, 16)}Z)`);
    case 'retros': {
      const waiting = pendingRetroLessons(store.readLedger());
      if (a.flags.has('json')) { io.out(JSON.stringify(withholdJson(waiting), null, 2)); return 0; }
      io.out(`${waiting.length} retro${waiting.length === 1 ? '' : 's'} waiting for the composer`);
      for (const r of waiting) {
        io.out(`  ${r.id}  ${r.date}  item ${r.item}`);
        r.lessons.forEach((l) => io.out(`      [${l.source}] ${l.text}`));
      }
      return 0;
    }
    case 'seed': return finish(seedLastWrites(env, holder), (r) => `seeded ${r.seeded.length} page(s)${r.skipped.length ? `; left unrecorded (disk differs from the latest curated sha, or the page is gone): ${r.skipped.join(', ')}` : ''}`);
    case 'end': return holder ? finish(end(env, holder), (r) => (r.freed ? 'composer lock freed' : 'no live composer lock (already ended)')) : (io.err('library-write: end needs --holder'), 2);
    case 'write': {
      const [page, extra] = a.positional;
      const from = a.flags.get('from');
      if (!page || extra !== undefined || !from) { io.err(`library-write: write needs one <page> and --from <staged>\n${USAGE}`); return 2; }
      return finish(writePage(env, holder, page, from, a.flags.has('accept-hand-edit') ? { acceptHandEdit: true } : {}), (r) => `${r.changed ? 'wrote' : 'unchanged'} ${page} (sha256 ${r.sha.slice(0, 12)})`);
    }
    default: {
      const [id, extra] = a.positional;
      if (!id || extra !== undefined) { io.err(`library-write: curate needs one <learned id>\n${USAGE}`); return 2; }
      const m = marks(a.flags);
      if (typeof m === 'string') { io.err(`library-write: ${m}`); return 2; }
      const page = a.flags.get('page');
      const reject = a.flags.get('reject');
      return finish(curate(env, holder, id, { ...(page !== undefined ? { page } : {}), ...(reject !== undefined ? { reject } : {}), ...(a.flags.has('refresh') ? { refresh: true } : {}), ...(a.flags.has('accept-hand-edit') ? { acceptHandEdit: true } : {}) }, m), (r) => `${a.flags.has('refresh') ? 'refreshed' : 'curated'} ${id} (row ${r.id})`);
    }
  }
}

const isMain = (): boolean => { try { return realpathSync(process.argv[1] as string) === fileURLToPath(import.meta.url); } catch { return false; } };
if (process.argv[1] && isMain()) process.exitCode = run(process.argv.slice(2));
