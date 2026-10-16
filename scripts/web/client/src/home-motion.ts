/**
 * The motion on Home: a short entrance when Home appears, and a spring for an item that has just shipped.
 * Nothing loops, only transform and opacity change, and under reduced motion nothing moves at all.
 * The entrance is a class on the Home root for the first draw after arming and for redraws within a short settle window, so a quick follow-up render does not cut it short and a later live refresh (which rebuilds Home) does not replay it. takeEntrance and newlyShipped advance that state on purpose: each Home draw is the unit.
 */

/** An item's entrance is delayed by its place in its list (the page sets --i on it), and the delay stops growing here, so the last day of the score is not 300 ms behind the first. */
const MAX_STEPS = 8;

/** A redraw this soon after the entrance began (the projects load lands right after the first draw) replays it instead of cutting it short. */
const SETTLE_MS = 700;

interface MotionState { armed: boolean; startedAt: number; seen: Set<string> | null; marked: Map<string, number> }
const fresh = (): MotionState => ({ armed: true, startedAt: -Infinity, seen: null, marked: new Map() });
let state = fresh();

/** Play the entrance on the next Home draw: at page load (armed from the start) and when the reader comes back to Home. Shipped items are then judged afresh, so what shipped while away is not news. */
export function armHomeEntrance(): void {
  state = { ...fresh(), armed: true, startedAt: state.startedAt };
}

/** True for the first draw after arming and for redraws within SETTLE_MS of it, so a quick follow-up render does not snap the entrance to its end. */
export function takeEntrance(now = Date.now()): boolean {
  if (state.armed) {
    state.armed = false;
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
  state = fresh();
}

export const HOME_MOTION_CSS = `
  /* Entrance. A note drops onto its line; rows rise; bars fill from the left. Each uses translate, scale and opacity only. */
  .enter .staff-svg .note { animation: note-drop var(--dur-base) var(--ease-out) backwards; animation-delay: calc(min(var(--i), ${MAX_STEPS}) * var(--stagger)); }
  .enter .crow, .enter .mvt { animation: fade-up var(--dur-base) var(--ease-out) backwards; animation-delay: calc(min(var(--i), ${MAX_STEPS}) * var(--stagger)); }
  .enter .bars .fill, .enter .cibar span, .enter .qbar span, .enter .mix-bar span:not(.mix-target) { transform-origin: left center; animation: bar-fill var(--dur-slow) var(--ease-out) backwards; animation-delay: 120ms; }
  @keyframes note-drop { from { opacity: 0; translate: 0 -6px; } }
  @keyframes fade-up { from { opacity: 0; translate: 0 6px; } }
  @keyframes bar-fill { from { transform: scaleX(0); } }

  /* Hover on a staff: its notes lift a little. A transition, so it never restarts the entrance. */
  @media (hover: hover) and (prefers-reduced-motion: no-preference) {
    .staff-svg .note { transition: translate var(--dur-base) var(--ease-spring); }
    .staff-svg:hover .note { translate: 0 -2px; }
  }
  @media (prefers-reduced-motion: reduce) {
    .enter *, .crow.new, .staff-svg .note { animation: none !important; transition: none !important; }
  }
`;
