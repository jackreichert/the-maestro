/**
 * Which library pages a person has edited since the composer last wrote them. The record is the one the write path already keeps: the sha256 of the
 * page's bytes on the page's latest `curated` ledger row (`pageSha`). A page whose disk sha differs from it was edited by hand; a page with no
 * `curated` row has no recorded sha, so only its `told-by-jack` lines are protected. Read-only: it compares and reports, it never blesses a page.
 */
import { createHash } from 'node:crypto';
import type { LedgerRow } from '../ledger-core.ts';

export interface HumanEditRow {
  path: string;
  /** `edited`: the disk differs from the last recorded write. `unchanged`: it matches. `unrecorded`: no `curated` row names this page. */
  state: 'edited' | 'unchanged' | 'unrecorded';
  detail: string;
}

export const sha256 = (bytes: string | Buffer): string => createHash('sha256').update(bytes).digest('hex');

/** The `pageSha` of each page's latest `curated` row, in ledger order (a later row, such as a refresh, replaces an earlier one). */
export function recordedShas(rows: readonly LedgerRow[]): Map<string, string> {
  const latest = new Map<string, string>();
  for (const r of rows) if (r.kind === 'curated' && typeof r.page === 'string' && typeof r.pageSha === 'string') latest.set(r.page, r.pageSha);
  return latest;
}

/** One row per page. `pages` carry the sha of the bytes on disk and how many `told-by-jack` lines the page holds. */
export function humanEdits(pages: readonly { path: string; sha: string; told: number }[], rows: readonly LedgerRow[]): HumanEditRow[] {
  const recorded = recordedShas(rows);
  return pages.map(({ path, sha, told }) => {
    const was = recorded.get(path);
    if (was === undefined) return { path, state: 'unrecorded', detail: `no curated row records this page; only its ${told} told-by-jack line${told === 1 ? '' : 's'} ${told === 1 ? 'is' : 'are'} protected` };
    if (was === sha) return { path, state: 'unchanged', detail: 'matches the last composer write' };
    return { path, state: 'edited', detail: `disk ${sha.slice(0, 12)} differs from the last recorded write ${was.slice(0, 12)}: do not overwrite; raise an ask if the source contradicts a line` };
  });
}

export function renderHumanEdits(rows: readonly HumanEditRow[]): string[] {
  const of = (state: HumanEditRow['state']): HumanEditRow[] => rows.filter((r) => r.state === state);
  return [
    ...of('edited').map((r) => `${r.path}  HUMAN-EDITED  ${r.detail}`),
    ...of('unrecorded').map((r) => `${r.path}  unrecorded  ${r.detail}`),
    `library-check --human-edited: ${rows.length} page${rows.length === 1 ? '' : 's'}, ${of('edited').length} human-edited, ${of('unrecorded').length} unrecorded, ${of('unchanged').length} unchanged`,
  ];
}
