/**
 * The cross-stream epic list behind `GET /api/epics`: one compact line per open epic, grouped under the stream that claims it,
 * plus the epics no stream claims. A pure reducer over what `buildStreamHome` and `unfiledEpics` already counted, so a line
 * and the stream's home base never disagree.
 */
import type { EpicSummary, Ref, StreamHome } from './types.ts';

/** One epic as the Board draws it under a priority: progress, the next ticket, what waits on the user, and the PRs that name it. */
export interface EpicLine {
  id: string; title: string; note: Ref; tracker?: Ref; status: string;
  total: number; closed: number; inProgress: number; blocked: number; notStarted: number;
  awaiting: number; quietDays: number | null;
  next?: { id: string; title: string; ref: Ref };
  prs: Ref[]; prsMore?: number;
}

export interface EpicsData {
  generatedAt: string;
  streams: { stream: string; epics: EpicLine[] }[];
  /** Open epics no stream claims, never dropped. */
  unfiled: EpicLine[];
}

const line = (e: EpicSummary): EpicLine => ({
  id: e.id, title: e.title, note: e.note, ...(e.tracker ? { tracker: e.tracker } : {}), status: e.status,
  total: e.total, closed: e.closed, inProgress: e.inProgress, blocked: e.blocked, notStarted: e.notStarted,
  awaiting: e.awaiting, quietDays: e.quietDays,
  ...(e.next ? { next: { id: e.next.id, title: e.next.title, ref: e.next.ref } } : {}),
  prs: e.prs, ...(e.prsMore ? { prsMore: e.prsMore } : {}),
});

/** Closed epics are left out: a rollup under a priority answers "what is still open". */
const open = (epics: EpicSummary[]): EpicLine[] => epics.filter((e) => e.status !== 'closed').map(line);

export function epicsData(generatedAt: string, homes: Pick<StreamHome, 'stream' | 'epics'>[], unfiled: EpicSummary[]): EpicsData {
  return { generatedAt, streams: homes.map((h) => ({ stream: h.stream, epics: open(h.epics) })), unfiled: open(unfiled) };
}
