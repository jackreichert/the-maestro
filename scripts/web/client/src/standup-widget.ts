/**
 * Libretto: the standup, written from the ledger, ready to paste. A days-back control widens the window (Monday opens on Friday to Sunday),
 * Refresh reads the ledger again in place, Copy puts the text on the clipboard. The text is team-safe by the server; here it is only shown as text.
 */
import { h } from './dom.ts';
import { conceptSection } from './home-concept.ts';
import { loadStandup } from './api.ts';
import type { StandupData } from './types.ts';

export const STANDUP_CSS = `
  .su-controls { display: flex; flex-wrap: wrap; align-items: center; gap: var(--space-3); margin: 0 0 var(--space-4); }
  .su-days { display: inline-flex; align-items: center; gap: var(--space-2); font-size: var(--text-sm); color: var(--text-secondary); }
  .su-days input { width: 4.5em; min-height: 36px; padding: 0 var(--space-3); border: 1px solid var(--border-strong); border-radius: var(--radius-sm); background: transparent; color: var(--text-primary); font: inherit; font-family: var(--font-mono); font-variant-numeric: tabular-nums; }
  .su-days input[aria-invalid="true"] { border-color: var(--critical); }
  .su-status { margin: 0; font-size: var(--text-sm); color: var(--text-muted); }
  .su-status.bad { color: var(--critical); }
  .su-text { margin: 0; padding: var(--space-4); max-height: 28rem; overflow: auto; border-radius: var(--radius-sm); background: var(--surface-2); color: var(--text-primary); font-family: var(--font-mono); font-size: var(--text-sm); line-height: var(--leading-sm); white-space: pre-wrap; overflow-wrap: anywhere; }
  .su-text.busy { opacity: 0.55; transition: opacity var(--dur-fast) var(--ease-out); }
  .btn[disabled] { opacity: 0.5; cursor: default; }
`;

export interface StandupDeps { load: (days?: number) => Promise<StandupData>; copy: (text: string) => Promise<void> }
const realDeps = (): StandupDeps => ({ load: loadStandup, copy: (t) => (typeof navigator === 'undefined' || !navigator.clipboard ? Promise.reject(new Error('no clipboard')) : navigator.clipboard.writeText(t)) });

/** What the reader last chose and got, kept at module level so a redraw of Home keeps the days and the text instead of asking again. */
const kept: { days: number | null; data: StandupData | null } = { days: null, data: null };
export const resetStandup = (): void => { kept.days = null; kept.data = null; };

const MIN = 1;
const MAX = 14;
const rangeLabel = (d: StandupData): string => (d.from === d.to ? d.from : `${d.from} to ${d.to}`);

/** The widget. It reads the standup on first draw (or reuses the one already read) and redraws only its own text, so the page does not move. */
export function standupWidget(deps: StandupDeps = realDeps()): HTMLElement {
  let seq = 0;
  const input = h('input', { id: 'standup-days', type: 'number', min: String(MIN), max: String(MAX), step: '1', inputmode: 'numeric', 'aria-describedby': 'standup-status' });
  const refresh = h('button', { type: 'button', class: 'btn' }, 'Refresh');
  const copy = h('button', { type: 'button', class: 'btn' }, 'Copy');
  const status = h('p', { class: 'su-status', id: 'standup-status', role: 'status' });
  const pre = h('pre', { class: 'su-text', tabindex: '0', 'aria-label': 'Standup text' });
  const hint = h('span', {});
  const section = conceptSection('libretto full', { instrument: 'Libretto', title: 'Standup', hint },
    h('div', { class: 'su-controls' }, h('label', { class: 'su-days', for: 'standup-days' }, 'Days back', input), refresh, copy, status), pre);

  const say = (text: string, bad = false): void => { status.textContent = text; status.className = bad ? 'su-status bad' : 'su-status'; };
  const show = (d: StandupData): void => {
    pre.textContent = d.lines.join('\n');
    input.value = String(d.days);
    hint.textContent = `${rangeLabel(d)}. Written from the ledger; no ids.`;
    copy.disabled = false;
  };
  const days = (): number | null => {
    const n = input.value.trim() === '' ? null : Number(input.value);
    const ok = n !== null && Number.isInteger(n) && n >= MIN && n <= MAX;
    input.setAttribute('aria-invalid', ok ? 'false' : 'true');
    if (!ok) say(`Days back is a whole number from ${MIN} to ${MAX}.`, true);
    return ok ? n : null;
  };
  const read = async (n: number | undefined): Promise<void> => {
    const mine = ++seq;
    refresh.disabled = true;
    pre.classList.add('busy');
    say('Reading the ledger…');
    try {
      const d = await deps.load(n);
      if (mine !== seq) return;   // a newer request is in flight: this answer is stale
      kept.days = d.days; kept.data = d;
      show(d);
      say('Up to date.');
    } catch {
      if (mine !== seq) return;
      say('Could not read the standup. Refresh to try again.', true);
    } finally {
      if (mine === seq) { refresh.disabled = false; pre.classList.remove('busy'); }
    }
  };

  const readShown = (): void => { const n = days(); if (n !== null) void read(n); };
  refresh.addEventListener('click', readShown);
  input.addEventListener('change', readShown);
  input.addEventListener('keydown', (e) => { if ((e as KeyboardEvent).key === 'Enter') readShown(); });
  copy.addEventListener('click', () => {
    deps.copy(pre.textContent ?? '').then(() => say('Copied. Paste it into Slack.'), () => say('Could not copy. Select the text and copy it.', true));
  });

  copy.disabled = true;
  if (kept.data) { show(kept.data); say('Refresh to read the ledger again.'); } else void read(kept.days ?? undefined);
  return section;
}
