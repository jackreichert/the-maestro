// Run: node --test scripts/web/client/test/theme-contrast.test.ts
// Reads the colour tokens out of theme.css (light, then the dark override) and checks every pair the components use
// against WCAG 2.2 AA: 4.5:1 for text, 3:1 for the focus ring and control outlines (non-text contrast, 1.4.11).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const css = readFileSync(new URL('../theme.css', import.meta.url), 'utf8');

/** The hex custom properties declared directly in a block of CSS. */
function hexTokens(block: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const m of block.matchAll(/(--[\w-]+)\s*:\s*(#[0-9a-f]{6})\s*;/gi)) out.set(m[1], m[2].toLowerCase());
  return out;
}

/** The body of the first `{ ... }` block after `start`, braces balanced. */
function blockAfter(text: string, start: number): string {
  const open = text.indexOf('{', start);
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    if (text[i] === '{') depth++;
    if (text[i] === '}' && --depth === 0) return text.slice(open + 1, i);
  }
  throw new Error('unbalanced braces in theme.css');
}

function modes(): { light: Map<string, string>; dark: Map<string, string> } {
  const light = hexTokens(blockAfter(css, css.indexOf(':root')));
  const darkAt = css.indexOf('prefers-color-scheme: dark');
  assert.ok(darkAt > 0, 'theme.css has a dark mode block');
  const dark = new Map([...light, ...hexTokens(blockAfter(css, darkAt))]);
  return { light, dark };
}

function luminance(hex: string): number {
  const ch = [1, 3, 5].map((i) => Number.parseInt(hex.slice(i, i + 2), 16) / 255)
    .map((c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * ch[0] + 0.7152 * ch[1] + 0.0722 * ch[2];
}

function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

const SURFACES = ['--surface-page', '--surface-1', '--surface-2'];
const TEXT_ON_SURFACES = ['--text-primary', '--text-secondary', '--text-muted', '--accent', '--critical', '--success', '--warning'];
/** [foreground, background] text pairs used on tinted fills. */
const TEXT_ON_FILLS: [string, string][] = [
  ['--on-accent', '--accent'], ['--on-accent', '--accent-hover'],
  ['--accent', '--accent-soft'], ['--text-primary', '--accent-soft'],
  ['--critical', '--critical-soft'], ['--success', '--success-soft'], ['--warning', '--warning-soft'],
  ['--text-secondary', '--critical-soft'], ['--text-secondary', '--success-soft'], ['--text-secondary', '--warning-soft'],
];
const NON_TEXT = ['--focus', '--border-strong'];
/** Chart marks are drawn on --surface-1 inside a panel on --surface-page; a series colour is a graphical object (1.4.11). */
const SERIES = ['--series-1', '--series-2', '--series-3', '--series-4', '--series-5', '--series-6', '--series-7', '--series-8', '--series-other'];
const CHART_SURFACES = ['--surface-1', '--surface-page'];
/** The home base's status bar segments (closed, in progress, blocked, and the outline of not started) are graphical objects too. */
const BAR_MARKS = ['--success', '--accent', '--critical', '--border-strong'];

for (const [mode, tokens] of Object.entries(modes())) {
  const get = (name: string): string => {
    const v = tokens.get(name);
    assert.ok(v, `${mode}: ${name} is a hex token in theme.css`);
    return v;
  };

  test(`${mode}: every text token meets 4.5:1 on every surface`, () => {
    for (const fg of TEXT_ON_SURFACES) {
      for (const bg of SURFACES) {
        const r = contrast(get(fg), get(bg));
        assert.ok(r >= 4.5, `${mode}: ${fg} on ${bg} is ${r.toFixed(2)}:1`);
      }
    }
  });

  test(`${mode}: text on accent and status fills meets 4.5:1`, () => {
    for (const [fg, bg] of TEXT_ON_FILLS) {
      const r = contrast(get(fg), get(bg));
      assert.ok(r >= 4.5, `${mode}: ${fg} on ${bg} is ${r.toFixed(2)}:1`);
    }
  });

  test(`${mode}: the focus ring and control outlines meet 3:1 on every surface`, () => {
    for (const fg of NON_TEXT) {
      for (const bg of SURFACES) {
        const r = contrast(get(fg), get(bg));
        assert.ok(r >= 3, `${mode}: ${fg} on ${bg} is ${r.toFixed(2)}:1`);
      }
    }
  });

  test(`${mode}: every status bar segment meets 3:1 on the surfaces it sits on`, () => {
    for (const fg of BAR_MARKS) {
      for (const bg of CHART_SURFACES) {
        const r = contrast(get(fg), get(bg));
        assert.ok(r >= 3, `${mode}: ${fg} on ${bg} is ${r.toFixed(2)}:1`);
      }
    }
  });

  test(`${mode}: every chart series colour meets 3:1 on the chart and page surfaces`, () => {
    for (const fg of SERIES) {
      for (const bg of CHART_SURFACES) {
        const r = contrast(get(fg), get(bg));
        assert.ok(r >= 3, `${mode}: ${fg} on ${bg} is ${r.toFixed(2)}:1`);
      }
    }
  });
}

test('neutrals avoid pure black and pure white', () => {
  for (const tokens of Object.values(modes())) {
    for (const [name, v] of tokens) assert.ok(v !== '#000000' && v !== '#ffffff', `${name} is ${v}`);
  }
});

test('contrast() matches the WCAG reference values', () => {
  assert.equal(contrast('#000000', '#ffffff').toFixed(2), '21.00');
  assert.equal(contrast('#777777', '#ffffff').toFixed(2), '4.48');
});
