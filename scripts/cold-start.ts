#!/usr/bin/env node
/**
 * cold-start.ts: prints the cold-start page (current work per stream, in-flight agents with their report paths, decisions pending,
 * how-to pointers into the library) from the ledger and the library, and checks it.
 *
 *   cold-start.ts [generate] [--vault <ledger-root>] [--project <name>] [--library <vault-root>] [--max <chars>]
 *   cold-start.ts check --ledger <ledger.jsonl> [--registry <streams.json>] [--library <vault-root>] [--max <chars>]
 *
 * `generate` reads <ledger-root>/Projects/<project>/Journal/ledger.jsonl and the library under Projects/<repo>/Knowledge and
 * Runbooks of --library (default: the configured vault root); it writes nothing. `check` is the cold-start test: no transcript,
 * only the ledger file and the library; it prints the statement and exits 1 when an open in-flight, blocked, queued or ask item is
 * missing from it, the page was cut, or a secret shape is on it. Exit 2 on a usage or read error. Both read-only.
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CONTAINER_PROJECT, LEDGER_ROOT, VAULT_ROOT } from './local-config.ts';
import { parseLedger, readRegistry } from './lib/ledger-core.ts';
import type { RegistryLookup } from './lib/ledger-core.ts';
import { coldStart, coldStartCheck } from './lib/cold-start.ts';
import type { LibraryEntry } from './lib/cold-start.ts';
import { parsePage, text } from './lib/library/page.ts';

const USAGE = 'Usage: cold-start.ts [generate] [--vault <ledger-root>] [--project <name>] [--library <vault-root>] [--max <chars>] | check --ledger <ledger.jsonl> [--registry <streams.json>] [--library <vault-root>] [--max <chars>]';
const FOLDERS = ['Knowledge', 'Runbooks'] as const;

const dirs = (p: string): string[] => (existsSync(p) ? readdirSync(p, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name) : []);
const files = (p: string): string[] => (existsSync(p) ? readdirSync(p, { withFileTypes: true }).filter((e) => e.isFile() && e.name.endsWith('.md')).map((e) => e.name) : []);

/** Every library page under `vault`/Projects/<repo>/(Knowledge|Runbooks), one subfolder deep; a page that cannot be read is skipped. Real files only. */
export function readLibrary(vault: string): LibraryEntry[] {
  const out: LibraryEntry[] = [];
  for (const repo of dirs(join(vault, 'Projects'))) {
    for (const folder of FOLDERS) {
      const base = join(vault, 'Projects', repo, folder);
      for (const sub of ['', ...dirs(base)]) {
        for (const name of files(join(base, sub))) {
          const rel = join('Projects', repo, folder, sub, name);
          try {
            const page = parsePage(rel, readFileSync(join(vault, rel), 'utf8'));
            if (text(page, 'type') !== 'library' || !text(page, 'stream')) continue;
            out.push({ path: rel, kind: text(page, 'kind'), stream: text(page, 'stream'), status: text(page, 'status'), verifiedAt: text(page, 'verified-at') });
          } catch { /* unreadable page: skipped, the page is a pointer list, not a guarantee */ }
        }
      }
    }
  }
  return out;
}

function flag(argv: string[], name: string): string | undefined {
  const k = argv.indexOf(`--${name}`);
  return k >= 0 && argv[k + 1] && !argv[k + 1]!.startsWith('--') ? argv[k + 1] : undefined;
}

export function main(argv: string[], now: Date = new Date()): number {
  const sub = argv[0] && !argv[0].startsWith('--') ? argv[0] : 'generate';
  if (!['generate', 'check'].includes(sub)) { console.error(USAGE); return 2; }
  const maxRaw = flag(argv, 'max');
  const maxChars = maxRaw ? Number(maxRaw) : undefined;
  if (maxRaw && !(Number(maxRaw) > 0)) { console.error(USAGE); return 2; }
  const libRoot = flag(argv, 'library') ?? VAULT_ROOT;
  const library = libRoot ? readLibrary(libRoot) : [];
  try {
    if (sub === 'check') {
      const ledger = flag(argv, 'ledger');
      if (!ledger || !existsSync(ledger)) { console.error(`${USAGE}\nledger file not found`); return 2; }
      const reg = flag(argv, 'registry');
      const registry: RegistryLookup | null = reg ? readRegistry(reg) : null;
      const r = coldStartCheck({ rows: parseLedger(readFileSync(ledger, 'utf8')), registry, library, now, maxChars });
      console.log(r.statement);
      for (const m of r.missing) console.error(`MISSING \`${m.id}\`: ${m.why}`);
      for (const p of r.problems) console.error(`PROBLEM: ${p}`);
      console.error(r.ok ? 'cold-start check: ok' : `cold-start check: FAILED (${r.missing.length} missing, ${r.problems.length} problems)`);
      return r.ok ? 0 : 1;
    }
    const ledgerRoot = flag(argv, 'vault') ?? LEDGER_ROOT;
    const project = flag(argv, 'project') ?? CONTAINER_PROJECT;
    const ledgerPath = join(ledgerRoot, 'Projects', project, 'Journal', 'ledger.jsonl');
    if (!ledgerRoot || !existsSync(ledgerPath)) { console.error(`${USAGE}\nno ledger at ${ledgerPath}`); return 2; }
    const registry = readRegistry(join(ledgerRoot, 'Projects', project, 'streams.json'));
    console.log(coldStart({ rows: parseLedger(readFileSync(ledgerPath, 'utf8')), registry, library, now, maxChars }).text);
    return 0;
  } catch (e) {
    console.error(`cold-start: ${e instanceof Error ? e.message.split('\n')[0] : String(e)}`);
    return 2;
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) process.exit(main(process.argv.slice(2)));
