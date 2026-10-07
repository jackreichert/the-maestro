/**
 * Standing pickups: duties to pick up without being reminded, kept as data and checked at runtime.
 *
 * The store is `standing.jsonl` beside the ledger (append-only, one event per line):
 *   {op:'add', id, trigger, action, who, everyHours?, check?, at}   a row (replaces a built-in row of the same id)
 *   {op:'ran', id, evidence, at}                                    the row was done; the evidence is why that is believed
 *   {op:'retire', id, at}                                           the row is dropped (a built-in row too)
 *
 * A row is enforced one of two ways, and `add` refuses a row with neither: `check` names a runtime check (CHECKS below) whose answer
 * is the row's status, or `everyHours` makes it overdue when its last `ran` is older (never ran counts as overdue). `done` on a
 * checked row runs the check and refuses when it fails; on an unchecked row it refuses without evidence. So a row cannot be marked
 * done on a claim alone.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';

export interface StandingRow { id: string; trigger: string; action: string; who: string; everyHours?: number; check?: string }
export type StandingEvent =
  | ({ op: 'add'; at: string } & StandingRow)
  | { op: 'ran'; id: string; evidence: string; at: string }
  | { op: 'retire'; id: string; at: string };

/** What a runtime check may look at; the CLI fills it from the real machine and tests fill it with fakes. */
export interface CheckContext {
  now: number;
  /** The pid holding the event loop lock, or null. */
  loopPid: () => number | null;
  /** Ids of live watches past their expiry, and how many watches are live. */
  watches: () => { live: number; expired: string[] };
  /** Open in-flight and queued ledger items. */
  queue: () => { inflight: number; queued: number };
  /** Tracker keys done but not transitioned. */
  pendingTransitions: () => string[];
}
export interface CheckResult { ok: boolean; detail: string }
export type Check = (ctx: CheckContext) => CheckResult;

/** Every runtime check a row may name. A row naming anything else reads as failing, loudly. */
export const CHECKS: Record<string, Check> = {
  'loop-alive': ({ loopPid, watches }) => {
    const pid = loopPid();
    const { live, expired } = watches();
    if (pid === null) return { ok: false, detail: 'no event loop holds the lock' };
    if (!live) return { ok: false, detail: `loop pid ${pid} is running but no watches are registered` };
    if (expired.length) return { ok: false, detail: `expired watches: ${expired.join(', ')}` };
    return { ok: true, detail: `loop pid ${pid} running, ${live} watch(es) live` };
  },
  'queue-moving': ({ queue }) => {
    const { inflight, queued } = queue();
    return queued > 0 && inflight === 0 ? { ok: false, detail: `${queued} queued, nothing in flight` } : { ok: true, detail: `${inflight} in flight, ${queued} queued` };
  },
  'tracker-transitions': ({ pendingTransitions }) => {
    const keys = pendingTransitions();
    return keys.length ? { ok: false, detail: `${keys.length} not transitioned: ${keys.slice(0, 5).join(', ')}` } : { ok: true, detail: 'none pending' };
  },
};

/** Rows every install starts with; `retire` hides one, an `add` with the same id replaces it. Generic on purpose: org duties go in as `add` rows. */
export const DEFAULT_ROWS: StandingRow[] = [
  { id: 'loop-alive', trigger: 'session start, and whenever the loop exits', action: 'restart the event loop (or its supervisor) and renew expired watches', who: 'any model (haiku)', check: 'loop-alive' },
  { id: 'chain-next', trigger: 'an agent in a lane completes', action: 'dispatch the next queued item for that lane without being asked', who: 'orchestrator', check: 'queue-moving' },
  { id: 'merge-sweep', trigger: 'a pull request merges', action: 'sweep merged PRs: close their ledger items, sync any overlay branch, delete merged feature branches', who: 'any model (haiku)', everyHours: 24 },
  { id: 'branch-sweep', trigger: 'roll or handoff', action: 'branch and worktree sweep (journal.ts roll removes qualifying worktrees; branch-sweep.ts lists the rest)', who: 'any model (haiku)', everyHours: 36 },
  { id: 'tracker-reconcile', trigger: 'a done item carries a tracker key', action: 'move the tracker ticket and record it with `log --transitioned KEY`', who: 'any model (haiku)', check: 'tracker-transitions' },
];

