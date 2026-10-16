import { BASE_CSS, h, refLink, shadow } from './dom.ts';
import { GRID_CSS } from './grid.ts';
import { INSTRUMENT_CSS, TACET_CSS, tacet } from './score.ts';
import { ago, askAge, clockTime } from './glance.ts';
import { readyToMerge } from './pr-ready.ts';
import type { OpenPrRow } from './types.ts';
import type { OpenPrsModel } from './open-prs-store.ts';

type Move = 'ready' | 'yours' | 'orchestra' | 'drafts';
type Lens = 'failing' | 'conflict' | 'threads' | 'staging' | 'stacked';
type Tone = 'ok' | 'crit' | 'warn' | 'none';
interface Gate { tone: Tone; glyph: string; word: string }
type Mix = 'pass' | 'pending' | 'fail' | 'none';

const CSS = `${BASE_CSS}
  :host { display: block; }
  ${GRID_CSS}
  .cue { row-gap: var(--space-6); align-items: end; padding-bottom: var(--space-6); border-bottom: var(--hairline); }
  .kicker { font-size: var(--text-sm); color: var(--text-muted); }
  .cueline { margin: var(--space-4) 0 0; font: 400 clamp(2rem, 3.6vw, 3.25rem)/1.08 var(--font-display); letter-spacing: -0.02em; color: var(--text-muted); }
  .cue-item { white-space: nowrap; }
  .cueline .sep { margin: 0 0.18em; color: var(--border-strong); }
  button.cnt {
    font: inherit; letter-spacing: inherit; color: var(--text-secondary); background: none; border: 0; cursor: pointer;
    white-space: nowrap; border-radius: var(--radius-xs); padding: 0 0.06em;
  }
  button.cnt b { font-weight: var(--weight-regular); color: var(--text-primary); }
  @media (hover: hover) { button.cnt:hover { background: var(--surface-2); color: var(--text-primary); } }
  button.cnt[aria-pressed=true] { color: var(--text-primary); text-decoration: underline; text-decoration-thickness: 2px; text-underline-offset: 0.12em; text-decoration-color: var(--accent); }
  button.cnt.hot b { color: var(--accent); }
  .lede { margin: var(--space-4) 0 0; max-width: 62ch; font-size: var(--text-lg); line-height: var(--leading-lg); color: var(--text-secondary); }
  .lede strong { color: var(--text-primary); font-weight: var(--weight-semibold); }
  .side-facts { display: grid; gap: var(--space-4); }
  .eyebrow { font-size: var(--text-xs); font-weight: var(--weight-semibold); letter-spacing: var(--tracking-caps); text-transform: uppercase; color: var(--text-muted); }
  .mix-bar { display: flex; height: 12px; border-radius: 3px; overflow: hidden; gap: 2px; margin-top: var(--space-2); }
  .mix-bar span { flex: 1 1 0; min-width: 2px; }
  .mix-bar .pass, .legend .pass { background: var(--success); }
  .mix-bar .pending, .legend .pending { background: var(--warning); }
  .mix-bar .fail, .legend .fail { background: var(--critical); }
  .mix-bar .none, .legend .none { background: var(--border-strong); }
  .legend { display: flex; flex-wrap: wrap; gap: var(--space-2) var(--space-4); font-size: var(--text-xs); color: var(--text-secondary); margin-top: var(--space-3); }
  .legend span { display: inline-flex; align-items: center; gap: 6px; }
  .legend i { width: 8px; height: 8px; border-radius: 2px; }
  .facts { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: var(--space-3); }
  .fact { display: grid; gap: 2px; font-size: var(--text-xs); color: var(--text-muted); }
  .fact b { font: 400 1.75rem/1 var(--font-display); color: var(--text-primary); }
  .refresh-bar { display: flex; flex-wrap: wrap; align-items: center; gap: var(--space-2) var(--space-4); margin-top: var(--space-4); font-size: var(--text-sm); color: var(--text-secondary); font-variant-numeric: tabular-nums; }
  button.refresh {
    font: inherit; font-size: var(--text-sm); font-weight: var(--weight-medium); color: var(--text-primary);
    display: inline-flex; align-items: center; gap: var(--space-2); min-height: 32px; padding: 0 var(--space-3);
    border: var(--hairline-strong); border-radius: var(--radius-sm); background: var(--surface-1); cursor: pointer;
  }
  @media (hover: hover) { button.refresh:hover { background: var(--surface-2); } }
  button.refresh[aria-disabled=true] { color: var(--text-muted); cursor: progress; }
  .warn { color: var(--warning); font-weight: var(--weight-semibold); }
  .state:empty { display: none; }
  .state.failed, .state.locked { color: var(--critical); }
  .state.done { color: var(--success); }
  .filter-note { display: flex; align-items: center; gap: var(--space-3); margin-top: var(--space-5); font-size: var(--text-sm); color: var(--text-secondary); }
  .controls { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: var(--space-3); margin: var(--space-6) 0 var(--space-2); }
  .chips { display: flex; flex-wrap: wrap; gap: var(--space-2); }
  button.chip {
    display: inline-flex; align-items: center; gap: var(--space-2); min-height: 32px; padding: 0 var(--space-3);
    border-radius: var(--radius-pill); border: var(--hairline); background: transparent; color: var(--text-secondary);
    font: 500 var(--text-sm)/1 var(--font-sans); cursor: pointer;
  }
  @media (hover: hover) { button.chip:hover { background: var(--surface-2); color: var(--text-primary); } }
  button.chip[aria-pressed=true] { background: var(--text-primary); border-color: var(--text-primary); color: var(--surface-page); }
  button.chip .c { color: var(--text-muted); font-size: var(--text-xs); }
  button.chip[aria-pressed=true] .c { color: var(--surface-page); }
  .search { display: flex; align-items: center; gap: var(--space-2); min-height: 36px; padding: 0 var(--space-3); border-radius: var(--radius-sm); border: var(--hairline-strong); background: var(--surface-1); min-width: min(260px, 100%); }
  .search:focus-within { outline: 2px solid var(--accent); outline-offset: 0; border-color: var(--accent); }
  .search input { all: unset; flex: 1; font-size: var(--text-sm); color: var(--text-primary); min-width: 0; }
  .shown { font-size: var(--text-sm); color: var(--text-muted); }
  .band { margin-top: var(--space-7); }
  .band-head { display: grid; gap: var(--space-1); padding-bottom: var(--space-3); border-bottom: var(--hairline-strong); }
  .band-head h2 { margin: 0; font-size: var(--text-lg); font-weight: var(--weight-semibold); display: flex; align-items: baseline; gap: var(--space-2); }
  .band-head .n { font: 400 1.75rem/1 var(--font-display); color: var(--text-secondary); }
  .band-head p { margin: 0; font-size: var(--text-sm); color: var(--text-muted); max-width: 72ch; }
  .repo { margin-top: var(--space-4); }
  .repo h3 { margin: 0; display: flex; align-items: baseline; gap: var(--space-3); font: 500 var(--text-sm)/1.4 var(--font-mono); color: var(--text-secondary); padding: var(--space-2) 0; }
  .repo h3 .c { font: 400 var(--text-xs)/1 var(--font-sans); color: var(--text-muted); }
  ul.prs { list-style: none; margin: 0; padding: 0; }
  .pr { display: grid; grid-template-columns: minmax(0, 1fr) 120px minmax(220px, 340px) 56px; gap: var(--space-4); align-items: center; padding: var(--space-3) var(--space-2) var(--space-3) 0; border-top: var(--hairline); }
  @media (hover: hover) { .pr:hover { background: var(--surface-2); } }
  .pr.child { padding-left: var(--space-6); }
  .pr.pair { display: grid; grid-template-columns: minmax(0, 1fr); gap: var(--space-3); align-items: start; }
  .lanes { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: var(--space-4); }
  .lane { min-width: 0; display: grid; gap: var(--space-2); padding-left: var(--space-3); border-left: 2px solid var(--border-strong); }
  .lane.staging { border-left-color: var(--accent); }
  .lane.merged { border-left-style: dashed; color: var(--text-muted); }
  .lane-h { display: flex; flex-wrap: wrap; align-items: baseline; gap: var(--space-2) var(--space-3); font-size: var(--text-xs); color: var(--text-muted); }
  .lane-h .branch { font: 500 var(--text-xs)/1.3 var(--font-mono); color: var(--text-secondary); }
  .lane-h a { color: var(--text-primary); font-weight: var(--weight-medium); text-decoration: none; }
  @media (hover: hover) { .lane-h a:hover { color: var(--accent); text-decoration: underline; } }
  .lane-h .tag { font-weight: var(--weight-semibold); color: var(--text-secondary); }
  .lane-h .age { margin-left: auto; font-size: var(--text-xs); }
  .pr-t { min-width: 0; display: grid; gap: 4px; }
  .pr-t a.title { color: var(--text-primary); text-decoration: none; font-weight: var(--weight-medium); overflow-wrap: anywhere; }
  @media (hover: hover) { .pr-t a.title:hover { color: var(--accent); text-decoration: underline; } }
  .sub { display: flex; flex-wrap: wrap; align-items: center; gap: 2px var(--space-3); font-size: var(--text-xs); color: var(--text-muted); }
  .sub .wait { color: var(--warning); font-weight: var(--weight-semibold); }
  .num { font-family: var(--font-mono); color: var(--text-secondary); }
  .base { font: 500 var(--text-xs)/1.3 var(--font-mono); color: var(--text-secondary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .base.staging { color: var(--accent); }
  .gates { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 4px; }
  .gate { display: grid; gap: 2px; justify-items: start; font-size: 11px; line-height: 1.2; color: var(--text-muted); }
  .gate .g { display: inline-flex; align-items: center; gap: 4px; font-size: var(--text-xs); font-weight: var(--weight-semibold); white-space: nowrap; }
  .gate.ok .g { color: var(--success); }
  .gate.crit .g { color: var(--critical); }
  .gate.warn .g { color: var(--warning); }
  .gate.none .g { color: var(--text-muted); font-weight: var(--weight-medium); }
  details.appr { font-size: var(--text-xs); color: var(--text-muted); }
  details.appr summary { cursor: pointer; width: fit-content; color: var(--success); font-weight: var(--weight-semibold); border-radius: var(--radius-xs); }
  details.appr summary:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
  details.appr ul { list-style: none; margin: 2px 0 0; padding: 0; display: flex; flex-wrap: wrap; gap: 2px var(--space-3); font-family: var(--font-mono); color: var(--text-secondary); }
  .age { text-align: right; font-size: var(--text-sm); color: var(--text-secondary); font-variant-numeric: tabular-nums; }
  .empty { margin: 0; padding: var(--space-4) 0; color: var(--text-muted); font-size: var(--text-sm); }
  ${INSTRUMENT_CSS}${TACET_CSS}
  @media (max-width: 960px) {
    .pr { grid-template-columns: minmax(0, 1fr) auto; }
    .pr .base, .pr .gates { grid-column: 1; }
    .pr .age { grid-column: 2; grid-row: 1; }
    .lanes { grid-template-columns: minmax(0, 1fr); }
  }
`;

