/**
 * <podium-walkers>: every minute or two a small line-art music character walks in from one page edge, crosses along
 * the bottom behind the content, and leaves by the other. Decorative only: out of hit-testing, hidden from assistive
 * tech, absent under reduced motion and on narrow screens, stopped in a background tab. When nothing is walking the page holds no walker at all.
 * The one control is a small toggle (aria-pressed) that remembers its state in localStorage.
 */

import { h, s, shadow } from './dom.ts';
import { WALKERS_CSS } from './walkers-css.ts';
import { buildWalker } from './walkers-art.ts';
import { WalkerScheduler, loadEnabled, pickDirection, saveEnabled, walkerById } from './walkers-model.ts';
import type { Direction, KeyValueStore, Walker } from './walkers-model.ts';

const REDUCED = '(prefers-reduced-motion: reduce)';
const NARROW = '(max-width: 480px)';   // no stage there (walkers-css.ts), so nothing is scheduled either

/** localStorage, or null where the browser refuses even to hand it over (some privacy modes). */
function storage(): KeyValueStore | null {
  try { return window.localStorage; } catch { return null; }
}

/** The toggle's icon: an eighth note, slashed while the walkers are off. */
function noteIcon(): SVGSVGElement {
  return s('svg', { viewBox: '0 0 16 16', 'aria-hidden': 'true', focusable: 'false' },
    s('path', { d: 'M6 11.5V3l6-1.5v8.5' }), s('circle', { cx: '4.4', cy: '11.6', r: '1.9' }), s('circle', { cx: '10.4', cy: '10.1', r: '1.9' }),
    s('path', { class: 'slash', d: 'M2 14L14 2' }));
}

export class PodiumWalkers extends HTMLElement {
  readonly #root: ShadowRoot;
  readonly #stage = h('div', { class: 'stage', 'aria-hidden': 'true' });
  readonly #toggle = h('button', { type: 'button', class: 'toggle', 'aria-label': 'Wandering music characters', 'aria-pressed': 'true', title: 'Wandering music characters' }, noteIcon());
  readonly #store = storage();
  readonly #reduced = window.matchMedia(REDUCED);
  readonly #narrow = window.matchMedia(NARROW);
  #enabled = loadEnabled(this.#store);
  #scheduler: WalkerScheduler | null = null;
  #current: { slot: HTMLElement; anim: Animation } | null = null;

  readonly #recheck = (): void => this.#scheduler?.refresh();
  readonly #flip = (): void => {
    this.#enabled = !this.#enabled;
    saveEnabled(this.#store, this.#enabled);
    this.#syncToggle();
    this.#scheduler?.refresh();
  };
  // Another tab flipped the switch.
  readonly #onStorage = (): void => { this.#enabled = loadEnabled(this.#store); this.#syncToggle(); this.#scheduler?.refresh(); };

  constructor() {
    super();
    this.#root = shadow(this, WALKERS_CSS);
    this.#root.append(this.#stage, this.#toggle);
    this.#syncToggle();
  }

  connectedCallback(): void {
    // The dev hook: ?walker=<id> repeats that one walker so it can be watched; anything else is the normal schedule.
    const preview = walkerById(new URLSearchParams(location.search).get('walker'));
    this.#scheduler = new WalkerScheduler({
      random: () => Math.random(),
      setTimer: (fn, ms) => window.setTimeout(fn, ms),
      clearTimer: (handle) => window.clearTimeout(handle as number),
      hidden: () => document.hidden,
      reducedMotion: () => this.#reduced.matches || this.#narrow.matches,
      enabled: () => this.#enabled,
    }, { play: (w) => this.#walk(w, pickDirection(Math.random())), stop: () => this.#clear() }, preview);
    this.#toggle.addEventListener('click', this.#flip);
    document.addEventListener('visibilitychange', this.#recheck);
    this.#reduced.addEventListener('change', this.#recheck);
    this.#narrow.addEventListener('change', this.#recheck);
    window.addEventListener('storage', this.#onStorage);
    if (preview) this.#scheduler.playNow(preview);
    else this.#scheduler.refresh();
  }

  disconnectedCallback(): void {
    this.#scheduler?.stop();
    this.#scheduler = null;
    this.#clear();
    this.#toggle.removeEventListener('click', this.#flip);
    document.removeEventListener('visibilitychange', this.#recheck);
    this.#reduced.removeEventListener('change', this.#recheck);
    this.#narrow.removeEventListener('change', this.#recheck);
    window.removeEventListener('storage', this.#onStorage);
  }

  #syncToggle(): void { this.#toggle.setAttribute('aria-pressed', String(this.#enabled)); }

  /** Mount the walker just off one edge and slide it to just off the other; a browser without Web Animations shows nothing. */
  #walk(walker: Walker, dir: Direction): void {
    this.#clear();
    const { svg, width } = buildWalker(walker.id);
    const slot = h('div', { class: dir === 'rtl' ? 'slot rtl' : 'slot' }, svg);
    if (typeof slot.animate !== 'function') return;
    this.#stage.append(slot);
    const edge = this.#stage.clientWidth || window.innerWidth;
    const [from, to] = dir === 'ltr' ? [-width, edge] : [edge, -width];
    const anim = slot.animate([{ transform: `translateX(${from}px)` }, { transform: `translateX(${to}px)` }], { duration: walker.ms, easing: 'linear', fill: 'forwards' });
    this.#current = { slot, anim };
  }

  #clear(): void {
    this.#current?.anim.cancel();
    this.#current?.slot.remove();
    this.#current = null;
  }
}

if (!customElements.get('podium-walkers')) customElements.define('podium-walkers', PodiumWalkers);
