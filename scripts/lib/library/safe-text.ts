/** Page text that is copied out of a page (into INDEX.md or a dispatch brief): normalised first, then scanned, and only the normalised text is emitted. */
import { scanText as scanPage, MAX_LINE } from './scan.ts';
import { scanText as scanShared } from '../secret-scan.ts';

/** What stands in for a line that fails the scan. library-check names the page and the rule; this line never repeats the match. */
export const WITHHELD = '(withheld: fails the secret scan, run library-check)';

/**
 * One line of plain text: whitespace squeezed, zero-width, format and control characters dropped, and comment delimiters removed
 * (`<!--` dropped, `-->` written as `arrow`) until nothing changes, so a delimiter cannot be rebuilt from the pieces left behind
 * (`<!<!---->--`) and a token cannot be split by one (`ghp_<!---->...`). Normalising twice gives the same text as once.
 */
export function neutralise(raw: string, arrow = '\u2192'): string {
  let t = raw;
  for (;;) {
    const next = t.replace(/[\p{Cf}\p{Cc}]/gu, (c) => (/\s/.test(c) ? ' ' : '')).replace(/\s+/g, ' ').replace(/<!--/g, '').replace(/-->/g, arrow);
    if (next === t) return t.trim();
    t = next;
  }
}

/** The normalised text, clipped to `max` characters, unless either scanner (the library's own and the shared one) finds a secret or PHI shape in it (before or after the clip), or it is too long to scan. */
export function safeLine(raw: string, max: number): string {
  if (raw.length > MAX_LINE) return WITHHELD;
  const t = neutralise(raw);
  const out = t.length > max ? `${t.slice(0, max - 1)}\u2026` : t;
  // Scanned as emitted, before the clip, with the delimiters gone entirely (what a token split by one really is), and with every delimiter character gone (a split that leaves a stray `>` or `-` in the middle).
  const bare = neutralise(raw, '');
  return [bare, bare.replace(/[<>!-]/g, ''), t, out].some((x) => scanPage(x).length || scanShared(x).length) ? WITHHELD : out;
}
