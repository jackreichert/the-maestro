/**
 * Shared pieces of the continuous-roll drills (epic R7): a fictional ledger and vault fixture copied into a temp dir, the ledger
 * reduction the cold-start test needs, the SessionStart hook run as a subprocess, and the ground-truth facts the drills look for.
 * Model-free and read-only against everything outside the temp dir: no real ledger, vault or settings file is ever opened.
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { LedgerRow } from '../lib/ledger-core.ts';

const HOOK = join(dirname(fileURLToPath(import.meta.url)), '..', 'hooks', 'session-start-compact.ts');
export const PROJECT = 'shire';
export const SOURCES = ['startup', 'compact', 'clear'] as const;
export type Source = (typeof SOURCES)[number];

/** A fact the next session must be able to read: what kind it is, the text to look for, and where the session should have got it from. */
export interface Fact { kind: 'priority' | 'open-id' | 'ask' | 'how-to'; id: string; needle: string }

/** What a drill reports: the facts it looked for that the context did not carry, as `kind id` labels. Empty means the drill passed. */
export interface DrillResult { name: string; ok: boolean; missing: string[]; notes: string[] }

export interface Scratch {
  /** Temp root holding everything below; the caller removes it. */
  root: string;
  ledgerRoot: string;
  vault: string;
  statusDir: string;
  ledgerPath: string;
  today: string;
  yesterday: string;
  /** The project whose ledger the hook reads; the fictional one when unset. */
  project?: string;
  facts: Fact[];
  /** Yesterday's priority lines, as written to the project file. The cold-start page points at the file and counts them; it does not print them. */
  priorityText: Fact[];
}

const day = (d: Date): string => d.toISOString().slice(0, 10);
const jsonl = (rows: LedgerRow[]): string => `${rows.map((r) => JSON.stringify(r)).join('\n')}\n`;

/** The fictional ledger: live rows (two streams, a brief, a blocked and a queued item, an ask) buried in finished work and old notes. */
export function fixtureRows(today: string, yesterday: string): LedgerRow[] {
  const at = (date: string, t = '12:00:00'): { ts: string; date: string } => ({ ts: `${date}T${t}.000Z`, date });
  const old = '2026-09-01';
  return [
    { ...at(old), id: 'old1', kind: 'wip', stream: 'Rivendell', text: 'chart the eastern road' },
    { ...at(old), id: 'old2', kind: 'done', closes: 'old1', stream: 'Rivendell', text: 'eastern road charted' },
    { ...at(old), id: 'old3', kind: 'note', stream: 'Rivendell', text: 'free text note from a long-finished week' },
    { ...at(yesterday), id: 'wip1', kind: 'wip', stream: 'Rivendell', text: 'forge the council ledger', model: 'sonnet' },
    { ...at(yesterday), id: 'brf1', kind: 'brief', briefs: 'wip1', brief: 'scratch/briefs/brief-wip1.md', report: 'scratch/briefs/report-wip1.md' },
    { ...at(yesterday), id: 'wip2', kind: 'wip', stream: 'Rivendell', text: 'review the council ledger', queued: true },
    { ...at(yesterday), id: 'blk1', kind: 'blocked', stream: 'Rivendell', text: 'waiting on the ranger reply', gate: `date:${today}` },
    { ...at(yesterday), id: 'wip3', kind: 'wip', stream: 'Lothlorien', text: 'rotate the mirror keys' },
    { ...at(yesterday), id: 'ask1', kind: 'question', stream: 'Lothlorien', text: 'which gate opens first?', door: 'two-way', recommend: 'the northern gate' },
    { ...at(yesterday), id: 'note1', kind: 'note', stream: 'Rivendell', text: 'step 2 of 3 done, next: wire the beacon' },
  ];
}

/** The pointer index plus live rows: every row of a live item (open, blocked, queued, asked) and the brief rows that point at them. Finished work and notes go. */
export function reduceLedger(rows: LedgerRow[]): LedgerRow[] {
  const closed = new Set(rows.flatMap((r) => (typeof r.closes === 'string' ? [r.closes] : [])));
  const live = new Set(rows.filter((r) => ['wip', 'blocked', 'question'].includes(r.kind ?? '') && !closed.has(String(r.id))).map((r) => String(r.id)));
  return rows.filter((r) => live.has(String(r.id)) || (r.kind === 'brief' && live.has(String(r.briefs))));
}

const PAGE = (stream: string, kind: string, day0: string): string =>
  `---\ntype: library\nkind: ${kind}\nstream: ${stream}\nstatus: current\nverified-at: ${day0}\n---\n\n# ${stream} ${kind}\n\nHow this stream is worked.\n`;