const MOVES: { id: Move; instrument: string; word: string; title: string; note: string; empty: [string, string] }[] = [
  { id: 'ready', instrument: 'Cadence', word: 'ready to merge', title: 'Ready to merge', note: 'Approved, no open threads and no conflicts; a staging PR also needs its develop twin merged. A self-review PR needs only passing checks and no conflict. Pinned here until merged.', empty: ['Nothing is ready to merge.', 'tacet'] },
  { id: 'yours', instrument: 'Solo', word: 'your move', title: 'Your move', note: 'Clean and out of draft. These wait on your review or your merge.', empty: ['Nothing waits on your review.', 'tacet'] },
  { id: 'orchestra', instrument: 'Tutti', word: 'orchestra fixing', title: 'The orchestra is fixing', note: 'Failing CI, conflicts, open threads or changes requested. Fixes still go out without a new review.', empty: ['Nothing needs fixing.', 'a tempo'] },
  { id: 'drafts', instrument: 'Sketches', word: 'drafts', title: 'Drafts', note: 'Still being written. They join your move when they leave draft.', empty: ['No drafts open.', 'rest'] },
];
const LENSES: { id: Lens; label: string }[] = [
  { id: 'failing', label: 'Failing CI' },
  { id: 'conflict', label: 'Conflicts' },
  { id: 'threads', label: 'Open threads' },
  { id: 'staging', label: 'Into staging' },
  { id: 'stacked', label: 'Stacked' },
];
const MIX_LABEL: Record<Mix, string> = { pass: 'Passing', pending: 'Running', fail: 'Failing', none: 'No checks' };

