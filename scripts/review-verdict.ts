#!/usr/bin/env node
/**
 * REVIEW VERDICT: the ledger of fresh-agent re-reviews (reference/prs.md, "Re-review before ready").
 * An agent that fixes review-bot threads must not be the one that judges its own fix. A second, read-only
 * reviewer re-reviews the fix commits and the stack seams, runs the tests, and records SHIP IT or NEEDS WORK
 * here for the exact head commit. prs-snapshot.ts --ready then holds any PR with resolved bot threads until
 * a SHIP IT is recorded for its current head.
 *
 *   node scripts/review-verdict.ts record --pr <owner/repo#N> --head <sha> --verdict "SHIP IT"|"NEEDS WORK" --reviewer <id> --fixer <id> [--vault <ledger root>]
 *   node scripts/review-verdict.ts show   --pr <owner/repo#N> [--vault <ledger root>]
 *
 * Rows are appended to <ledger root>/Projects/<project>/Journal/verdicts.jsonl. A reviewer whose id equals the fixer's
 * is refused: the one-writer-one-reviewer rule is a check, not a request. Exit 0 ok, 1 refused, 2 usage.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CONTAINER_PROJECT, LEDGER_ROOT, VAULT_ROOT } from './local-config.ts';

export type Verdict = 'SHIP IT' | 'NEEDS WORK';
/** One recorded re-review. `head` is the commit sha reviewed; `fixer` the agent that pushed the fixes. */
export interface VerdictRow { pr: string; head: string; verdict: Verdict; reviewer: string; fixer: string; at: string }

export const verdictsPath = (root: string): string => join(root, 'Projects', CONTAINER_PROJECT, 'Journal', 'verdicts.jsonl');

const normalize = (raw: string): Verdict | null => {
  const v = raw.trim().toUpperCase().replace(/[-_\s]+/g, ' ');
  return v === 'SHIP IT' ? 'SHIP IT' : v === 'NEEDS WORK' ? 'NEEDS WORK' : null;
};

/** Validate and append one verdict. Throws with the reason when the row is refused; nothing is written then. */
export function recordVerdict(root: string, row: Omit<VerdictRow, 'at' | 'verdict'> & { verdict: string }, now = new Date()): VerdictRow {
  const verdict = normalize(row.verdict);
  if (!verdict) throw new Error('--verdict must be "SHIP IT" or "NEEDS WORK"');
  if (!/^[^/\s]+\/[^#\s]+#\d+$/.test(row.pr)) throw new Error('--pr must look like owner/repo#123');
  if (!/^[0-9a-f]{7,40}$/i.test(row.head)) throw new Error('--head must be a commit sha (7 to 40 hex characters)');
  const reviewer = row.reviewer.trim();
  const fixer = row.fixer.trim();
  if (!reviewer || !fixer) throw new Error('--reviewer and --fixer are both required');
  if (reviewer.toLowerCase() === fixer.toLowerCase()) throw new Error(`the reviewer (${reviewer}) is the agent that wrote the fix; a fresh agent must re-review it`);
  const out: VerdictRow = { pr: row.pr, head: row.head.toLowerCase(), verdict, reviewer, fixer, at: now.toISOString() };
  const path = verdictsPath(root);
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, `${JSON.stringify(out)}\n`);
  return out;
}

/** Every well-formed row; a missing file is empty and a damaged line is skipped, so damage can only remove a SHIP IT, never add one. */
export function loadVerdicts(root: string): VerdictRow[] {
  const path = verdictsPath(root);
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8').split('\n').flatMap((l) => {
    try {
      const r = JSON.parse(l) as VerdictRow;
      return r && normalize(String(r.verdict)) && typeof r.pr === 'string' && /^[0-9a-f]{7,40}$/i.test(String(r.head)) ? [r] : [];
    } catch { return []; }
  });
}

/** The latest verdict recorded for this PR at this head commit (a sha prefix of at least 7 characters matches), or undefined. */
export function verdictFor(rows: VerdictRow[], pr: string, head: string | undefined): VerdictRow | undefined {
  if (!head || head.length < 7) return undefined;
  const h = head.toLowerCase();
  return rows.filter((r) => r.pr === pr && (h.startsWith(r.head) || r.head.startsWith(h))).at(-1);
}

function main(argv: string[]): number {
  const [cmd, ...rest] = argv;
  const arg = (f: string): string => { const i = rest.indexOf(f); return i >= 0 ? (rest[i + 1] ?? '') : ''; };
  const root = arg('--vault') || LEDGER_ROOT || VAULT_ROOT;
  if ((cmd !== 'record' && cmd !== 'show') || !arg('--pr') || !root) {
    console.error('usage: node scripts/review-verdict.ts record|show --pr <owner/repo#N> [--head <sha> --verdict "SHIP IT"|"NEEDS WORK" --reviewer <id> --fixer <id>] [--vault <ledger root>]');
    return 2;
  }
  try {
    if (cmd === 'record') {
      const r = recordVerdict(root, { pr: arg('--pr'), head: arg('--head'), verdict: arg('--verdict'), reviewer: arg('--reviewer'), fixer: arg('--fixer') });
      console.log(`${r.pr} ${r.head.slice(0, 7)} ${r.verdict} (reviewer ${r.reviewer})`);
      return 0;
    }
    const rows = loadVerdicts(root).filter((r) => r.pr === arg('--pr'));
    rows.forEach((r) => console.log(`${r.at} ${r.head.slice(0, 7)} ${r.verdict} reviewer=${r.reviewer} fixer=${r.fixer}`));
    return rows.length ? 0 : 1;
  } catch (e) { console.error(`review-verdict: ${(e as Error).message}`); return 1; }
}

const isMain = () => { try { return realpathSync(process.argv[1]) === fileURLToPath(import.meta.url); } catch { return false; } };

if (process.argv[1] && isMain()) process.exit(main(process.argv.slice(2)));
