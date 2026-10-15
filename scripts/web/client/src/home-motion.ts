/**
 * The motion on Home: a short entrance when Home appears, and a spring for an item that has just shipped.
 * Nothing loops, only transform and opacity change, and under reduced motion nothing moves at all.
 * The entrance is a class on the Home root that exists for one draw, so a live refresh (which rebuilds Home) never replays it.
 */

/** Cells on the score staff (one per chart day), and the rows the entrance staggers, so each stagger rule is written once here. */
const DAYS = 14;
const ROWS = 6;
/** The stagger stops growing here, so the last day of the score is not 300 ms behind the first. */
const MAX_STEPS = 8;
const STEP_MS = 24;

/** A redraw this soon after the entrance began (the projects load lands right after the first draw) replays it instead of cutting it short. */
const SETTLE_MS = 700;

const state: { armedAt: number | null; startedAt: number; seen: Set<string> | null; marked: Map<string, number> } = { armedAt: null, startedAt: -Infinity, seen: null, marked: new Map() };
let armed = true;

/** Play the entrance on the next Home draw: at page load (armed from the start) and when the reader comes back to Home. Shipped items are then judged afresh, so what shipped while away is not news. */
export function armHomeEntrance(): void {
  armed = true;
  state.seen = null;
  state.marked.clear();
}

/** True for the first draw after arming and for redraws within SETTLE_MS of it, so a quick follow-up render does not snap the entrance to its end. */
export function takeEntrance(now = Date.now()): boolean {
  if (armed) {
    armed = false;
    state.startedAt = now;
    return true;
  }
  return now - state.startedAt < SETTLE_MS;
}

/** The shipped ids to spring in: those first seen this draw, and those marked within SETTLE_MS (a redraw must not cut their arrival short). The first draw knows nothing, so it marks nothing. */
export function newlyShipped(ids: string[], now = Date.now()): Set<string> {
  const before = state.seen;
  state.seen = new Set(ids);
  if (before !== null) for (const id of ids) if (!before.has(id)) state.marked.set(id, now);
  for (const [id, at] of state.marked) if (now - at >= SETTLE_MS || !state.seen.has(id)) state.marked.delete(id);
  return new Set(state.marked.keys());
}

/** Test hook: back to a fresh page load. */
export function resetHomeMotion(): void {
  armed = true;
  state.startedAt = -Infinity;
  state.seen = null;
  state.marked.clear();
}

const stagger = (selector: (n: number) => string, count: number): string =>
  Array.from({ length: count }, (_, i) => `${selector(i + 1)} { animation-delay: ${Math.min(i, MAX_STEPS) * STEP_MS}ms; }`).join('\n  ');

export const HOME_MOTION_CSS = `
  /* Entrance. The note drops onto its line; rows rise; bars fill from the left. Each uses translate, scale and opacity only. */
  .enter .score-note { animation: note-drop var(--dur-base) var(--ease-out) backwards; }
  .enter .score-rest { animation: fade-up var(--dur-base) var(--ease-out) backwards; }
  ${stagger((n) => `.enter .score-cell:nth-child(${n}) > *`, DAYS)}
  .enter .asks > ask-card, .enter ul.shipped > li, .enter .ecard { animation: fade-up var(--dur-base) var(--ease-out) backwards; }
  ${stagger((n) => `.enter .asks > ask-card:nth-child(${n}), .enter ul.shipped > li:nth-child(${n}), .enter ul.ecards > li:nth-child(${n}) .ecard`, ROWS)}
  .enter .bars .fill, .enter .seg-bar span, .enter .cibar span { transform-origin: left center; animation: bar-fill var(--dur-slow) var(--ease-out) backwards; animation-delay: 120ms; }
  @keyframes note-drop { from { opacity: 0; translate: 0 -6px; } }
  @keyframes fade-up { from { opacity: 0; translate: 0 6px; } }
  @keyframes bar-fill { from { transform: scaleX(0); } }

  /* A shipped item that arrived since the last draw lands with a small overshoot. */
  ul.shipped > li.just-shipped { animation: arrive var(--dur-slow) var(--ease-spring) backwards; }
  @keyframes arrive { from { opacity: 0; translate: 0 -8px; scale: 0.97; } }

  /* Hover on a staff (Home's rows and a stream's big staff): its notes lift a little. A transition, so it never restarts the entrance. */
  @media (hover: hover) and (prefers-reduced-motion: no-preference) {
    .score-note { transition: translate var(--dur-base) var(--ease-spring); }
    .score-staff:hover .score-note { translate: 0 -2px; }
  }
  @media (prefers-reduced-motion: reduce) {
    .enter *, ul.shipped > li.just-shipped, .score-note { animation: none !important; transition: none !important; }
  }
`;
