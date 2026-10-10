/**
 * The only write path to library pages. A composer pass `begin`s (a ledger lease on `library:composer`, see composer.ts), then each
 * `write` replaces one page after the staged text passes every check, and each `curate` closes one learned row with a `curated` row.
 * The checks run here, at the write, not in a doc: the page is refused unless library-check's nine rules, the shared secret and PHI
 * scanner (which checkPage does not run), and the comment-split check (`safeLine`) all pass. Nothing here prints a matched value.
 */
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, sep } from 'node:path';
import { checkTexts } from '../../library-check.ts';
import { acquireLease, describeLease, foldLeases, liveLease, releaseLease } from '../journal/leases.ts';
import type { LeaseContext } from '../journal/leases.ts';
import type { LedgerRow } from '../ledger-core.ts';
import { describeFindings, scanFields, scanText as scanShared } from '../secret-scan.ts';
import { COMPOSER, MAX_LINES } from './rules.ts';
import { MAX_LINE, scanText as scanPage } from './scan.ts';
import { COMPOSER_ITEM, REJECT_MAX, curatedProblems, pendingLearned } from './composer.ts';
import { WITHHELD, safeLine } from './safe-text.ts';

/** How long a pass holds the lock without writing a row; any row it writes renews it. */
export const COMPOSER_TTL_MINUTES = 30;
const PAGE_PATH = /^Projects\/[\w.-]+\/(Knowledge|Runbooks)\/.+\.md$/;
const STAGED_MAX = 256 * 1024;

/** What a pass needs: where the pages are, the ledger, and the clock. */
export interface WriteEnv {
  vault: string;
  readLedger: () => LedgerRow[];
  append: (row: LedgerRow) => unknown;
  newId: (existing: { id?: string }[]) => string;
  now: () => string;
}

/** A refusal carries the exit code the CLI uses: 1 a check refused the work, 3 the lock is not this pass's. */
export type Outcome<T> = ({ ok: true } & T) | { ok: false; code: 1 | 3; messages: string[] };
const refuse = (code: 1 | 3, ...messages: string[]): { ok: false; code: 1 | 3; messages: string[] } => ({ ok: false, code, messages });

const leaseCtx = (env: WriteEnv, holder: string): LeaseContext => ({ readLedger: env.readLedger, append: env.append, window: holder, now: env.now, dryRun: false });
const hhmm = (ms: number): string => new Date(ms).toISOString().slice(11, 16);

/** A holder id: `cmp` plus 8 base36 characters, 11 in all, which fits a window id (12 at most). */
export const newHolder = (): string => `cmp${Array.from({ length: 8 }, () => Math.floor(Math.random() * 36).toString(36)).join('')}`;

/** Start a pass: take the composer lease as a fresh holder id. Refused (exit 3) while another pass holds it. */
export function begin(env: WriteEnv, holder = newHolder()): Outcome<{ holder: string; until: string }> {
  const got = acquireLease(leaseCtx(env, holder), COMPOSER_ITEM, { ttlMinutes: COMPOSER_TTL_MINUTES, text: 'composer pass' });
  if (!got.ok) return refuse(3, `a composer pass holds the lock until ${hhmm(got.lease?.until ?? Date.parse(env.now()))}`);
  return { ok: true, holder, until: new Date(got.lease.until).toISOString() };
}

/** The lease check every other subcommand makes: the live lease on the composer item must name this holder. */
export function requireHolder(env: WriteEnv, holder: string | undefined): Outcome<Record<never, never>> {
  if (!holder) return refuse(3, 'needs --holder <id> from `library-write begin`');
  const live = liveLease(foldLeases(env.readLedger()), COMPOSER_ITEM, Date.parse(env.now()));
  if (!live) return refuse(3, 'no composer pass is running (the lease lapsed or was never taken): run `library-write begin`');
  if (live.holder !== holder) return refuse(3, `the composer lock is ${describeLease(live)}, not by this holder`);
  return { ok: true };
}

/** End a pass: free the lease. Idempotent: ending a pass that already ended is not an error. */
export function end(env: WriteEnv, holder: string): Outcome<{ freed: boolean }> {
  const res = releaseLease(leaseCtx(env, holder), COMPOSER_ITEM, false);
  if ('heldBy' in res) return refuse(3, `the composer lock is ${describeLease(res.heldBy)}, not by this holder`);
  return { ok: true, freed: 'freed' in res };
}