interface Drawn extends OpenPrRow { repo: string; selfReview: boolean }
/**
 * What the tab lists: one PR, or a develop/staging pair drawn as one card. `lead` is the PR the card sorts and links by (the develop
 * PR while it is open, else the staging PR); `mate` is the staging PR beside an open develop PR; `merged` is a develop PR that has merged
 * and is kept beside its still-open staging PR until that merges too.
 */
interface Unit { lead: Drawn; mate?: Drawn; merged?: NonNullable<OpenPrRow['sides']>['develop'] }
const members = (u: Unit): Drawn[] => (u.mate ? [u.lead, u.mate] : [u.lead]);
const MOVE_URGENCY: Move[] = ['orchestra', 'drafts', 'yours', 'ready'];

/** Pairs each develop PR with the open staging PR on the other side of its `sides` (same repo), and keeps a merged develop twin on its staging PR. Everything else stays alone. */
export function toUnits(list: Drawn[]): Unit[] {
  const byNumber = new Map(list.map((p) => [`${p.repo}#${p.number}`, p]));
  const open = (p: Drawn, n: number | undefined): Drawn | undefined => (n === undefined ? undefined : byNumber.get(`${p.repo}#${n}`));
  const taken = new Set<Drawn>();
  const units: Unit[] = [];
  for (const p of list) {
    const stg = p.base === 'develop' && !p.sides?.develop?.merged ? open(p, p.sides?.staging?.number) : undefined;
    if (stg && stg.base === 'staging' && stg.sides?.develop?.number === p.number && !taken.has(stg) && !taken.has(p)) { taken.add(p); taken.add(stg); units.push({ lead: p, mate: stg }); }
  }
  for (const p of list) {
    if (taken.has(p)) continue;
    const merged = p.base === 'staging' ? p.sides?.develop : undefined;
    units.push(merged?.merged ? { lead: p, merged } : { lead: p });
  }
  return units;
}

