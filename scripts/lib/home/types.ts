import type { DocKind } from './docs.ts';
/** The shapes `GET /api/streams/:name/home` returns, as the stream home base brief documents them. Data only: no HTML, and no absolute path anywhere. */
export interface Ref { label: string; url?: string }
export type UnknownKind = 'ambiguous-epic' | 'missing-parent' | 'unreadable-note' | 'parent-cycle' | 'sparse-points' | 'big-points' | 'closed-not-verified' | 'ledger-ticket' | 'tracker-unread' | 'no-done-means' | 'config-invalid' | 'no-vault' | 'missing-context' | 'unreadable-doc' | 'brief-missing' | 'brief-stale';
/** Something the files cannot tell, with the fix in its text. `epic` says which epic block it counts toward, when one. */
export interface Unknown { kind: UnknownKind; text: string; ref?: Ref; epic?: string }

export interface TicketRow {
  id: string; title: string; status: string; points?: number; priority: number; ref: Ref; tracker?: Ref;
  /** At most three PRs that name this ticket; `prsMore` counts the rest. */
  prs: Ref[]; prsMore?: number; awaitsYou: boolean; quietDays: number | null;
}
/** One document of an epic. `url` is built by the server: an `obsidian://open` link for a vault note, an http(s) link for an outside document. */
export interface DocItem { title: string; kind: DocKind; project: string; ticket: string; status?: string; updated?: string; url?: string }
export interface EpicDocs {
  groups: { kind: DocKind; items: DocItem[]; more: number }[];
  /** Notes in the epic's projects, newer than 30 days, that name no ticket and are not marked `ticket: none`. */
  unattributedRecent: number;
}
/** A run of text in a brief. `link.url` is built by the server: http(s) for `web`, `obsidian://open` for `note`. */
export interface Inline { text: string; strong?: true; em?: true; code?: true; link?: { url: string; kind: 'web' | 'note' } }
export interface ListItem { runs: Inline[]; children: { runs: Inline[] }[] }
/** A brief as a typed tree: no Markdown and no HTML reach the client. Heading levels are 3 and 4 only. */
export type Block =
  | { type: 'heading'; level: 3 | 4; runs: Inline[] }
  | { type: 'paragraph'; runs: Inline[] }
  | { type: 'quote'; runs: Inline[] }
  | { type: 'list'; ordered: boolean; items: ListItem[] };
export interface EpicBrief {
  state: 'fresh' | 'stale' | 'missing' | 'too-long' | 'unreadable';
  updated?: string; staleBecause?: string[]; ref?: Ref; blocks?: Block[];
}
export interface EpicSummary {
  id: string; title: string; note: Ref; tracker?: Ref; status: string;
  total: number; closed: number; inProgress: number; blocked: number; notStarted: number;
  verify: { required: boolean; verified: number };
  /** Null unless at least 80 percent of the open tickets carry points. */
  points: { done: number; total: number; pointedOpen: number; open: number } | null;
  docs: EpicDocs;
  brief: EpicBrief;
  next?: TicketRow; awaiting: number; unknowns: number; quietDays: number | null;
}
export interface RailLink { label: string; kind: 'note' | 'tracker' | 'pr' | 'web'; url: string; meta?: string }
export interface LinkGroup { group: 'pinned' | 'epics' | 'docs' | 'prs' | 'runbooks'; items: RailLink[]; more: number }

export interface StreamHome {
  stream: string; generatedAt: string; seq: string;
  mapping: { source: 'config' | 'auto' | 'mixed'; configFound: boolean };
  epics: EpicSummary[];
  loose: TicketRow[];
  left: { inProgress: TicketRow[]; blocked: TicketRow[]; notStarted: TicketRow[]; truncated: number };
  doneMeans: { epic: string; text: string }[];
  links: LinkGroup[];
  history: null;
  unknowns: Unknown[];
  freshness: { tickets: string; prs: { fetchedAt: string | null; stale: boolean }; tracker: string | null };
}