/** Vault-relative page paths a pass may write: a Knowledge or Runbooks page of a project folder, with no `..` segment. */
export const pagePathProblem = (page: string): string | null =>
  !PAGE_PATH.test(page) || page.split('/').some((s) => s === '..' || s === '.' || s === '') ? 'page must be Projects/<repo>/(Knowledge|Runbooks)/<name>.md inside the vault' : null;

/** True when no existing component of `rel` under `vault` is a symlink and the deepest existing one resolves inside the vault. */
function stayInsideVault(vault: string, rel: string): boolean {
  const root = realpathSync(vault);
  let cur = vault;
  let deepest = vault;
  for (const part of rel.split('/')) {
    cur = join(cur, part);
    if (!existsSync(cur) && !isLink(cur)) break;
    if (isLink(cur)) return false;
    deepest = cur;
  }
  const real = realpathSync(deepest);
  return real === root || real.startsWith(root + sep);
}
const isLink = (p: string): boolean => { try { return lstatSync(p).isSymbolicLink(); } catch { return false; } };

/** `composed-by: composer` forced in the frontmatter (replaced if present, added if not). Text without a frontmatter block is returned as it is; the checks refuse it. */
export function forceComposer(text: string): string {
  const lines = text.split('\n');
  if (lines[0]?.trim() !== '---') return text;
  const close = lines.findIndex((l, i) => i > 0 && l.trim() === '---');
  if (close === -1) return text;
  const at = lines.findIndex((l, i) => i > 0 && i < close && /^composed-by:/.test(l));
  if (at >= 0) lines[at] = `composed-by: ${COMPOSER}`; else lines.splice(close, 0, `composed-by: ${COMPOSER}`);
  return lines.join('\n');
}

/** The page as a reader sees it: every `<!-- ... -->` span (an unclosed one runs to the end) removed, repeated until nothing changes. */
function stripComments(text: string): string {
  let t = text;
  for (;;) {
    const next = t.replace(/<!--[\s\S]*?(?:-->|$)/g, '');
    if (next === t) return t;
    t = next;
  }
}

/**
 * Every reason `text` may not become the page `page`: library-check's rules (all nine, over the staged text), the shared scanner over the
 * whole page, the same scanners over the whole page with comments stripped (a token split across a multi-line comment), and the
 * comment-split check line by line (a token split by a comment delimiter, which neither scanner sees raw).
 * Messages name the rule and the line, never the match.
 */
export function pageProblems(vault: string, page: string, text: string): string[] {
  const out: string[] = [];
  if (text.split('\n').length > MAX_LINES + 50) out.push('size: the page is far over the line budget');
  const report = checkTexts(vault, [{ path: page, text }])[0];
  for (const f of report?.findings ?? []) out.push(`${f.rule}${f.line ? `:${f.line}` : ''}: ${f.message}`);
  const shared = scanShared(text);
  for (const f of shared) out.push(`scanner: ${f.rule} (${f.class}) shape in the page (the match is not printed)`);
  const rendered = stripComments(text);
  if (rendered !== text && (scanShared(rendered).length || scanPage(rendered).length)) out.push('comment-split:page: the page fails the scan once its comments are removed (the match is not printed)');
  text.split('\n').forEach((line, i) => { if (line.length <= MAX_LINE && safeLine(line, MAX_LINE) === WITHHELD) out.push(`comment-split:${i + 1}: this line fails the scan once comment delimiters are removed (the match is not printed)`); else if (line.length > MAX_LINE) out.push(`size:${i + 1}: line over ${MAX_LINE} characters, not scanned`); });
  return out;
}

const sha256 = (s: string | Buffer): string => createHash('sha256').update(s).digest('hex');

/**
 * Replace one page from a staged file. The real page is untouched unless every check passes; the new text goes to a temp file beside
 * it and is renamed over it (the rename is the commit), and identical bytes write nothing. Returns the sha256 of the bytes on disk.
 */
