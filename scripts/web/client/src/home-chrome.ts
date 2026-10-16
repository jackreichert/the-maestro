/**
 * The page's frame, as the concept sets it: a title page (the baton, the name, the date, Refresh "da capo") and under it a sticky tab bar
 * with the stream picker, a listbox of "voices". The app owns what the controls do; this draws them.
 */
import { h, s } from './dom.ts';
import { reducedMotion, sweepPlayhead } from './home-ambience.ts';
import { streamVar } from './home-concept.ts';

export const CHROME_CSS = `
  .title-page { padding-block: var(--space-6) var(--space-5); }
  .masthead { display: flex; align-items: flex-end; justify-content: space-between; gap: var(--space-4); flex-wrap: wrap; }
  .wordmark { margin: 0; display: flex; align-items: center; gap: var(--space-3); font-weight: var(--weight-regular); }
  .wordmark a { display: flex; align-items: center; gap: var(--space-3); color: inherit; text-decoration: none; padding-block: 0; border-radius: var(--radius-xs); }
  .wordmark .name { display: grid; gap: 2px; }
  .wordmark .word { font-family: var(--font-display); font-weight: var(--weight-regular); font-size: var(--text-display); line-height: 1; letter-spacing: -0.01em; }
  .wordmark .scope { font-family: var(--font-mono); font-size: var(--text-sm); line-height: var(--leading-sm); color: var(--text-muted); font-variant-numeric: tabular-nums; }
  .baton { width: 40px; height: 40px; color: var(--ink); flex: none; overflow: visible; transform-origin: 25% 80%; transition: transform var(--dur-slow) var(--ease-spring); }
  .baton .tip { fill: var(--text-muted); transform-box: fill-box; transform-origin: center; }
  .baton .tip.on { fill: var(--accent); }
  /* The tip pulses three times when the number of cues waiting changes, then rests: nothing moves on its own for more than a few seconds. */
  .baton .tip.on.pulse { animation: pulse var(--dur-breathe) ease-in-out 3; }
  .baton.lift { transform: rotate(-14deg); }
  .baton .stick { transform-box: view-box; transform-origin: 9.4px 22.6px; }
  @media (hover: hover) { .wordmark:hover .baton .stick { animation: downbeat calc(var(--dur-base) * 2.4) var(--ease-out); } }
  @keyframes downbeat { 30% { transform: rotate(-10deg); } 60% { transform: rotate(3deg); } 80% { transform: rotate(-1deg); } }
  @keyframes pulse { 0%, 100% { transform: scale(1); opacity: 1; } 50% { transform: scale(1.35); opacity: 0.75; } }
  @media (prefers-reduced-motion: reduce) { .baton, .baton .tip { animation: none !important; transition: none; } .baton.lift { transform: none; } }
  .refresh-group { display: flex; align-items: center; flex-wrap: wrap; gap: var(--space-3); }
  .refresh-group .btn[aria-disabled=true] { cursor: default; opacity: 0.7; }
  .refresh-group .btn .it { font-family: var(--font-display); font-style: italic; font-size: var(--text-md); color: var(--text-muted); font-weight: var(--weight-regular); }
  .source.wrap { padding-block: 0 var(--space-3); }

  /* The tab bar sticks under the title page; the streams are a picker beside the tabs, not a row of tabs. */
  .tabbar-wrap { position: sticky; top: 0; z-index: 20; background: var(--material-bar); -webkit-backdrop-filter: var(--material-blur); backdrop-filter: var(--material-blur); border-bottom: var(--hairline); }
  @supports not ((backdrop-filter: blur(1px)) or (-webkit-backdrop-filter: blur(1px))) { .tabbar-wrap { background: var(--surface-page); } }
  .tabbar-row { display: flex; align-items: center; gap: var(--space-3); }
  .tabbar { flex: 1 1 auto; min-width: 0; background: none; border: 0; }
  [role=tablist] { display: flex; gap: var(--space-1); overflow-x: auto; scrollbar-width: none; }
  [role=tablist]::-webkit-scrollbar { display: none; }
  .more-end [role=tablist] { mask-image: linear-gradient(to right, black calc(100% - 56px), transparent); }
  .more-start [role=tablist] { mask-image: linear-gradient(to right, transparent, black 56px); }
  .more-start.more-end [role=tablist] { mask-image: linear-gradient(to right, transparent, black 56px, black calc(100% - 56px), transparent); }
  [role=tab] { position: relative; flex: none; display: inline-flex; align-items: center; gap: var(--space-2); min-height: 48px; padding: 0 var(--space-3); border: 0; background: none; cursor: pointer; font: inherit; font-size: var(--text-sm); font-weight: var(--weight-medium); color: var(--text-secondary); white-space: nowrap; transition: color var(--dur-fast) var(--ease-out); }
  [role=tab]::after { content: ""; position: absolute; left: var(--space-3); right: var(--space-3); bottom: -1px; height: 2px; background: var(--stream-color, var(--accent)); transform: scaleX(0); transition: transform var(--dur-base) var(--ease-out); }
  [role=tab][aria-selected=true] { color: var(--text-primary); }
  [role=tab][aria-selected=true]::after { transform: scaleX(1); }
  @media (hover: hover) { [role=tab]:hover { color: var(--text-primary); } }
  [role=tab]:focus-visible { outline-offset: -2px; }
  [role=tab] .sw { display: inline-block; width: 8px; height: 8px; border-radius: 2px; background: var(--stream-color); }
  .count { margin-left: var(--space-1); color: var(--text-muted); font-family: var(--font-mono); font-size: var(--text-xs); font-variant-numeric: tabular-nums; }
  [role=tab][aria-selected=true] .count { color: var(--text-secondary); }

  .stream-pick { position: relative; flex: none; }
  .sp-sw { display: block; flex: none; width: 8px; height: 8px; border-radius: 2px; background: var(--stream-color, transparent); box-shadow: inset 0 0 0 1px var(--border-strong); }
  .sp-sw[data-on] { box-shadow: none; }
  .sp-btn { display: flex; align-items: center; gap: var(--space-2); min-height: 40px; max-width: 44vw; padding: 0 var(--space-3) 0 10px; border: 1px solid var(--border-strong); border-radius: var(--radius-sm); background: var(--surface-1); color: var(--text-secondary); font: inherit; font-size: var(--text-sm); font-weight: var(--weight-medium); cursor: pointer; transition: border-color var(--dur-fast) var(--ease-out), color var(--dur-fast) var(--ease-out); }
  .sp-btn .sp-val { display: block; min-width: 0; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
  .stream-pick[data-on] .sp-btn { color: var(--text-primary); border-color: var(--stream-color); }
  .sp-chev { display: block; flex: none; width: 6px; height: 6px; margin: -3px 0 0 2px; border-right: 1.5px solid var(--text-muted); border-bottom: 1.5px solid var(--text-muted); transform: rotate(45deg); transition: transform var(--dur-base) var(--ease-out); }
  .sp-btn[aria-expanded=true] .sp-chev { transform: translateY(3px) rotate(225deg); }
  @media (hover: hover) { .sp-btn:hover { border-color: var(--border-strong); color: var(--text-primary); } }
  .sp-menu { position: absolute; top: calc(100% + 6px); right: 0; z-index: 30; width: 300px; max-width: calc(100vw - var(--space-6)); padding: var(--space-1); border-radius: var(--radius-md); background: var(--surface-1); box-shadow: var(--shadow-2); transform-origin: top right; }
  .sp-menu[hidden] { display: none; }
  .sp-eyebrow { margin: 0; padding: var(--space-2) var(--space-3) var(--space-1); font-family: var(--font-display); font-style: italic; font-size: var(--text-md); line-height: var(--leading-md); color: var(--text-muted); }
  .sp-list { list-style: none; margin: 0; padding: 0; outline: none; }
  .sp-list:focus-visible { outline: 2px solid var(--focus); outline-offset: 2px; border-radius: var(--radius-sm); }
  .sp-opt { position: relative; display: grid; grid-template-columns: 8px minmax(0, 1fr) auto 12px; align-items: center; gap: var(--space-3); min-height: 40px; padding: 0 var(--space-3); border-radius: var(--radius-sm); color: var(--text-secondary); font-size: var(--text-sm); cursor: pointer; }
  .sp-opt.first-voice { margin-top: var(--space-1); }
  .sp-opt.first-voice::before { content: ""; position: absolute; left: var(--space-3); right: var(--space-3); top: calc(var(--space-1) * -0.5 - 0.5px); height: 1px; background: var(--border); }
  .sp-opt .sp-name { display: block; min-width: 0; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
  .sp-opt .sp-n { display: block; font-family: var(--font-mono); font-size: var(--text-xs); color: var(--text-muted); white-space: nowrap; }
  .sp-opt .sp-check { display: block; width: 12px; height: 12px; color: var(--text-primary); opacity: 0; transform: scale(0.6); transition: opacity var(--dur-fast) var(--ease-out), transform var(--dur-base) var(--ease-spring); }
  .sp-opt[aria-selected=true] { color: var(--text-primary); font-weight: var(--weight-semibold); }
  .sp-opt[aria-selected=true] .sp-check { opacity: 1; transform: scale(1); }
  .sp-opt.active { background: var(--surface-2); color: var(--text-primary); outline: 2px solid var(--focus); outline-offset: -2px; }
  .sp-opt .sp-sw { transition: transform var(--dur-base) var(--ease-spring); }
  .sp-opt.active .sp-sw { transform: scale(1.35) rotate(45deg); }
  /* The trigger names what it is ("Voice"), shows how many cues the current stream holds, and the menu says what each row is. */
  .sp-cap { display: block; flex: none; font-family: var(--font-display); font-style: italic; font-size: var(--text-md); line-height: 1; color: var(--text-muted); font-weight: var(--weight-regular); }
  .sp-count { display: block; flex: none; min-width: 20px; padding: 0 6px; border-radius: var(--radius-pill); background: var(--surface-2); color: var(--text-primary); font-family: var(--font-mono); font-size: var(--text-xs); line-height: 20px; text-align: center; font-variant-numeric: tabular-nums; }
  @media (max-width: 520px) { .sp-cap, .sp-count { display: none; } }
  .sp-opt::after { content: ""; position: absolute; left: 0; top: 8px; bottom: 8px; width: 3px; border-radius: 2px; background: var(--stream-color, var(--accent)); opacity: 0; transition: opacity var(--dur-fast) var(--ease-out); }
  .sp-opt[aria-selected=true] { background: var(--surface-2); }
  .sp-opt[aria-selected=true]::after { opacity: 1; }
  .sp-opt .sp-it { margin-left: var(--space-2); font-family: var(--font-display); font-style: italic; font-size: var(--text-md); color: var(--text-muted); font-weight: var(--weight-regular); }
  .sp-opt .sp-n.tacet { font-family: var(--font-display); font-style: italic; font-size: var(--text-md); }
  .sp-keys { margin: var(--space-1) 0 0; padding: var(--space-2) var(--space-3) var(--space-1); border-top: var(--hairline); font-size: var(--text-xs); color: var(--text-muted); }
  @media (hover: none) { .sp-keys { display: none; } }
  @media (forced-colors: active) { .sp-opt.active { outline: 2px solid Highlight; } .sp-sw { forced-color-adjust: none; outline: 1px solid CanvasText; } [role=tab][aria-selected=true]::after { forced-color-adjust: none; background: Highlight; height: 4px; } }
`;