const needsFix = (p: OpenPrRow): boolean => p.ci === 'FAILURE' || p.ci === 'ERROR' || p.mergeable === 'conflicting' || p.unresolved > 0 || p.review === 'changes-requested';
const moveOf = (p: OpenPrRow): Move => (readyToMerge(p) ? 'ready' : p.isDraft ? 'drafts' : needsFix(p) ? 'orchestra' : 'yours');
/** The band of a card: the most urgent move among its PRs, so a pair never reads Ready while one side needs fixing. */
const unitMove = (u: Unit): Move => members(u).map(moveOf).sort((a, b) => MOVE_URGENCY.indexOf(a) - MOVE_URGENCY.indexOf(b))[0]!;
const lensOn = (p: OpenPrRow, lens: Lens): boolean => {
  if (lens === 'failing') return p.ci === 'FAILURE' || p.ci === 'ERROR';
  if (lens === 'conflict') return p.mergeable === 'conflicting';
  if (lens === 'threads') return p.unresolved > 0;
  if (lens === 'staging') return p.base === 'staging';
  return p.stackedOn !== undefined;
};
const mixOf = (p: OpenPrRow): Mix => (p.ci === 'SUCCESS' ? 'pass' : p.ci === 'FAILURE' || p.ci === 'ERROR' ? 'fail' : p.ci === 'PENDING' || p.ci === 'EXPECTED' ? 'pending' : 'none');

const CI: Record<string, Gate> = {
  SUCCESS: { tone: 'ok', glyph: '✓', word: 'Passing' }, FAILURE: { tone: 'crit', glyph: '✕', word: 'Failing' }, ERROR: { tone: 'crit', glyph: '✕', word: 'Failing' },
  PENDING: { tone: 'warn', glyph: '○', word: 'Running' }, EXPECTED: { tone: 'warn', glyph: '○', word: 'Running' }, NONE: { tone: 'none', glyph: '–', word: 'None' },
};
const MERGE: Record<OpenPrRow['mergeable'], Gate> = {
  mergeable: { tone: 'ok', glyph: '✓', word: 'Clean' }, conflicting: { tone: 'crit', glyph: '✕', word: 'Conflicts' }, unknown: { tone: 'none', glyph: '…', word: 'Checking' },
};
const REVIEW: Record<OpenPrRow['review'], Gate> = {
  none: { tone: 'none', glyph: '–', word: 'None' }, approved: { tone: 'ok', glyph: '✓', word: 'Approved' }, 'changes-requested': { tone: 'crit', glyph: '✕', word: 'Changes' },
};
const PROTECTED = new Set(['develop', 'staging', 'main', 'master']);
const isMove = (v: string | undefined): v is Move => v === 'ready' || v === 'yours' || v === 'orchestra' || v === 'drafts';
const isLens = (v: string | undefined): v is Lens => v === 'failing' || v === 'conflict' || v === 'threads' || v === 'staging' || v === 'stacked';

/**
 * <open-prs>: open PRs by whose move (your review, fixes in flight, drafts), one row per PR with its base and four gates.
 * It draws what `model` says and calls `onRefresh` on a press. Search, lenses and the move filter stay on the element, so a
 * redraw does not drop them. The button uses aria-disabled, so it keeps focus.
 */
