#!/usr/bin/env node
/**
 * real-state-gate.ts: the cold-start gate for continuous roll (the measure that says "a new session loses nothing"). The other drills
 * run on a fictional fixture; this one runs on a COPY of a real ledger. It copies the project's Journal directory (and, when given,
 * the library and priorities folders of the vault) into a temp dir, computes the truth set from the ledger itself (every open
 * in-flight, blocked, queued and asked item, plus the newest priorities file), runs the SessionStart hook for `startup`, `compact` and
 * `clear` in a temp HOME against the copy, and reports every fact a source lacks by kind and id only. No free text is ever printed.
 * The originals are only read; nothing is written outside the temp dir (and `--emit-context`, a path you name).
 *
 *   real-state-gate.ts [--project <name>] [--journal <dir>] [--vault <vault-root>] [--emit-context <file>]
 *
 * Exit 0 when nothing required is missing, 1 when something is, 2 on a usage or read error. Facts that depend on work not yet merged
 * (recoverable-row fields, the decisions section, the slim CURRENT) are listed as `PENDING` and do not fail the gate until they land.
 * The last line is `gate-result {json}` for the event type and the playbooks.
 */
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CONTAINER_PROJECT, LEDGER_ROOT, VAULT_ROOT } from '../local-config.ts';
import { fold, isOpen, parseLedger, readRegistry } from '../lib/ledger-core.ts';
import type { LedgerRow } from '../lib/ledger-core.ts';
import { dryRunJson } from '../lib/json-out.ts';
import { SOURCES, runHook } from './lib.ts';
import type { Fact, Scratch, Source } from './lib.ts';

export interface GateOptions {
  project: string;
  /** The project's Journal directory (holds ledger.jsonl); read, never written. */
  journalDir: string;
  /** The vault root whose Projects/<project>/{CONTEXT.md,Knowledge,Runbooks,Status} are copied; optional. */
  vault?: string;
  /** Ids of ledger rows to drop from the COPY only, so a test can prove the gate fails when a fact is withheld. The truth set is unaffected. */
  withhold?: string[];
  /** Where to write the startup context, for the agent eval. Contains real text: name a private path. */
  emitContext?: string;
}

export interface GateResult { ok: boolean; checked: number; missing: string[]; pending: string[]; notes: string[] }

/** Vault folders copied for the library and priorities facts. */
const FOLDERS = ['Knowledge', 'Runbooks', 'Status'] as const;
const day = (ts: unknown): string => String(ts ?? '').slice(0, 10);

/** The ground truth, read from the original ledger: ids of every open in-flight, blocked, queued and asked item, as `open-id`/`ask` facts. */
export function truthFacts(rows: LedgerRow[], registry: ReturnType<typeof readRegistry>): Fact[] {
  const f = fold(rows, registry);
  return f.items
    .filter((i) => i.id && isOpen(i) && !f.hidden.has(i.id))
    .map((i): Fact => ({ kind: i.kind === 'question' || i.kind === 'decision' ? 'ask' : 'open-id', id: String(i.id), needle: `\`${i.id}\`` }));
}

/**
 * Facts whose home is an unmerged ticket: the worktree or branch a live row records (recoverable rows) and the decisions of the last two
 * ledger days (a "Decisions recorded" section). They become required when those land and the maintainer moves them into `truthFacts`.
 */
export function pendingFacts(rows: LedgerRow[], registry: ReturnType<typeof readRegistry>): Fact[] {
  const f = fold(rows, registry);
  const days = [...new Set(rows.map((r) => day(r.ts)).filter(Boolean))].sort().slice(-2);
  const live = f.items.filter((i) => i.id && isOpen(i) && !f.hidden.has(i.id));
  const where = live.flatMap((i): Fact[] => ['worktree', 'branch'].flatMap((k) => (typeof i[k] === 'string' && i[k] ? [{ kind: 'how-to' as const, id: `${i.id}.${k}`, needle: String(i[k]) }] : [])));
  const decided = f.items.filter((i) => i.id && i.kind === 'decision' && !i.pending && days.includes(day(i.ts))).map((i): Fact => ({ kind: 'ask', id: `${i.id}.decision`, needle: `\`${i.id}\`` }));
  return [...where, ...decided];
}

const newest = (dir: string): string | null => (existsSync(dir) ? readdirSync(dir).filter((n) => /^\d{4}-\d{2}-\d{2}\.md$/.test(n)).sort().pop() ?? null : null);