/** The wordmark's baton, drawn with presentation attributes only (no style attribute, so the CSP holds). Its tip takes the accent while cues wait, and pulses three times when `pulse`. */
export function baton(cue: boolean, pulse = false): SVGSVGElement {
  return s('svg', { class: 'baton title-baton', viewBox: '4 4 24 24', 'aria-hidden': 'true', focusable: 'false' },
    s('g', { class: 'stick' },
      s('path', { d: 'M7.9 21.3 23.5 7.5 24.5 8.5 10.7 24.1Z', fill: 'currentColor' }),
      s('ellipse', { cx: '9.4', cy: '22.6', rx: '4.4', ry: '2.5', transform: 'rotate(-45 9.4 22.6)', fill: 'currentColor' }),
      s('circle', { class: `tip${cue ? ' on' : ''}${cue && pulse ? ' pulse' : ''}`, cx: '24', cy: '8', r: cue ? '3.4' : '1.8' })));
}

export interface MastheadOptions {
  /** The wordmark link, already wired to go Home. */
  home: HTMLElement;
  /** The line under the name: today's date. */
  /** The freshness pill and the link status, drawn by the app. */
  status: Node[];
  /** Whether Refresh can do anything (a live server). Sample data has nothing to refresh. */
  live: boolean;
  /** Check for newer data now. */
  refresh: () => Promise<void>;
}