export class OpenPrs extends HTMLElement {
  #root: ShadowRoot;
  #model: OpenPrsModel | null = null;
  #tz = '';
  #move: Move | null = null;
  #lens: Lens | null = null;
  #q = '';
  #fresh = h('span', { class: 'fresh' });
  #state = h('span', { class: 'state', role: 'status' });
  #button = h('button', { type: 'button', class: 'refresh' }, 'Refresh');
  #body = h('div', {});
  onRefresh: () => void = () => {};

  constructor() {
    super();
    this.#root = shadow(this, CSS);
    this.#button.addEventListener('click', () => { if (this.#button.getAttribute('aria-disabled') !== 'true') this.onRefresh(); });
    this.#root.addEventListener('click', (e) => this.#onClick(e));
    this.#root.addEventListener('input', (e) => {
      const t = e.target;
      if (!(t instanceof Element) || t.tagName !== 'INPUT') return;
      const input = t as HTMLInputElement;
      if (input.type !== 'search') return;
      this.#q = input.value;
      this.#draw();
    });
    this.#root.append(this.#body);
  }

  set tz(v: string) { this.#tz = v; if (this.#model) this.#draw(); }
  set model(m: OpenPrsModel) { this.#model = m; if (this.isConnected) this.#draw(); }
  connectedCallback(): void { if (this.#model) this.#draw(); }

  #onClick(e: Event): void {
    const b = e.target instanceof Element ? e.target.closest('button') : null;
    if (!b || b === this.#button) return;
    const move = b.dataset.move;
    const lens = b.dataset.lens;
    if (isMove(move)) this.#move = this.#move === move ? null : move;
    else if (isLens(lens)) this.#lens = this.#lens === lens ? null : lens;
    else return;
    this.#draw();
    const sel = isMove(move) ? `button[data-move="${move}"]` : `button[data-lens="${lens ?? ''}"]`;
    this.#root.querySelector<HTMLButtonElement>(sel)?.focus();
  }

  #draw(): void {
    const m = this.#model;
    if (!m) return;
    const running = m.refresh.kind === 'running';
    this.#button.setAttribute('aria-disabled', String(running));
    this.#button.textContent = running ? 'Refreshing...' : 'Refresh';
    this.#state.className = `state ${m.refresh.kind}`;
    this.#state.textContent = { idle: '', running: 'Refreshing the PR data...', done: 'Refreshed.', failed: m.refresh.message ?? 'The refresh failed.', locked: m.refresh.message ?? 'Another refresh is already running.' }[m.refresh.kind];
    this.#drawFresh(m);
    const active = this.#root.activeElement;
    const search = active instanceof Element && active.tagName === 'INPUT';
    this.#body.replaceChildren(...this.#content(m));
    if (search) {
      const input = this.#body.querySelector('input[type=search]');
      if (input instanceof Element && input.tagName === 'INPUT') {
        const field = input as HTMLInputElement;
        field.focus();
        field.setSelectionRange(this.#q.length, this.#q.length);
      }
    }
  }

  #drawFresh(m: OpenPrsModel): void {
    const d = m.data;
    if (!d) { this.#fresh.replaceChildren(m.loaded ? 'PR data is not available from this page.' : 'Loading PR data...'); return; }
    const at = d.prData.fetchedAt;
    const clock = at ? clockTime(at, this.#tz) : '';
    const age = at ? ago(at, d.generatedAt) : '';
    const text = at ? `PR data ${clock || at}${age ? ` (${age === 'just now' ? age : `${age} ago`})` : ''}` : 'PR data: none yet';
    const warn = d.prData.failure ? `GitHub could not be read (${d.prData.failure}); showing the last data.` : d.prData.stale || !at ? 'Stale. Press Refresh.' : '';
    this.#fresh.replaceChildren(text);
    if (warn) this.#fresh.append(h('span', { class: 'warn' }, ` ${warn}`));
  }

  #list(m: OpenPrsModel): Drawn[] {
    return (m.data?.groups ?? []).flatMap((g) => g.repos.flatMap((r) => r.prs.map((p): Drawn => ({ ...p, repo: r.repo, selfReview: g.id === 'self-review' }))));
  }

  /** The units with a member that passes the lens and the search: a pair stays whole when either side matches. */
  #visible(units: Unit[]): Unit[] {
    const q = this.#q.trim().toLowerCase();
    const hit = (p: Drawn): boolean => (!this.#lens || lensOn(p, this.#lens)) && (!q || `${p.title} ${p.repo} ${p.number} ${p.ticket?.label ?? ''}`.toLowerCase().includes(q));
    return units.filter((u) => members(u).some(hit));
  }

  #content(m: OpenPrsModel): Node[] {
    const d = m.data;
    if (!d) return [h('p', { class: 'empty' }, this.#fresh)];
    if (d.total === 0) return [tacet('No open PRs.', 'tacet'), h('p', { class: 'empty' }, this.#fresh)];
    const all = this.#list(m);
    const units = toUnits(all);
    const shown = this.#visible(units);
    const bands = MOVES.filter((mv) => !this.#move || mv.id === this.#move);
    return [this.#cue(all, units), ...this.#filterNote(), this.#controls(all, shown.flatMap(members).length), ...bands.map((mv) => this.#band(mv, shown))];
  }

  #cue(all: Drawn[], units: Unit[]): HTMLElement {
    const line = h('h1', { class: 'cueline' });
    MOVES.forEach((mv, i) => {
      const n = units.filter((u) => unitMove(u) === mv.id).flatMap(members).length;
      const b = h('button', { type: 'button', class: `cnt${mv.id === 'yours' && n ? ' hot' : ''}`, 'data-move': mv.id, 'aria-pressed': String(this.#move === mv.id) }, h('b', {}, String(n)), ` ${mv.word}`);
      line.append(h('span', { class: 'cue-item' }, b, i < MOVES.length - 1 ? h('span', { class: 'sep', 'aria-hidden': 'true' }, ' · ') : null), i < MOVES.length - 1 ? ' ' : '');
    });
    const repos = new Set(all.map((p) => p.repo)).size;
    const oldest = units.filter((u) => unitMove(u) === 'yours').map((u) => u.lead).sort((a, b) => (b.ageDays ?? 0) - (a.ageDays ?? 0))[0];
    const short = (repo: string): string => repo.split('/')[1] ?? repo;
    return h('section', { class: 'grid pair cue' },
      h('div', { class: 'two-thirds' },
        h('span', { class: 'kicker' }, 'Open pull requests'),
        line,
        h('p', { class: 'lede' }, `${all.length} open across ${repos} ${repos === 1 ? 'repo' : 'repos'}.`,
          ...(oldest ? [' The oldest on your move is ', h('strong', {}, `${short(oldest.repo)} #${oldest.number}`), oldest.ageDays !== undefined ? `, open ${askAge(oldest.ageDays)}.` : '.'] : [])),
        h('div', { class: 'refresh-bar' }, this.#button, this.#fresh, this.#state)),
      this.#facts(all));
  }

  #facts(all: Drawn[]): HTMLElement {
    const tally = new Map<Mix, number>();
    for (const p of all) tally.set(mixOf(p), (tally.get(mixOf(p)) ?? 0) + 1);
    const bar = h('div', { class: 'mix-bar', role: 'img', 'aria-label': [...tally].map(([k, n]) => `${MIX_LABEL[k]} ${n}`).join(', ') });
    const legend = h('div', { class: 'legend' });
    for (const key of ['pass', 'pending', 'fail', 'none'] as Mix[]) {
      const n = tally.get(key) ?? 0;
      if (!n) continue;
      for (let i = 0; i < n; i += 1) bar.append(h('span', { class: key }));
      legend.append(h('span', {}, h('i', { class: key }), `${MIX_LABEL[key]} ${n}`));
    }
    return h('div', { class: 'side-facts' },
      h('div', {}, h('span', { class: 'eyebrow' }, `CI across ${all.length} PRs`), bar, legend),
      h('div', { class: 'facts' },
        h('span', { class: 'fact' }, h('b', {}, String(all.filter((p) => !p.isDraft && !p.selfReview).length)), 'ready for review'),
        h('span', { class: 'fact' }, h('b', {}, String(all.filter((p) => p.unresolved > 0).length)), 'with threads'),
        h('span', { class: 'fact' }, h('b', {}, String(all.filter((p) => p.isDraft).length)), 'drafts')));
  }

  #filterNote(): Node[] {
    if (!this.#move) return [];
    const word = MOVES.find((m) => m.id === this.#move)?.word ?? this.#move;
    return [h('div', { class: 'filter-note' }, h('span', {}, 'Showing only ', h('strong', {}, word), '.'), h('button', { type: 'button', class: 'refresh', 'data-move': this.#move }, 'Show everything'))];
  }

  #controls(all: Drawn[], shown: number): HTMLElement {
    const chips = LENSES.map((l) => h('button', {
      type: 'button', class: 'chip', 'data-lens': l.id, 'aria-pressed': String(this.#lens === l.id),
    }, l.label, ' ', h('span', { class: 'c' }, String(all.filter((p) => lensOn(p, l.id)).length))));
    return h('div', { class: 'controls' },
      h('div', { class: 'chips', role: 'group', 'aria-label': 'Narrow by state' }, ...chips),
      h('label', { class: 'search' }, h('span', { class: 'vh' }, 'Search PRs'), h('input', { type: 'search', placeholder: 'Search title, repo or number', value: this.#q })),
      h('span', { class: 'shown', 'aria-live': 'polite' }, `${shown} ${shown === 1 ? 'PR' : 'PRs'} shown`));
  }

  #band(mv: (typeof MOVES)[number], shown: Unit[]): HTMLElement {
    const ps = shown.filter((u) => unitMove(u) === mv.id);
    const byRepo = new Map<string, Unit[]>();
    for (const u of ps) byRepo.set(u.lead.repo, [...(byRepo.get(u.lead.repo) ?? []), u]);
    const repos = [...byRepo.entries()].sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]));
    const empty = this.#q || this.#lens ? ['No PR here matches.', 'rest'] as const : mv.empty;
    const body = repos.length ? repos.map(([repo, list]) => this.#repo(repo, list)) : [tacet(empty[0], empty[1])];
    return h('section', { class: 'band', id: mv.id },
      h('div', { class: 'band-head' }, h('span', { class: 'instrument', 'aria-hidden': 'true' }, mv.instrument), h('h2', {}, mv.title, ' ', h('span', { class: 'n' }, String(ps.flatMap(members).length))), h('p', {}, mv.note)),
      ...body);
  }

  #repo(repo: string, list: Unit[]): HTMLElement {
    const short = repo.split('/')[1] ?? repo;
    const stackedOn = (u: Unit): number | undefined => u.lead.stackedOn ?? u.mate?.stackedOn;
    const nums = new Set(list.flatMap(members).map((p) => p.number));
    const roots = list.filter((u) => { const n = stackedOn(u); return n === undefined || !nums.has(n); }).sort((a, b) => a.lead.number - b.lead.number);
    const kids = (u: Unit): Unit[] => list.filter((k) => { const n = stackedOn(k); return n !== undefined && members(u).some((p) => p.number === n); });
    const walk = (u: Unit, depth: number): Node[] => [this.#unit(u, short, depth > 0), ...kids(u).flatMap((k) => walk(k, depth + 1))];
    const count = list.flatMap(members).length;
    return h('div', { class: 'repo' },
      h('h3', {}, short, ' ', h('span', { class: 'c' }, `${count} ${count === 1 ? 'PR' : 'PRs'}`)),
      h('ul', { class: 'prs' }, ...roots.flatMap((u) => walk(u, 0))));
  }

  #unit(u: Unit, short: string, child: boolean): HTMLElement {
    return u.mate || u.merged ? this.#pair(u, short, child) : this.#row(u.lead, short, child);
  }

  /** A develop/staging pair as one card: the shared heading once, then a lane per PR (or a merged develop PR's lane) with its own base and gates. */
  #pair(u: Unit, short: string, child: boolean): HTMLElement {
    const dev = u.mate ? u.lead : undefined;
    const stg = u.mate ?? u.lead;
    const title = refLink({ label: (dev ?? stg).title, url: (dev ?? stg).url });
    if (title instanceof HTMLElement) title.classList.add('title');
    const lanes = [
      dev ? this.#lane(dev, 'Develop') : this.#mergedLane(u.merged),
      this.#lane(stg, 'Staging'),
    ];
    return h('li', { class: `pr pair${child ? ' child' : ''}` },
      h('div', { class: 'pr-t' }, title, h('span', { class: 'sub' },
        h('span', {}, short),
        stg.selfReview ? h('span', {}, 'self-review') : null,
        (dev ?? stg).ticket ? refLink((dev ?? stg).ticket!) : null,
        u.lead.stackedOn !== undefined ? h('span', {}, `stacked on #${u.lead.stackedOn}`) : null)),
      h('div', { class: 'lanes' }, ...lanes));
  }

  #lane(p: Drawn, name: 'Develop' | 'Staging'): HTMLElement {
    const threads: Gate = p.unresolved > 0
      ? { tone: 'warn', glyph: String(p.unresolved), word: p.unresolved === 1 ? 'Thread' : 'Threads' }
      : { tone: 'ok', glyph: '✓', word: 'None' };
    const ref = refLink({ label: `${name} #${p.number}`, url: p.url });
    return h('div', { class: `lane ${name.toLowerCase()}` },
      h('div', { class: 'lane-h' }, ref, h('span', { class: 'branch', title: `Base: ${p.base}` }, `→ ${PROTECTED.has(p.base) ? p.base : 'branch'}`), p.isDraft ? h('span', {}, 'draft') : null,
        h('span', { class: 'age' }, p.ageDays === undefined ? '' : askAge(p.ageDays))),
      h('span', { class: 'gates' }, this.#gate('CI', CI[p.ci ?? ''] ?? CI.NONE), this.#gate('Merge', MERGE[p.mergeable]), this.#gate('Review', REVIEW[p.review]), this.#gate('Threads', threads)),
      this.#approvers(p));
  }

  /** The develop PR that has merged while its staging twin is open: kept in the pair, plainly marked, with no gates because there is nothing left to do on it. */
  #mergedLane(side: Unit['merged']): HTMLElement {
    return h('div', { class: 'lane develop merged' },
      h('div', { class: 'lane-h' }, side ? refLink({ label: `Develop #${side.number}`, url: side.url }) : 'Develop', h('span', { class: 'branch' }, '→ develop'), h('span', { class: 'tag' }, 'Merged')));
  }

  #row(p: Drawn, short: string, child: boolean): HTMLElement {
    const review = REVIEW[p.review];
    const threads: Gate = p.unresolved > 0
      ? { tone: 'warn', glyph: String(p.unresolved), word: p.unresolved === 1 ? 'Thread' : 'Threads' }
      : { tone: 'ok', glyph: '✓', word: 'None' };
    const title = refLink({ label: p.title, url: p.url });
    if (title instanceof HTMLElement) title.classList.add('title');
    return h('li', { class: `pr${child ? ' child' : ''}` },
      h('div', { class: 'pr-t' }, title, h('span', { class: 'sub' },
        h('span', { class: 'num' }, `#${p.number}`),
        h('span', {}, short),
        p.selfReview ? h('span', {}, 'self-review') : null,
        p.ticket ? refLink(p.ticket) : null,
        p.stackedOn !== undefined ? h('span', {}, `stacked on #${p.stackedOn}`) : null,
        p.twins[0] !== undefined ? h('span', {}, `twin of #${p.twins[0]}`) : null,
        this.#waits(p)),
      this.#approvers(p)),
      h('span', { class: `base${p.base === 'staging' ? ' staging' : ''}`, title: `Base: ${p.base}` }, `→ ${PROTECTED.has(p.base) ? p.base : 'branch'}`),
      h('span', { class: 'gates' }, this.#gate('CI', CI[p.ci ?? ''] ?? CI.NONE), this.#gate('Merge', MERGE[p.mergeable]), this.#gate('Review', review), this.#gate('Threads', threads)),
      h('span', { class: 'age' }, p.ageDays === undefined ? '' : askAge(p.ageDays)));
  }

  /** Why a staging PR is not ready: it waits on its develop twin, linked, or none was found. Nothing for any other PR. */
  #waits(p: Drawn): Node | null {
    const w = p.waitsOnDevelop;
    if (!w) return null;
    if (w.number === undefined) return h('span', { class: 'wait' }, 'Waits on develop twin: none found');
    const link = refLink({ label: `Waits on develop twin #${w.number}`, ...(w.url ? { url: w.url } : {}) });
    if (link instanceof HTMLElement) link.classList.add('wait');
    return link instanceof HTMLElement ? link : h('span', { class: 'wait' }, link);
  }

  /** The approvers behind an approved PR, folded to a count so a long list does not push the table around. A native disclosure, so it works by keyboard. */
  #approvers(p: Drawn): Node | null {
    const who = p.review === 'approved' ? p.approvers ?? [] : [];
    if (who.length === 0) return null;
    return h('details', { class: 'appr' }, h('summary', {}, `Approved · ${who.length}`), h('ul', { 'aria-label': 'Approved by' }, ...who.map((login) => h('li', {}, login))));
  }

  #gate(name: string, g: Gate): HTMLElement {
    return h('span', { class: `gate ${g.tone}` }, h('span', { class: 'g' }, h('span', { 'aria-hidden': 'true' }, g.glyph), h('span', { class: 'vh' }, `${name}: `), g.word));
  }
}

if (!customElements.get('open-prs')) customElements.define('open-prs', OpenPrs);
declare global { interface HTMLElementTagNameMap { 'open-prs': OpenPrs } }
