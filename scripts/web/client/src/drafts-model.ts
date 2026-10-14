/** The draft-comment queue as the page reads it (`GET /api/drafts`), checked field by field: a row that fails is dropped, never shown half-formed. */

export type DraftSeverity = 'blocking' | 'suggestion' | 'reply';
export type DraftStatus = 'pending' | 'approved' | 'posting' | 'posted' | 'failed' | 'uncertain' | 'rejected';
export interface DraftRow {
  id: string; source: 'review' | 'reply'; repo: string; pr: number; prUrl: string; severity: DraftSeverity; text: string;
  where?: string; context?: string; replyTo?: string; state: DraftStatus; error?: string; postedUrl?: string; rejectReason?: string; createdAt: string;
}
export interface DraftsData { generatedAt: string; drafts: DraftRow[] }

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown, max = 5000): v is string => typeof v === 'string' && v.length <= max;
const opt = (v: unknown, max?: number): boolean => v === undefined || str(v, max);
const STATES = ['pending', 'approved', 'posting', 'posted', 'failed', 'uncertain', 'rejected'];

function row(x: unknown): DraftRow | null {
  if (!isObj(x)) return null;
  const ok = str(x.id, 20) && /^dr-[0-9a-f]{8}$/.test(x.id) && (x.source === 'review' || x.source === 'reply') && str(x.repo, 200) && Number.isSafeInteger(x.pr)
    && str(x.prUrl, 300) && ['blocking', 'suggestion', 'reply'].includes(String(x.severity)) && str(x.text) && STATES.includes(String(x.state)) && str(x.createdAt, 40)
    && opt(x.where, 400) && opt(x.context, 600) && opt(x.replyTo, 100) && opt(x.error, 300) && opt(x.postedUrl, 400) && opt(x.rejectReason, 600);
  return ok ? (x as unknown as DraftRow) : null;
}

/** DraftsData from an untrusted body, or null when it has no usable shape. */
export function sanitizeDrafts(x: unknown): { data: DraftsData; dropped: number } | null {
  if (!isObj(x) || !str(x.generatedAt, 40) || !Array.isArray(x.drafts)) return null;
  const drafts = x.drafts.map(row).filter((r): r is DraftRow => r !== null);
  return { data: { generatedAt: x.generatedAt, drafts }, dropped: x.drafts.length - drafts.length };
}

/** A draft still waits on the person when it is pending, or failed (gh refused it, so it may be approved again). */
export const waiting = (d: DraftRow): boolean => d.state === 'pending' || d.state === 'failed';