/** The title page: the wordmark (baton, name, date) and, at the right, the data's freshness and Refresh "da capo". */
export function masthead(o: MastheadOptions): HTMLElement {
  const icon = s('svg', { width: '14', height: '14', viewBox: '0 0 16 16', 'aria-hidden': 'true' },
    s('path', { d: 'M13 4.5A6 6 0 1 0 14 9', fill: 'none', stroke: 'currentColor', 'stroke-width': '1.6', 'stroke-linecap': 'round' }),
    s('path', { d: 'M13.5 1.5v3.5H10', fill: 'none', stroke: 'currentColor', 'stroke-width': '1.6', 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }));
  const btn = h('button', { type: 'button', class: 'btn', id: 'refresh', 'aria-disabled': String(!o.live), title: o.live ? undefined : 'Sample data: there is no server to ask for newer data.' },
    icon, 'Refresh ', h('span', { class: 'it', lang: 'it' }, 'da capo'));
  btn.addEventListener('click', () => {
    // aria-disabled, not disabled, so the button keeps focus while it works and a screen reader can still find it.
    if (!o.live || btn.getAttribute('aria-busy') === 'true') return;
    const root = btn.getRootNode();
    const mark = root instanceof ShadowRoot || root instanceof Document ? root.querySelector('.title-baton') : null;
    btn.setAttribute('aria-busy', 'true');
    btn.setAttribute('aria-disabled', 'true');
    mark?.classList.add('lift');
    if (root instanceof ShadowRoot || root instanceof Document) sweepPlayhead(root);
    const settle = (): void => {
      mark?.classList.remove('lift');
      btn.removeAttribute('aria-busy');
      btn.setAttribute('aria-disabled', 'false');
      const say = root instanceof ShadowRoot || root instanceof Document ? root.querySelector('#announce') : null;
      if (say) say.textContent = 'Checked for newer data.';
    };
    // Hold the baton up for at least one beat so the gesture reads even when the answer is instant.
    const beat = new Promise<void>((ok) => { setTimeout(ok, reducedMotion() ? 0 : 420); });
    void Promise.all([o.refresh().catch(() => undefined), beat]).then(settle);
  });
  return h('header', { class: 'title-page wrap' },
    h('div', { class: 'masthead' },
      h('h1', { class: 'wordmark' }, o.home),
      h('div', { class: 'refresh-group' }, ...o.status, btn)),
    h('span', { class: 'vh', id: 'announce', 'aria-live': 'polite' }));
}