export const STANDING_FILE = 'standing.jsonl';
/** About eleven years: a longer cadence is a typo, and would overflow a date. */
export const MAX_EVERY_HOURS = 100_000;
const ID = /^[a-z0-9][a-z0-9._-]{0,47}$/i;

/** The events in a standing file; a corrupt line is skipped, a missing file is empty. */
export function readEvents(file: string): StandingEvent[] {
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8').split('\n').filter(Boolean).flatMap((line) => {
    try { const e: unknown = JSON.parse(line); return isEvent(e) ? [e] : []; } catch { return []; }
  });
}

const isEvent = (e: unknown): e is StandingEvent => {
  if (typeof e !== 'object' || e === null) return false;
  const r = e as Record<string, unknown>;
  if (typeof r.id !== 'string' || typeof r.at !== 'string') return false;
  if (r.op === 'retire') return true;
  if (r.op === 'ran') return typeof r.evidence === 'string';
  return r.op === 'add' && typeof r.trigger === 'string' && typeof r.action === 'string' && typeof r.who === 'string' && validRow(r as unknown as StandingRow) === null;
};

/** Why a row is not acceptable, or null. */
export function validRow(row: StandingRow): string | null {
  if (!ID.test(row.id)) return `id must match ${ID}`;
  if (!row.trigger.trim() || !row.action.trim() || !row.who.trim()) return 'a row needs a trigger, an action and a who';
  if (row.check === undefined && row.everyHours === undefined) return 'a row needs a runtime check (--check) or a cadence (--every-hours), or nothing would ever flag it';
  if (row.check !== undefined && !(row.check in CHECKS)) return `unknown check "${row.check}" (known: ${Object.keys(CHECKS).join(', ')})`;
  if (row.everyHours !== undefined && !(Number.isFinite(row.everyHours) && row.everyHours > 0 && row.everyHours <= MAX_EVERY_HOURS)) return `--every-hours needs a positive number of at most ${MAX_EVERY_HOURS}`;
  return null;
}

export function appendEvent(file: string, event: StandingEvent): void {
  mkdirSync(dirname(file), { recursive: true });
  appendFileSync(file, `${JSON.stringify(event)}\n`);
}

export interface RowState { row: StandingRow; lastRan?: { at: string; evidence: string }; status: 'ok' | 'overdue' | 'failing'; detail: string }

/** The live rows (defaults, then adds, minus retired), without running any check. */
export function liveRows(events: StandingEvent[]): StandingRow[] {
  const rows = new Map<string, StandingRow>(DEFAULT_ROWS.map((r) => [r.id, r]));
  for (const e of events) {
    if (e.op === 'add') { const { op: _op, at: _at, ...row } = e; rows.set(row.id, row); }
    else if (e.op === 'retire') rows.delete(e.id);
  }
  return [...rows.values()];
}

/** The live rows (defaults, then adds, minus retired) with their status at `ctx.now`. */
export function standingState(events: StandingEvent[], ctx: CheckContext): RowState[] {
  const ran = new Map<string, { at: string; evidence: string }>();
  for (const e of events) {
    if (e.op === 'add' || e.op === 'retire') ran.delete(e.id);
    else ran.set(e.id, { at: e.at, evidence: e.evidence });
  }
  return liveRows(events).map((row) => {
    const lastRan = ran.get(row.id);
    if (row.check !== undefined) {
      const check = CHECKS[row.check];
      if (!check) return { row, lastRan, status: 'failing', detail: `unknown check "${row.check}"` };
      let r: CheckResult;
      try { r = check(ctx); } catch (err) { r = { ok: false, detail: `check threw: ${err instanceof Error ? err.message : String(err)}` }; }
      return { row, lastRan, status: r.ok ? 'ok' : 'failing', detail: r.detail };
    }
    const hours = row.everyHours ?? 0;
    const age = lastRan ? ctx.now - Date.parse(lastRan.at) : Number.POSITIVE_INFINITY;
    if (!(age <= hours * 3600_000)) return { row, lastRan, status: 'overdue', detail: lastRan ? `last ran ${ageText(age)} ago, due every ${hours} h` : `never ran, due every ${hours} h` };
    return { row, lastRan, status: 'ok', detail: `last ran ${ageText(age)} ago` };
  });
}

