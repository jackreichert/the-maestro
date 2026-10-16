/**
 * Small gestures that make the score feel played: the playhead sweeping the staves, a drum roll under the pointer, the metronome's
 * tick-tock, a note flying to the coda when a cue is answered, and an occasional single glyph that stirs on its own.
 * Every one is a Web Animations call on transform or opacity, none is needed to read the page, and all of them stand down
 * under reduced motion. The self-started ones are bounded: the ambient beats stop after AMBIENT_BEATS in one page load, and the
 * baton's pulse runs three cycles when the number of asks that need you changes, then rests (WCAG 2.2.2: nothing moves for more than five seconds on its own).
 */

/** Ambient beats in one page load. A few small gestures in the first twenty seconds or so, then the page is still. */
export const AMBIENT_BEATS = 5;
const AMBIENT_MIN_MS = 1800;
const AMBIENT_MAX_MS = 4600;
const EASE_OUT = 'cubic-bezier(0.23, 1, 0.32, 1)';

export const reducedMotion = (): boolean => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;

const hop = (dist: number): Keyframe[] => [{ transform: 'translateY(0)' }, { transform: `translateY(${dist}px)`, offset: 0.4 }, { transform: 'translateY(0)' }];
const tilt = (deg: number): Keyframe[] => [{ transform: 'rotate(0)' }, { transform: `rotate(${deg}deg)`, offset: 0.4 }, { transform: `rotate(${-deg / 3}deg)`, offset: 0.75 }, { transform: 'rotate(0)' }];
const swell = (k: number): Keyframe[] => [{ transform: 'scale(1)' }, { transform: `scale(${k})`, offset: 0.4 }, { transform: 'scale(1)' }];

/** Make an SVG element scale and rotate about its own centre (CSSOM, so the page's style rule holds). */
const aboutCentre = (el: Element): void => {
  if (el instanceof SVGElement) { el.style.transformBox = 'fill-box'; el.style.transformOrigin = 'center'; }
};

// ---- The baton's pulse ----

let pulsedFor = -1;
/** True when the baton's tip should pulse: the first draw with asks waiting, and again only when their number changes. The pulse itself is three cycles in CSS. */
export function shouldPulse(waiting: number): boolean {
  const go = waiting > 0 && waiting !== pulsedFor;
  pulsedFor = waiting;
  return go;
}

// ---- Playhead ----

let lastSweep = -Infinity;
/** Sweep the playhead across the staves once. A call within 1.5 s of the last (a follow-up draw) does nothing, so one entrance is one sweep. */
export function sweepPlayhead(root: ParentNode, now = Date.now()): void {
  if (reducedMotion() || now - lastSweep < 1500) return;
  const head = root.querySelector<HTMLElement>('.playhead');
  const staves = root.querySelector<HTMLElement>('.staves');
  if (!head || !staves) return;
  lastSweep = now;
  const w = staves.getBoundingClientRect().width;
  head.animate([
    { transform: 'translateX(0)', opacity: 0 },
    { opacity: 0.9, offset: 0.1 },
    { opacity: 0.9, offset: 0.85 },
    { transform: `translateX(${Math.max(0, w - 2)}px)`, opacity: 0 },
  ], { duration: 400, easing: 'cubic-bezier(0.77, 0, 0.175, 1)' });
}

// ---- Under the pointer ----

/** A day's roll on the deck: its dots pop bottom to top, then the crosses tap, 30 ms apart. Does not stack on itself. */
export function drumRoll(day: Element): void {
  if (reducedMotion() || day.getAnimations({ subtree: true }).some((an) => an.id === 'roll')) return;
  [...day.querySelectorAll('.hit'), ...day.querySelectorAll('.x')].forEach((el, k) => {
    aboutCentre(el);
    el.animate(el.classList.contains('x') ? tilt(30) : swell(1.7), { duration: 260, delay: k * 30, easing: EASE_OUT }).id = 'roll';
  });
}