export function writePage(env: WriteEnv, holder: string | undefined, page: string, stagedPath: string): Outcome<{ sha: string; changed: boolean }> {
  const lock = requireHolder(env, holder);
  if (!lock.ok) return lock;
  const bad = pagePathProblem(page);
  if (bad) return refuse(1, bad);
  if (!existsSync(join(env.vault, 'Projects', page.split('/')[1] as string))) return refuse(1, 'that project folder does not exist under the vault');
  if (!stayInsideVault(env.vault, page)) return refuse(1, 'the page path passes through a symlink or leaves the vault');
  let raw: string;
  try {
    if (!lstatSync(stagedPath).isFile()) return refuse(1, 'the staged file is not a regular file');
    if (lstatSync(stagedPath).size > STAGED_MAX) return refuse(1, `the staged file is over ${STAGED_MAX} bytes`);
    raw = readFileSync(stagedPath, 'utf8');
  } catch { return refuse(1, 'the staged file cannot be read'); }
  const text = forceComposer(raw.replace(/\r\n?/g, '\n'));
  const problems = pageProblems(env.vault, page, text);
  if (problems.length) return refuse(1, ...problems, 'nothing was written');
  const target = join(env.vault, page);
  const sha = sha256(text);
  if (existsSync(target) && sha256(readFileSync(target)) === sha) return { ok: true, sha, changed: false };
  mkdirSync(dirname(target), { recursive: true });
  const tmp = `${target}.tmp-${holder}`;
  try { writeFileSync(tmp, text, { flag: 'w' }); renameSync(tmp, target); } catch (e) { rmSync(tmp, { force: true }); throw e; }
  // `write` appends no ledger row, so renew the lease here (a no-op while more than half the time is left).
  acquireLease(leaseCtx(env, holder as string), COMPOSER_ITEM, { ttlMinutes: COMPOSER_TTL_MINUTES, text: 'composer pass' });
  return { ok: true, sha, changed: true };
}

/** The usage marks a curated row carries, as `journal.ts` rows do. */
export interface Marks { model?: string; used?: string[]; tokens?: string }

/**
 * Close one pending learned row: with `page` (the page exists and passes the same checks now; its sha256 is recorded) or with `reject`
 * (a scanned, one-line reason). The row is checked with the same function `verify` runs, so the writer cannot append what `verify` flags.
 */
export function curate(env: WriteEnv, holder: string | undefined, learnedId: string, how: { page?: string; reject?: string }, marks: Marks = {}): Outcome<{ id: string }> {
  const lock = requireHolder(env, holder);
  if (!lock.ok) return lock;
  if ((how.page === undefined) === (how.reject === undefined)) return refuse(1, 'give exactly one of --page and --reject');
  const rows = env.readLedger();
  if (!pendingLearned(rows).some((r) => r.id === learnedId)) return refuse(1, 'that id is not a pending learned row (unknown, or already curated)');
  const row: LedgerRow = { id: env.newId(rows), ts: env.now(), date: env.now().slice(0, 10), kind: 'curated', closes: learnedId, text: `curated ${learnedId}`, window: holder as string, ...marks };
  if (how.reject !== undefined) {
    const reason = how.reject.replace(/\s+/g, ' ').trim();
    if (!reason) return refuse(1, '--reject needs a reason');
    if (reason.length > REJECT_MAX) return refuse(1, `--reject is over ${REJECT_MAX} characters: say it shorter`);
    const findings = scanFields({ reject: reason });
    if (findings.length) return refuse(1, `--reject refused by the scanner (${describeFindings(findings).join('; ')}); nothing written`);
    row.rejected = reason;
  } else {
    const page = how.page as string;
    const bad = pagePathProblem(page);
    if (bad) return refuse(1, bad);
    if (!stayInsideVault(env.vault, page) || !existsSync(join(env.vault, page))) return refuse(1, 'that page does not exist in the vault (write it first)');
    const bytes = readFileSync(join(env.vault, page));
    const problems = pageProblems(env.vault, page, bytes.toString('utf8'));
    if (problems.length) return refuse(1, ...problems, 'the page on disk fails the checks; nothing written');
    row.page = page;
    row.pageSha = sha256(bytes);
  }
  const learnedIds = new Set(rows.filter((r) => r.kind === 'learned' && typeof r.id === 'string').map((r) => r.id as string));
  const own = curatedProblems(row, learnedIds);
  if (own.length) return refuse(1, ...own.map((p) => `curated row: ${p}`));
  env.append(row);
  return { ok: true, id: row.id as string };
}
