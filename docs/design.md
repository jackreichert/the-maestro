# Podium design

The Podium is a page you read every morning and hand to someone new. It should be useful first and beautiful because of it. This note is the short version of how it is designed and how to build on it. Every value lives in `scripts/web/client/theme.css`; components use token names only.

## Principles

- **Simplicity by reduction.** Every element earns its place or goes. A mark ships only when data, or something you just did, produces it. No decoration stands in for content.
- **A hierarchy that reads at a glance.** One headline line of counts in the display face, then section headings, then rows. Size and ink carry the order; colour is kept for state and the single accent.
- **Honest materials.** Real numbers with their denominators, tabular numerals so columns align, hairlines rather than boxes, and one surface lift (a hairline ring and a soft shadow) for cards.
- **Obsessive detail.** Text sits on a 4 px rhythm, headings balance, focus rings are visible, targets are at least 24 px, and the loading skeleton has the same measurements as the page it stands in for, so nothing jumps.
- **Calm by default.** Motion marks a change of state and nothing else, and under reduced motion every duration is zero.

## Type

| Role | Face | Used for |
|---|---|---|
| Display (`--font-display`) | Instrument Serif, regular and italic | The wordmark, the headline count line, large numerals, and the italic musical words (`--font-serif` points here) |
| Text (`--font-sans`) | Geist, variable weight | Everything else: headings, rows, labels, buttons, tables |
| Mono (`--font-mono`) | Geist Mono, variable weight | Ids, commit shas, paths, keys |

Why these: Instrument Serif is a condensed, high-contrast display serif that gives large numbers and the headline line an editorial voice without shouting. It has one weight, so emphasis in the display face comes from size and ink, never bold (the page sets `font-synthesis: style` so a bold is never faked). Geist is a quiet, precise grotesque built for interfaces, with a wide weight range, so it stays out of the way at 13 to 15 px. Geist Mono shares its proportions, so an id inside a sentence does not jar.

All three are SIL Open Font License faces, subset to Latin, and self-hosted as `woff2` under `scripts/web/client/fonts/` with their licences beside them. The page loads them from its own origin only (`font-src 'self'`), so it makes no network call off the machine. The system stack behind each name is the fallback while a face loads. To change a pairing, replace the files and the `@font-face` rules and keep the role names; no component changes.

## Tokens

| Group | Tokens | Rule |
|---|---|---|
| Type scale | `--text-xs` to `--text-3xl`, `--text-display`, each with a `--leading-*`; `--tracking-*`; `--weight-*` | About a 1.2 ratio. Body is `--text-md`. Display sizes only in the display face |
| Space | `--space-1` (4 px) to `--space-8` (64 px) | Every margin, padding and gap is a step on this scale |
| Grid | `--grid-columns` (12), `--grid-max`, `--gutter`, `--page-pad` | Gutter and page margin step up at 640 and 1100 px; lay a screen out as `repeat(var(--grid-columns), minmax(0, 1fr))` with `gap: var(--gutter)` |
| Lines and radii | `--hairline`, `--hairline-strong`, `--hairline-width`; `--radius-xs` to `--radius-lg`, `--radius-pill` | One rule weight. The strong hairline is for control outlines that must meet 3:1 |
| Elevation | `--shadow-1` (resting card), `--shadow-2` (over content), `--material-bar` and `--material-blur` (the sticky tab bar) | No other shadows |
| Colour | Surfaces, text, border, one `--accent`, and `--critical`, `--success`, `--warning` with `-soft` fills | Light and dark follow `prefers-color-scheme`. Every text pair meets 4.5:1 and every control, focus and chart mark 3:1, checked by test in both modes |
| Status | `--glyph-attention`, `--glyph-critical`, `--glyph-success`, `--glyph-warning` | A status colour always travels with a symbol or a word |
| Motion | `--dur-press`, `--dur-fast`, `--dur-base`, `--dur-slow`, `--dur-breathe`; `--ease-out`, `--ease-in-out` | All durations are 0 ms under `prefers-reduced-motion: reduce` |
| Charts | `--chart-grid`, `--chart-axis`, `--chart-label`, `--chart-label-size`, `--chart-stroke`, `--chart-dot`, `--chart-mark-radius`, `--chart-mark-gap`, `--chart-highlight`; series `--series-1` to `--series-8`, `--series-other` | Gridlines recede, labels are muted and tabular, and series colours mean identity, never status. Every chart has a table view |

## Using the tokens

- Reference names, never values: `padding: var(--space-4)`, not `16px`. Custom properties inherit into shadow roots, so a component's stylesheet can use them directly.
- Need a value the scale lacks? Add a token to `theme.css` (both themes when it is a colour) rather than a raw value in a component, and extend `test/theme-contrast.test.ts` when it is a colour pair.
- `test/theme-tokens.test.ts` loads the theme in a headless page in light and dark, and fails if any token the client reads is undeclared, if reduced motion leaves a duration, if a font URL is not a local `woff2` with its licence, or if the content security policy names any origin but its own.
