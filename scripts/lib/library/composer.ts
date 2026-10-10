/**
 * The composer's view of the ledger. A learned row is composed when a `curated` row closes it, so the closing fold is the cursor and
 * there is no cursor file. The composer's lock is a ledger lease on `library:composer` (lib/journal/leases.ts), so it is held across
 * the many short CLI calls of one pass and lapses on its own if the pass dies. Pure: nothing here reads or writes a file.
 */
import type { LedgerRow } from '../ledger-core.ts';
import { foldLeases, liveLease } from '../journal/leases.ts';
import type { Lease } from '../journal/leases.ts';
import { describeFindings, scanFields } from '../secret-scan.ts';

/** The lease item of the one composer pass that may run at a time. Not an open ledger item, so it never counts in the footer's lease totals. */
export const COMPOSER_ITEM = 'library:composer';
export const REJECT_MAX = 300;

/** Every field a stored `curated` row may carry; `verify` reports any other, since nothing scanned it. */
export const CURATED_ROW_FIELDS: ReadonlySet<string> = new Set([
  'id', 'ts', 'date', 'kind', 'closes', 'text', 'page', 'pageSha', 'rejected', 'window', 'repo', 'stream', 'model', 'used', 'tokens', 'harness', 'agent',
]);

const SHA256 = /^[0-9a-f]{64}$/;
const PAGE_PATH = /^Projects\/[\w.-]+\/(Knowledge|Runbooks)\/[^\0]+\.md$/;

/** The learned rows no `curated` row has closed yet, oldest first. A row closed by anything else is not composed, and `verify` flags that closing row. */
export function pendingLearned(rows: readonly LedgerRow[]): LedgerRow[] {
  const composed = new Set(rows.filter((r) => r.kind === 'curated' && typeof r.closes === 'string').map((r) => r.closes as string));
  return rows.filter((r) => r.kind === 'learned' && typeof r.id === 'string' && !composed.has(r.id));
}

/** The live composer lease at `nowMs`, and the time of the newest lease row on the item (when the last pass began or renewed), whether or not it has lapsed. */
export function composerLease(rows: readonly LedgerRow[], nowMs: number): { live?: Lease; lastPassAt?: string } {
  const live = liveLease(foldLeases(rows), COMPOSER_ITEM, nowMs);
  const last = rows.filter((r) => r.kind === 'lease' && r.leases === COMPOSER_ITEM && typeof r.ts === 'string').map((r) => r.ts as string).sort().pop();
  return { ...(live ? { live } : {}), ...(last !== undefined ? { lastPassAt: last } : {}) };
}

/**
 * Problems with one stored `curated` row, for `verify`: it must close an existing learned row, carry exactly one of `page` (a library page
 * path, with the sha256 of the bytes written) or `rejected` (one plain line), and nothing the write path does not set. Every free-text field
 * is scanned, so a hand-edited row cannot carry a value onto the ledger. A message never echoes a field's value.
 */
export function curatedProblems(row: LedgerRow, learnedIds: ReadonlySet<string>): string[] {
  const out: string[] = [];
  const str = (k: string): string | undefined => (typeof row[k] === 'string' ? (row[k] as string) : undefined);
  if (typeof row.closes !== 'string' || !learnedIds.has(row.closes)) out.push('closes must name a learned row');
  const page = str('page');
  const rejected = str('rejected');
  if ((page === undefined) === (rejected === undefined)) out.push('needs exactly one of page and rejected');
  if (row.page !== undefined && (page === undefined || !PAGE_PATH.test(page) || page.split('/').includes('..'))) out.push('page is not a Projects/<repo>/Knowledge|Runbooks page path');
  if (page !== undefined && !SHA256.test(str('pageSha') ?? '')) out.push('a page row needs pageSha, the sha256 of the bytes written');
  if (rejected !== undefined) {
    if (!rejected.trim()) out.push('rejected is empty');
    if (rejected.length > REJECT_MAX) out.push(`rejected is over ${REJECT_MAX} characters`);
    if (/[\u0000-\u001f\u007f]/.test(rejected)) out.push('rejected must be one plain line');
    if (row.pageSha !== undefined) out.push('a rejected row has no pageSha');
  }
  const extra = Object.keys(row).filter((k) => !CURATED_ROW_FIELDS.has(k));
  if (extra.length) out.push(`${extra.length} field(s) the write path never sets`);
  const fields: Record<string, string | undefined> = {};
  for (const k of ['text', 'page', 'rejected', 'repo', 'stream', 'model', 'used', 'tokens', 'harness', 'agent']) fields[k] = typeof row[k] === 'string' || typeof row[k] === 'number' ? String(row[k]) : undefined;
  const findings = scanFields(fields);
  if (findings.length) out.push(`refused by the scanner (${describeFindings(findings).join('; ')})`);
  return out;
}