const ageText = (ms: number): string => (ms < 3600_000 ? `${Math.max(0, Math.floor(ms / 60_000))} min` : ms < 48 * 3600_000 ? `${Math.floor(ms / 3600_000)} h` : `${Math.floor(ms / 86_400_000)} days`);
const oneLine = (s: string, max: number): string => { const t = s.replace(/\s+/g, ' ').trim(); return t.length > max ? `${t.slice(0, max - 1)}…` : t; };

/** One row as one line. */
export const rowLine = (s: RowState): string =>
  `${s.status === 'ok' ? 'ok     ' : s.status === 'overdue' ? 'OVERDUE' : 'FAILING'} ${s.row.id}: ${oneLine(s.row.action, 110)} [trigger: ${oneLine(s.row.trigger, 60)}; who: ${oneLine(s.row.who, 30)}] ${oneLine(s.detail, 90)}`;

/** The block both `prime` and `handoff` print. `all` lists every row (handoff); otherwise only rows needing attention, at most `max` lines (prime). Empty when there is nothing to say. */
export function standingBlock(states: RowState[], { all = false, max = 6 }: { all?: boolean; max?: number } = {}): string[] {
  const shown = all ? states : states.filter((s) => s.status !== 'ok');
  if (!shown.length) return [];
  const attention = states.filter((s) => s.status !== 'ok').length;
  const head = `Standing pickups (${attention} need${attention === 1 ? 's' : ''} attention, ${states.length} total)${all ? '' : ': `journal.ts standing list`'}`;
  const lines = shown.map(rowLine);
  if (all || lines.length <= max) return [head, ...lines.map((l) => `  ${l}`)];
  return [head, ...lines.slice(0, max - 1).map((l) => `  ${l}`), `  … +${lines.length - (max - 1)} more`];
}

/** A built-in row exactly as shipped is routine upkeep; any other row, including a built-in id someone overrode with their own words, is a condition. */
export const isRoutine = (row: StandingRow): boolean => DEFAULT_ROWS.some((d) => d.id === row.id && d.trigger === row.trigger && d.action === row.action && d.who === row.who && d.everyHours === row.everyHours && d.check === row.check);

/** The rows tied to a future action (not built in), overdue or failing ones first. */
export const conditionStates = (states: RowState[]): RowState[] =>
  states.filter((s) => !isRoutine(s.row)).sort((a, b) => Number(a.status === 'ok') - Number(b.status === 'ok'));

/** A standing id that cannot carry typed text: lowercase words joined by hyphens. `standing add` enforces it; older ids print as a placeholder here. */
export const SAFE_ID = /^[a-z]+(?:-[a-z]+){0,5}$/;
export const ID_WITHHELD = '[id withheld]';
export const printableId = (id: string): string => (SAFE_ID.test(id) ? id : ID_WITHHELD);

/** When a row is next due, in words made only of digits and fixed text: `ISO time`, `now` (never ran or failing), or `checked: <check name>`. */
export function dueText(s: RowState): string {
  if (s.row.check !== undefined) return `checked: ${s.row.check in CHECKS ? s.row.check : 'unknown check'}`;
  if (!s.lastRan || s.status !== 'ok') return 'now';
  const due = Date.parse(s.lastRan.at) + (s.row.everyHours ?? 0) * 3600_000;
  return Number.isFinite(due) && Math.abs(due) < 8.64e15 ? `${new Date(due).toISOString().slice(0, 16)}Z` : 'unknown';
}

/** One condition as one line for `prime`: id, status, due time and kind only (the text stays in `standing list`). */
const conditionLineOf = (s: RowState): string => `Condition ${printableId(s.row.id)} [${s.status === 'ok' ? 'due' : s.status.toUpperCase()}] standing pickup, due ${dueText(s)}`;

/** One condition line; a row that cannot be described degrades to its own placeholder line instead of taking the others down. */
export const conditionLine = (s: RowState): string => {
  try { return conditionLineOf(s); } catch { return `Condition ${printableId(s.row.id)} [unreadable] standing pickup`; }
};

/** The lines `prime` prints before anything else: at most `max`, the last being `… +N more, journal.ts standing list` when some were cut. */
export function conditionLines(states: RowState[], max = 6): string[] {
  const rows = conditionStates(states).map(conditionLine);
  return rows.length <= max ? rows : [...rows.slice(0, max - 1), `… +${rows.length - (max - 1)} more, journal.ts standing list`];
}