/** Builds the copy: ledger root with the Journal (and the registry beside it), plus the chosen vault folders. Returns the scratch and the vault-derived facts. */
function copyState(o: GateOptions): { s: Scratch; vaultFacts: Fact[] } {
  const root = mkdtempSync(join(tmpdir(), 'real-state-gate-'));
  const s: Scratch = { root, ledgerRoot: join(root, 'ledger'), vault: join(root, 'vault'), statusDir: join(root, 'status'), ledgerPath: '', today: '', yesterday: '', project: o.project, facts: [], priorityText: [] };
  const journal = join(s.ledgerRoot, 'Projects', o.project, 'Journal');
  mkdirSync(dirname(journal), { recursive: true });
  mkdirSync(s.statusDir, { recursive: true });
  mkdirSync(join(root, 'home'), { recursive: true });
  cpSync(o.journalDir, journal, { recursive: true });
  const registry = join(dirname(o.journalDir), 'streams.json');
  if (existsSync(registry)) cpSync(registry, join(dirname(journal), 'streams.json'));
  s.ledgerPath = join(journal, 'ledger.jsonl');
  const drop = new Set(o.withhold ?? []);
  if (drop.size && existsSync(s.ledgerPath)) {
    const kept = readFileSync(s.ledgerPath, 'utf8').split('\n').filter((l) => { try { const id = (JSON.parse(l) as LedgerRow).id; return !(typeof id === 'string' && drop.has(id)); } catch { return true; } });
    writeFileSync(s.ledgerPath, kept.join('\n'));
  }
  const vaultFacts: Fact[] = [];
  if (o.vault) {
    const from = join(o.vault, 'Projects', o.project);
    const to = join(s.vault, 'Projects', o.project);
    mkdirSync(to, { recursive: true });
    if (existsSync(join(from, 'CONTEXT.md'))) cpSync(join(from, 'CONTEXT.md'), join(to, 'CONTEXT.md'));
    for (const d of FOLDERS) if (existsSync(join(from, d))) cpSync(join(from, d), join(to, d), { recursive: true });
    const latest = newest(join(from, 'Status', 'priorities'));
    if (latest) vaultFacts.push({ kind: 'priority', id: `priorities-${latest.slice(0, 10)}`, needle: `Projects/${o.project}/Status/priorities/${latest}` });
  }
  return { s, vaultFacts };
}

/** Runs the gate. The temp copy is removed before returning. Throws when the ledger cannot be read. */
export function realStateGate(o: GateOptions): GateResult {
  const ledger = join(o.journalDir, 'ledger.jsonl');
  if (!existsSync(ledger)) throw new Error(`no ledger.jsonl in ${o.journalDir}`);
  const rows = parseLedger(readFileSync(ledger, 'utf8'));
  const registry = readRegistry(join(dirname(o.journalDir), 'streams.json'));
  const { s, vaultFacts } = copyState(o);
  try {
    const required = [...truthFacts(rows, registry), ...vaultFacts];
    const pending = pendingFacts(rows, registry);
    const missing: string[] = [];
    const lacking: string[] = [];
    let startup = '';
    for (const source of SOURCES) {
      const run = runHook(s, source);
      if (run.code !== 0 || !run.out.trim()) { missing.push(`${source}: hook produced no context`); continue; }
      if (source === 'startup') startup = run.out;
      for (const f of required) if (!run.out.includes(f.needle)) missing.push(`${source}: ${f.kind} ${f.id}`);
      for (const f of pending) if (!run.out.includes(f.needle)) lacking.push(`${source}: ${f.kind} ${f.id}`);
    }
    if (o.emitContext && startup) writeFileSync(o.emitContext, `${startup}\n`);
    return { ok: missing.length === 0, checked: required.length * SOURCES.length, missing, pending: lacking, notes: [`${required.length} facts x ${SOURCES.length} sources`] };
  } finally { rmSync(s.root, { recursive: true, force: true }); }
}

function flag(argv: string[], name: string): string | undefined {
  const k = argv.indexOf(`--${name}`);
  return k >= 0 && argv[k + 1] && !argv[k + 1]!.startsWith('--') ? argv[k + 1] : undefined;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const argv = process.argv.slice(2);
  const project = flag(argv, 'project') ?? CONTAINER_PROJECT;
  const journalDir = flag(argv, 'journal') ?? (LEDGER_ROOT ? join(LEDGER_ROOT, 'Projects', project, 'Journal') : '');
  const vault = flag(argv, 'vault') ?? (VAULT_ROOT || undefined);
  try {
    if (!journalDir) throw new Error('usage: real-state-gate.ts [--project <name>] [--journal <dir>] [--vault <vault-root>] [--emit-context <file>] (or set ledger_root)');
    const r = realStateGate({ project, journalDir, vault, emitContext: flag(argv, 'emit-context') });
    console.log(`real-state gate: ${r.ok ? 'ok' : 'FAILED'}`);
    for (const n of r.notes) console.log(`  ${n}`);
    for (const m of r.missing) console.log(`  MISSING ${m}`);
    for (const m of r.pending) console.log(`  PENDING ${m}`);
    console.log(`gate-result ${dryRunJson({ ok: r.ok, checked: r.checked, missing: r.missing.length, pending: r.pending.length })}`);
    process.exit(r.ok ? 0 : 1);
  } catch (e) {
    console.error(`real-state gate: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(2);
  }
}