/** The metronome plays a few beats: the pendulum swings either side of its reading, the tick it passes lights up, and the swing dies away to the true value. */
export function tickTock(pendulum: Element, ticks: Element[], angle: number): void {
  if (reducedMotion() || pendulum.getAnimations().some((an) => an.id === 'ticktock')) return;
  const amp = [16, -13, 9, -5, 2];
  const frames: Keyframe[] = [{ transform: `rotate(${angle}deg)` }, ...amp.map((d) => ({ transform: `rotate(${angle + d}deg)` })), { transform: `rotate(${angle}deg)` }];
  pendulum.animate(frames, { duration: 1100, easing: 'ease-in-out' }).id = 'ticktock';
  amp.forEach((d, k) => setTimeout(() => {
    const at = ticks[Math.max(0, Math.min(ticks.length - 1, Math.round((angle + d + 42) / 10.5)))];
    at?.classList.add('lit');
    setTimeout(() => at?.classList.remove('lit'), 180);
  }, (k + 1) * (1100 / (amp.length + 1))));
}

// ---- An answered cue sends a note to the coda ----

/** One note head arcs from an answered cue to the coda sign, so the answer is seen to land there. A no-op without room to fly or under reduced motion. */
export function flyNote(from: Element, to: Element | null): void {
  if (reducedMotion() || !to) return;
  const a = from.getBoundingClientRect();
  const b = to.getBoundingClientRect();
  if (a.width === 0 || b.width === 0) return;
  const note = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  note.setAttribute('viewBox', '0 0 14 14');
  note.setAttribute('aria-hidden', 'true');
  note.classList.add('flying-note');
  const head = document.createElementNS('http://www.w3.org/2000/svg', 'ellipse');
  for (const [k, v] of Object.entries({ cx: '7', cy: '8', rx: '4.6', ry: '3.2', transform: 'rotate(-20 7 8)', fill: 'currentColor' })) head.setAttribute(k, v);
  note.append(head);
  const root = from.getRootNode();
  (root instanceof ShadowRoot ? root : document.body).append(note);
  const dx = b.left + b.width / 2 - (a.left + 20);
  const dy = b.top + b.height / 2 - (a.top + 20);
  note.style.left = `${a.left + 13}px`;
  note.style.top = `${a.top + 13}px`;
  const fly = note.animate([
    { transform: 'translate(0, 0) scale(1)', opacity: 1 },
    { transform: `translate(${dx * 0.5}px, ${Math.min(dy, 0) * 0.5 - 60}px) scale(1.2)`, opacity: 1, offset: 0.5 },
    { transform: `translate(${dx}px, ${dy}px) scale(0.8)`, opacity: 0.2 },
  ], { duration: 640, easing: 'cubic-bezier(0.45, 0, 0.2, 1)' });
  fly.addEventListener('finish', () => {
    note.remove();
    to.animate(swell(1.4), { duration: 320, easing: EASE_OUT });
  });
  fly.addEventListener('cancel', () => note.remove());
}

// ---- The score breathes ----