/** Builds the scratch ledger root, vault and status dir under a fresh temp dir. `reduce` applies the cold-start reduction to the ledger. */
export function buildScratch(opts: { now?: Date; reduce?: boolean } = {}): Scratch {
  const now = opts.now ?? new Date();
  const today = day(now);
  const yesterday = day(new Date(now.getTime() - 86_400_000));
  const root = mkdtempSync(join(tmpdir(), 'roll-drill-'));
  const ledgerRoot = join(root, 'ledger');
  const vault = join(root, 'vault');
  const statusDir = join(root, 'status');
  const journal = join(ledgerRoot, 'Projects', PROJECT, 'Journal');
  const prio = join(vault, 'Projects', PROJECT, 'Status', 'priorities');
  const write = (path: string, text: string): void => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, text); };
  const rows = fixtureRows(today, yesterday);
  const ledgerPath = join(journal, 'ledger.jsonl');
  write(ledgerPath, jsonl(opts.reduce ? reduceLedger(rows) : rows));
  write(join(vault, 'Projects', PROJECT, 'CONTEXT.md'), '# Shire\n\n## Now\n\n- Council ledger forged; beacon wiring is next.\n\n## Next\n\n- Open the northern gate.\n');
  write(join(prio, `${yesterday}.md`), `---\ntype: priorities\nproject: ${PROJECT}\ndate: ${yesterday}\ncarried-from: none\nwritten-by: priorities set\n---\n\n## Today\n- Forge the council ledger | Rivendell\n- Rotate the mirror keys | Lothlorien\n`);
  write(join(vault, 'Projects', PROJECT, 'Runbooks', 'rivendell-ops.md'), PAGE('Rivendell', 'runbook', yesterday));
  write(join(vault, 'Projects', PROJECT, 'Knowledge', 'lothlorien-keys.md'), PAGE('Lothlorien', 'how-to', yesterday));
  mkdirSync(statusDir, { recursive: true });
  const facts: Fact[] = [
    { kind: 'priority', id: `carry-file-${yesterday}`, needle: `Projects/${PROJECT}/Status/priorities/${yesterday}.md` },
    { kind: 'priority', id: 'carry-count', needle: '2 today' },
    ...['wip1', 'wip2', 'blk1', 'wip3'].map((id): Fact => ({ kind: 'open-id', id, needle: `\`${id}\`` })),
    { kind: 'ask', id: 'ask1', needle: '`ask1`' },
    { kind: 'ask', id: 'ask1-text', needle: 'which gate opens first?' },
    { kind: 'how-to', id: 'rivendell-ops', needle: 'rivendell-ops.md' },
    { kind: 'how-to', id: 'lothlorien-keys', needle: 'lothlorien-keys.md' },
  ];
  const priorityText: Fact[] = [
    { kind: 'priority', id: 'prio-text-1', needle: 'Forge the council ledger' },
    { kind: 'priority', id: 'prio-text-2', needle: 'Rotate the mirror keys' },
  ];
  return { root, ledgerRoot, vault, statusDir, ledgerPath, today, yesterday, facts, priorityText };
}

/** Runs the SessionStart hook as the harness does (JSON with `source` on stdin) against the scratch state, and returns what it printed. */
export function runHook(s: Scratch, source: Source): { code: number | null; out: string; err: string } {
  const project = s.project ?? PROJECT;
  const r = spawnSync(process.execPath, [HOOK, '--vault', s.ledgerRoot, '--project', project], {
    input: JSON.stringify({ source }), encoding: 'utf8', timeout: 90_000,
    env: {
      ...process.env,
      MAESTRO_LOCAL_CONFIG: '', MAESTRO_OVERLAY: '', MAESTRO_PROJECT: project, HOME: join(s.root, 'home'), MAESTRO_NOTIFY_COMMAND: '/usr/bin/true', VAULT_ROOT: s.vault, LEDGER_ROOT: s.ledgerRoot, MAESTRO_STATUS_DIR: s.statusDir,
      MAESTRO_WATCH_TZ: 'UTC', MAESTRO_UPDATE_CHECK: 'off', MAESTRO_CLAUDE_SETTINGS: join(s.root, 'no-settings.json'), MAESTRO_EVENT_DIR: join(s.root, 'events'),
      MAESTRO_CONTAINER_ROOT: '', MAESTRO_PROJECTS_DIR: join(s.root, 'claude-projects'), MAESTRO_WINDOW: 'drill', CLAUDE_AUTOCOMPACT_PCT_OVERRIDE: '20', CLAUDE_CODE_AUTO_COMPACT_WINDOW: '1000000',
    },
  });
  return { code: r.status, out: r.stdout, err: r.stderr };
}

/** The facts whose needle is on the page. */
export const present = (facts: Fact[], context: string): Fact[] => facts.filter((f) => context.includes(f.needle));

/** The facts missing from the page, as `kind id` labels for a report line. */
export const missing = (facts: Fact[], context: string): string[] => facts.filter((f) => !context.includes(f.needle)).map((f) => `${f.kind} ${f.id}`);

/** The 4-character ids a context names in backticks (the cold-start page's form), sorted and de-duplicated. */
export const backtickedIds = (context: string): string[] => [...new Set([...context.matchAll(/`([a-z]{3}\d)`/g)].map((m) => m[1] as string))].sort();