/** One option of the picker. `stream` is null for "All streams". */
export interface Voice { stream: string | null; name: string; n: number }
export interface PickerOptions { voices: Voice[]; current: string | null; pick: (stream: string | null) => void }

/** Remembered across the page's redraws, so a live update does not close the menu under the reader's hands. */
const menu = { open: false, active: 0 };
/** True while the stream menu is open, for the ambient motion to hold still. */
export const pickerOpen = (): boolean => menu.open;

/**
 * The stream picker: a button that opens a listbox of voices (All streams, then each stream with its cue count).
 * Arrow keys, Home, End and type-ahead move; Enter or Space picks; Escape closes and returns focus to the button; Tab closes.
 * Picking a voice goes to that stream's tab.
 */
/** One page-wide press listener that asks the picker now on the page; each redraw replaces the handler rather than adding a listener. */
let outsideClose: ((e: Event) => void) | null = null;
let outsideBound = false;

export function streamPicker(o: PickerOptions): HTMLElement {
  const cur = o.current;
  const idOf = (v: Voice): string => `sp-opt-${v.stream === null ? 'all' : encodeURIComponent(v.stream)}`;
  const now = o.voices.find((v) => v.stream === cur) ?? o.voices[0];
  const wrap = h('div', { class: `stream-pick${cur ? ` ${streamVar(cur)}` : ''}`, id: 'stream-pick' });
  if (cur) wrap.setAttribute('data-on', '');
  const label = h('span', { class: 'vh', id: 'stream-lbl' }, 'Voice (stream):');
  const btn = h('button', { type: 'button', class: 'sp-btn', id: 'stream-btn', 'aria-haspopup': 'listbox', 'aria-expanded': 'false', 'aria-controls': 'stream-menu', 'aria-labelledby': 'stream-lbl stream-val' },
    h('span', { class: 'sp-cap', 'aria-hidden': 'true' }, 'Voice'),
    h('span', { class: 'sp-sw', 'aria-hidden': 'true', 'data-on': cur ? '' : undefined }), h('span', { class: 'sp-val', id: 'stream-val' }, now?.name ?? 'All streams'),
    now && now.n > 0 ? h('span', { class: 'sp-count', title: `${now.n} ${now.n === 1 ? 'cue' : 'cues'} waiting` }, String(now.n), h('span', { class: 'vh' }, now.n === 1 ? ' cue waiting' : ' cues waiting')) : null,
    h('span', { class: 'sp-chev', 'aria-hidden': 'true' }));
  const list = h('ul', { class: 'sp-list', id: 'stream-list', role: 'listbox', tabindex: '-1', 'aria-labelledby': 'stream-lbl' });
  const pop = h('div', { class: 'sp-menu', id: 'stream-menu', hidden: true }, h('p', { class: 'sp-eyebrow', 'aria-hidden': 'true' }, 'Choose a voice'), list,
    h('p', { class: 'sp-keys', 'aria-hidden': 'true' }, '\u2191 \u2193 move \u00b7 Enter choose \u00b7 Esc close'));
  const opts = o.voices.map((v, i) => {
    const li = h('li', { class: `sp-opt${i === 1 ? ' first-voice' : ''}${v.stream ? ` ${streamVar(v.stream)}` : ''}`, role: 'option', id: idOf(v), 'aria-selected': String(v.stream === cur) },
      h('span', { class: 'sp-sw', 'data-on': v.stream ? '' : undefined, 'aria-hidden': 'true' }), h('span', { class: 'sp-name' }, v.name, v.stream === null ? h('i', { class: 'sp-it', lang: 'it', 'aria-hidden': 'true' }, 'tutti') : null),
      v.n ? h('span', { class: 'sp-n' }, String(v.n), h('span', { class: 'vh' }, v.n === 1 ? ' cue' : ' cues')) : h('span', { class: 'sp-n tacet' }, h('span', { 'aria-hidden': 'true' }, 'tacet'), h('span', { class: 'vh' }, 'no cues')),
      s('svg', { class: 'sp-check', viewBox: '0 0 12 12', 'aria-hidden': 'true' }, s('path', { d: 'M2.5 6.4 5 8.8 9.6 3.4', fill: 'none', stroke: 'currentColor', 'stroke-width': '1.6', 'stroke-linecap': 'round', 'stroke-linejoin': 'round' })));
    li.addEventListener('click', () => choose(v));
    li.addEventListener('pointermove', () => setActive(i, false));
    return li;
  });
  list.append(...opts);

  function setActive(i: number, scroll = true): void {
    menu.active = (i + opts.length) % opts.length;
    opts.forEach((el, k) => el.classList.toggle('active', k === menu.active));
    const at = opts[menu.active];
    if (at) { list.setAttribute('aria-activedescendant', at.id); if (scroll) at.scrollIntoView({ block: 'nearest' }); }
  }
  function open(): void {
    if (menu.open && !pop.hidden) return;
    menu.open = true;
    pop.hidden = false;
    btn.setAttribute('aria-expanded', 'true');
    setActive(Math.max(0, o.voices.findIndex((v) => v.stream === cur)));
    list.focus();
    if (reducedMotion()) return;
    pop.animate([{ opacity: 0, transform: 'translateY(-4px) scale(0.97)' }, { opacity: 1, transform: 'none' }], { duration: 180, easing: 'cubic-bezier(0.23, 1, 0.32, 1)' });
    opts.forEach((el, k) => el.animate([{ opacity: 0, transform: 'translateY(-3px)' }, { opacity: 1, transform: 'none' }], { duration: 180, delay: 30 * k, easing: 'cubic-bezier(0.23, 1, 0.32, 1)', fill: 'backwards' }));
  }
  function close(refocus: boolean): void {
    if (!menu.open) return;
    menu.open = false;
    btn.setAttribute('aria-expanded', 'false');
    list.removeAttribute('aria-activedescendant');
    if (refocus) btn.focus();
    if (reducedMotion()) { pop.hidden = true; return; }
    const out = pop.animate([{ opacity: 1, transform: 'none' }, { opacity: 0, transform: 'translateY(-2px) scale(0.98)' }], { duration: 120, easing: 'cubic-bezier(0.5, 0, 0.75, 0)' });
    out.addEventListener('finish', () => { if (!menu.open) pop.hidden = true; });
  }
  function choose(v: Voice): void { close(false); if (v.stream !== cur) o.pick(v.stream); else btn.focus(); }

  btn.addEventListener('click', () => (menu.open ? close(true) : open()));
  btn.addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    e.preventDefault();
    open();
    if (e.key === 'ArrowUp') setActive(opts.length - 1);
  });
  list.addEventListener('keydown', (e) => {
    const at = o.voices[menu.active];
    if (e.key === 'ArrowDown') setActive(menu.active + 1);
    else if (e.key === 'ArrowUp') setActive(menu.active - 1);
    else if (e.key === 'Home') setActive(0);
    else if (e.key === 'End') setActive(opts.length - 1);
    else if ((e.key === 'Enter' || e.key === ' ') && at) choose(at);
    else if (e.key === 'Escape') close(true);
    else if (e.key === 'Tab') { close(false); return; }
    else if (e.key.length === 1 && /\S/.test(e.key) && !e.metaKey && !e.ctrlKey && !e.altKey) {
      // Type-ahead: the next voice whose name starts with that letter.
      const k = e.key.toLowerCase();
      const hit = o.voices.map((_, j) => (menu.active + 1 + j) % opts.length).find((j) => o.voices[j]?.name.toLowerCase().startsWith(k));
      if (hit !== undefined) setActive(hit);
    } else return;
    e.preventDefault();
  });
  // A press anywhere outside closes it. The page is a shadow tree, so ask the event's path, not its (retargeted) target.
  outsideClose = (e: Event): void => { if (wrap.isConnected && !e.composedPath().includes(wrap)) close(false); };
  if (!outsideBound) { outsideBound = true; document.addEventListener('pointerdown', (e) => outsideClose?.(e)); }

  wrap.append(label, btn, pop);
  // A redraw while the menu was open puts it back open, with focus on the list (after this element is in the page).
  if (menu.open) {
    pop.hidden = false;
    btn.setAttribute('aria-expanded', 'true');
    setActive(menu.active, false);
    queueMicrotask(() => { if (wrap.isConnected) list.focus(); else menu.open = false; });
  }
  return wrap;
}