interface Effect { sel: string; frames: (el: Element) => Keyframe[]; ms: number; weight: number; centre?: boolean; pseudo?: string; easing?: string }
const EFFECTS: Effect[] = [
  { sel: '.staff-row:not(.dim) .staff-svg .note', centre: true, frames: () => hop(-2.5), ms: 420, weight: 4 },
  { sel: '.metro .pend', ms: 1200, weight: 2, easing: 'ease-in-out', frames: (el) => {
    const a = Number((el as HTMLElement).dataset.angle ?? 0);
    return [{ transform: `rotate(${a}deg)` }, { transform: `rotate(${a + 5}deg)`, offset: 0.25 }, { transform: `rotate(${a - 3}deg)`, offset: 0.55 }, { transform: `rotate(${a + 1}deg)`, offset: 0.8 }, { transform: `rotate(${a}deg)` }];
  } },
  { sel: '.tacet svg', frames: () => tilt(-10), ms: 480, weight: 2 },
  { sel: '.fermata-glyph circle', centre: true, frames: () => swell(1.5), ms: 420, weight: 1 },
  { sel: '#coda-glyph', frames: () => tilt(14), ms: 480, weight: 1 },
  { sel: '.dyn-mark > span[aria-hidden]', frames: () => swell(1.14), ms: 400, weight: 2 },
  { sel: '.perc-svg .hit', centre: true, frames: () => swell(1.6), ms: 360, weight: 3 },
  { sel: '.perc-svg .x', centre: true, frames: () => tilt(25), ms: 360, weight: 2 },
  { sel: '.rmark', frames: () => tilt(-6), ms: 420, weight: 2 },
  { sel: '.roman', frames: () => hop(-2), ms: 400, weight: 1 },
  { sel: '.measures span.f', pseudo: '::after', ms: 420, weight: 2, frames: () => [{ transform: 'rotate(-20deg) scale(1)' }, { transform: 'rotate(-20deg) translateY(-2px) scale(1.2)', offset: 0.4 }, { transform: 'rotate(-20deg) scale(1)' }] },
  { sel: '.fine svg', frames: () => swell(1.12), ms: 420, weight: 1 },
  { sel: '.title-baton', frames: () => tilt(-5), ms: 520, weight: 1 },
];

const onScreen = (el: Element): boolean => {
  const r = el.getBoundingClientRect();
  return r.width > 0 && r.bottom > 0 && r.top < innerHeight && r.right > 0 && r.left < innerWidth;
};
const pick = <T extends { weight: number }>(xs: T[]): T => {
  let n = Math.random() * xs.reduce((t, x) => t + x.weight, 0);
  for (const x of xs) { n -= x.weight; if (n <= 0) return x; }
  return xs[xs.length - 1] as T;
};

/** One ambient beat: a weighted-random on-screen glyph does one small thing. Returns false when nothing was played (paused, or nothing in view). */
export function ambientBeat(root: ParentNode, paused: () => boolean): boolean {
  if (document.hidden || reducedMotion() || paused()) return false;
  // Only effects with a glyph in view are candidates, so a beat is never spent off-screen.
  const live = EFFECTS.map((fx) => ({ ...fx, els: [...root.querySelectorAll(fx.sel)].filter(onScreen) })).filter((fx) => fx.els.length > 0);
  if (live.length === 0) return false;
  const fx = pick(live);
  const el = fx.els[Math.floor(Math.random() * fx.els.length)];
  if (!el || el.getAnimations().some((an) => an.id === 'ambient' && an.playState === 'running')) return false;
  if (fx.centre) aboutCentre(el);
  try {
    el.animate(fx.frames(el), { duration: fx.ms, easing: fx.easing ?? EASE_OUT, pseudoElement: fx.pseudo }).id = 'ambient';
    return true;
  } catch { return false; }   // a browser without pseudo-element animation skips that beat
}

/** Start the ambient beats on `root`; they stop by themselves after AMBIENT_BEATS, or when the returned function is called. `paused` is asked before each beat (typing, an open menu). */
export function startAmbience(root: ParentNode, paused: () => boolean = () => false, budget = AMBIENT_BEATS): () => void {
  let left = budget;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const next = (): void => {
    if (left <= 0) return;
    timer = setTimeout(() => { if (ambientBeat(root, paused)) left -= 1; next(); }, AMBIENT_MIN_MS + Math.random() * (AMBIENT_MAX_MS - AMBIENT_MIN_MS));
  };
  next();
  return () => clearTimeout(timer);
}

export const AMBIENCE_CSS = `
  .flying-note { position: fixed; z-index: 20; width: 14px; height: 14px; pointer-events: none; color: var(--accent); }
  .playhead { will-change: transform, opacity; }
  @media (prefers-reduced-motion: reduce) { .flying-note, .playhead { display: none; } }
`;
