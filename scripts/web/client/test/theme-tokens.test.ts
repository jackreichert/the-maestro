// Run: node --test scripts/web/client/test/theme-tokens.test.ts
// Loads theme.css into a headless page (happy-dom) once per colour scheme and checks that the tokens the client uses
// resolve in both themes, that the fonts are self-hosted with their licences, and that nothing reaches off the origin.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { Window } from 'happy-dom';
import { SECURITY_HEADERS } from '../../../lib/web/guard.ts';

const CLIENT = new URL('../', import.meta.url);
const css = readFileSync(new URL('theme.css', CLIENT), 'utf8');
const sources = readdirSync(new URL('src/', CLIENT)).filter((f) => f.endsWith('.ts')).map((f) => readFileSync(new URL(`src/${f}`, CLIENT), 'utf8'));

/** A page with theme.css applied under the given user preferences; returns a computed-style reader for :root and body. */
function page(scheme: 'light' | 'dark', reducedMotion = false): { root: (name: string) => string; body: (prop: string) => string } {
  const win = new Window({ settings: { device: { prefersColorScheme: scheme, prefersReducedMotion: reducedMotion ? 'reduce' : 'no-preference' } } });
  const style = win.document.createElement('style');
  style.textContent = css;
  win.document.head.append(style);
  const root = win.getComputedStyle(win.document.documentElement);
  const body = win.getComputedStyle(win.document.body);
  return { root: (name) => root.getPropertyValue(name).trim(), body: (prop) => body.getPropertyValue(prop).trim() };
}

/** Every custom property the client reads with var(), minus the ones a component declares for itself. */
function usedTokens(): string[] {
  const all = [css, ...sources].join('\n');
  const used = new Set([...all.matchAll(/var\((--[\w-]+)/g)].map((m) => m[1]));
  const local = new Set([...sources.join('\n').matchAll(/(--[\w-]+)\s*:/g)].map((m) => m[1]));
  // A name built in a template (`var(--series-${n})`) is checked by its first slot.
  return [...used].filter((name) => !local.has(name)).map((name) => (name.endsWith('-') ? `${name}1` : name)).sort();
}

for (const scheme of ['light', 'dark'] as const) {
  test(`${scheme}: every token the client uses resolves`, () => {
    const p = page(scheme);
    const missing = usedTokens().filter((name) => p.root(name) === '');
    assert.deepEqual(missing, [], `${scheme}: tokens used but not declared in theme.css`);
  });
}

test('the two themes resolve to different surfaces and ink, and the body takes them', () => {
  const light = page('light');
  const dark = page('dark');
  assert.notEqual(light.root('--surface-page'), dark.root('--surface-page'));
  assert.equal(light.body('color'), light.root('--text-primary'));
  assert.equal(dark.body('color'), dark.root('--text-primary'));
});

test('the text, display and mono roles lead with the self-hosted faces', () => {
  const p = page('light');
  assert.match(p.root('--font-sans'), /^"Geist",/);
  assert.match(p.root('--font-display'), /^"Instrument Serif",/);
  assert.match(p.root('--font-mono'), /^"Geist Mono",/);
  assert.match(p.body('font-family'), /Geist/);
});

test('reduced motion zeroes every duration', () => {
  const p = page('light', true);
  for (const name of ['--dur-press', '--dur-fast', '--dur-base', '--dur-slow', '--dur-breathe']) assert.equal(p.root(name), '0ms', name);
  assert.notEqual(page('light').root('--dur-base'), '0ms');
});

test('every @font-face URL is relative, exists, and its family ships a licence', () => {
  const faces = [...css.matchAll(/@font-face\s*{([^}]*)}/g)].map((m) => m[1]);
  assert.ok(faces.length >= 3, 'a display, a text and a mono face');
  const licences = readdirSync(new URL('fonts/', CLIENT)).filter((f) => /^OFL-.+\.txt$/.test(f));
  for (const face of faces) {
    const urls = [...face.matchAll(/url\("?([^")]+)"?\)/g)].map((m) => m[1]);
    assert.ok(urls.length > 0, face);
    for (const u of urls) {
      assert.match(u, /^fonts\/[\w-]+\.woff2$/, `${u} is a relative woff2 path`);
      assert.ok(existsSync(new URL(u, CLIENT)), `${u} exists`);
      const family = u.slice('fonts/'.length).replace(/(-italic)?\.woff2$/, '');
      assert.ok(licences.includes(`OFL-${family}.txt`), `${u} has fonts/OFL-${family}.txt`);
    }
  }
});

test('the content security policy names no origin but its own, fonts included', () => {
  const policy = SECURITY_HEADERS['content-security-policy'];
  for (const directive of policy.split(';').map((d) => d.trim().split(/\s+/))) {
    for (const source of directive.slice(1)) assert.ok(["'self'", "'none'"].includes(source), `${directive[0]} allows ${source}`);
  }
  assert.match(policy, /font-src 'self'/);
});
