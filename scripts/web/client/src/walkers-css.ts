/**
 * Styles for the music walkers: one constructable stylesheet (the page's CSP forbids style attributes). The stage is a
 * fixed strip along the bottom edge, behind everything and out of hit-testing; a walker is mounted only while it crosses.
 * The crossing itself is a Web Animation set up in walkers.ts; the gait and the little bit each walker does are CSS here.
 */

const PASTELS: Record<string, string> = {
  note: '#f4a6c0', metronome: '#8fd3bd', baton: '#b3a2ee', cello: '#f5b78f', clef: '#8cc4f0', drum: '#e9cf6f', keys: '#f3a5a0', record: '#8dd0da',
};

const FRAME = `
  :host { display: contents; }
  .stage { position: fixed; z-index: -1; inset-inline: 0; inset-block-end: 6px; height: 64px; overflow: hidden; pointer-events: none; opacity: 0.7; }
  .slot { position: absolute; inset-block-end: 0; inset-inline-start: 0; will-change: transform; }
  .slot.rtl .walker { transform: scaleX(-1); }
  .walker { display: block; fill: none; stroke: currentColor; stroke-width: 2.2; stroke-linecap: round; stroke-linejoin: round; overflow: visible; }
  .walker .dot { fill: currentColor; stroke: none; }
  .toggle {
    position: fixed; z-index: 15; inset-inline-end: var(--space-3); inset-block-end: var(--space-3); display: inline-grid; place-items: center; width: 28px; height: 28px; padding: 0;
    color: var(--text-secondary); background: var(--surface-1); border: var(--hairline-strong); border-radius: var(--radius-pill); box-shadow: var(--shadow-1); cursor: pointer;
    transition: color var(--dur-fast) var(--ease-out), border-color var(--dur-fast) var(--ease-out);
  }
  @media (hover: hover) { .toggle:hover { color: var(--text-primary); border-color: var(--text-muted); } }
  .toggle:focus-visible { outline: 2px solid var(--focus); outline-offset: 2px; }
  .toggle svg { width: 16px; height: 16px; fill: none; stroke: currentColor; stroke-width: 1.5; stroke-linecap: round; stroke-linejoin: round; }
  .toggle .slash { display: none; }
  .toggle[aria-pressed=false] .slash { display: inline; }
  /* Nothing walks on a narrow screen or under reduced motion, so the switch has nothing to switch: hide it too. */
  @media (max-width: 480px) { .stage, .toggle { display: none; } }
  @media (prefers-reduced-motion: reduce) { .stage, .toggle { display: none; } * { animation: none !important; transition: none !important; } }
  @media (prefers-color-scheme: dark) { .stage { opacity: 0.45; } }`;

const COLOURS = Object.entries(PASTELS).map(([id, c]) => `.w-${id} { color: ${c}; }`).join('\n  ');

/** Gait: every walker's parts swing about their own pivot (fill-box, top centre for legs). */
const MOTION = `
  .walker * { transform-box: fill-box; }
  .walker ellipse { transform-box: view-box; }   /* the tilted note heads rotate about an explicit point */
  .leg { transform-origin: 50% 0; animation: wk-step 0.4s ease-in-out infinite alternate; } .lb { animation-direction: alternate-reverse; }
  .bob { transform-origin: 50% 100%; animation: wk-bob 0.4s ease-in-out infinite alternate; }
  .flag { transform-origin: 0 0; animation: wk-flutter 0.8s ease-in-out infinite alternate; }
  .waddle { transform-origin: 50% 100%; animation: wk-waddle 0.5s ease-in-out infinite alternate; }
  .pend { transform-origin: 50% 100%; animation: wk-tick 0.5s ease-in-out infinite alternate; }
  .wave { transform-origin: 50% 100%; animation: wk-wave 0.6s ease-in-out infinite alternate; }
  .pn { animation: wk-hop 0.5s ease-in-out infinite alternate; } .p2 { animation-delay: 0.15s; } .p3 { animation-delay: 0.3s; }
  .bow { transform-origin: 50% 100%; animation: wk-bow 1.1s ease-in-out infinite alternate; }
  .wheel { transform-origin: 50% 50%; animation: wk-roll 0.9s linear infinite; }
  .dance { transform-origin: 50% 100%; animation: wk-dance 0.6s ease-in-out infinite alternate; }
  .arm { transform-origin: 0 100%; animation: wk-arm 0.4s ease-in-out infinite alternate; } .ab { transform-origin: 100% 100%; animation-direction: alternate-reverse; }
  .stick { transform-origin: 50% 0; animation: wk-stick 0.26s ease-in-out infinite alternate; } .sb { animation-direction: alternate-reverse; }
  .seg { animation: wk-seg 1s ease-in-out infinite; } .seg:nth-child(2) { animation-delay: 0.12s; } .seg:nth-child(3) { animation-delay: 0.24s; } .seg:nth-child(4) { animation-delay: 0.36s; } .seg:nth-child(5) { animation-delay: 0.48s; }
  .head { animation: wk-seg 1s ease-in-out 0.6s infinite; }
  .spin { transform-origin: 50% 50%; animation: wk-roll 1.9s linear infinite; }
  @keyframes wk-step { from { transform: rotate(-24deg); } to { transform: rotate(24deg); } }
  @keyframes wk-bob { to { transform: translateY(-2.5px); } }
  @keyframes wk-flutter { from { transform: skewY(-6deg); } to { transform: skewY(6deg); } }
  @keyframes wk-waddle { from { transform: rotate(-4deg); } to { transform: rotate(4deg); } }
  @keyframes wk-tick { from { transform: rotate(-24deg); } to { transform: rotate(24deg); } }
  @keyframes wk-wave { from { transform: rotate(-12deg); } to { transform: rotate(14deg); } }
  @keyframes wk-hop { to { transform: translateY(-7px); } }
  @keyframes wk-bow { from { transform: rotate(-10deg); } to { transform: rotate(8deg); } }
  @keyframes wk-roll { to { transform: rotate(360deg); } }
  @keyframes wk-dance { from { transform: rotate(-9deg) translateY(0); } to { transform: rotate(9deg) translateY(-3px); } }
  @keyframes wk-arm { from { transform: rotate(-18deg); } to { transform: rotate(18deg); } }
  @keyframes wk-stick { from { transform: rotate(-16deg); } to { transform: rotate(14deg); } }
  @keyframes wk-seg { 0%, 55%, 100% { transform: translateY(0); } 28% { transform: translateY(-6px); } }`;

export const WALKERS_CSS = [FRAME, COLOURS, MOTION].join('\n');
