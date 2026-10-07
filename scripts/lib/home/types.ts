/** The shapes `GET /api/streams/:name/home` returns, as the stream home base brief documents them. Data only: no HTML, and no absolute path anywhere. */
export interface Ref { label: string; url?: string }
export type UnknownKind = 'ambiguous-epic' | 'missing-parent' | 'unreadable-note' | 'parent-cycle' | 'sparse-points' | 'big-points' | 'closed-not-verified' | 'ledger-ticket' | 'tracker-unread' | 'no-done-means' | 'config-invalid' | 'no-vault' | 'missing-context' | 'unreadable-doc';
/** Something the files cannot tell, with the fix in its text. `epic` says which epic block it counts toward, when one. */
export interface Unknown { kind: UnknownKind; text: string; ref?: Ref; epic?: string }

export interface TicketRow {
  id: string; title: string; status: string; points?: number; priority: number; ref: Ref; tracker?: Ref;
  /** At most three PRs that name this ticket; `prsMore` counts the rest. */
  prs: Ref[]; prsMore?: number; awaitsYou: boolean; quietDays: number | null;
}
export interface EpicSummary {
  id: string; title: string; note: Ref; tracker?: Ref; status: string;
  total: number; closed: number; inProgress: number; blocked: number; notStarted: number;
  verify: { required: boolean; verified: number };
  /** Null unless at least 80 percent of the open tickets carry points. */
  points: { done: number; total: number; pointedOpen: number; open: number } | null;
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
