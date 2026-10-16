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
| Space | `--space-1` (4 px) to `--space-9` (80 px) | Every margin, padding and gap is a step on this scale |
| Grid | `--grid-columns` (12), `--grid-max`, `--gutter`, `--page-pad` | Gutter and page margin step up at 640 and 1100 px; lay a screen out as `repeat(var(--grid-columns), minmax(0, 1fr))` with `gap: var(--gutter)` |
| Lines and radii | `--hairline`, `--hairline-strong`, `--hairline-width`; `--radius-xs` to `--radius-lg`, `--radius-pill` | One rule weight. The strong hairline is for control outlines that must meet 3:1 |
| Elevation | `--shadow-1` (resting card), `--shadow-2` (over content), `--material-bar` and `--material-blur` (the sticky tab bar) | No other shadows |
| Colour | Surfaces, text, border, one `--accent`, and `--critical`, `--success`, `--warning` with `-soft` fills | Light and dark follow `prefers-color-scheme`. Every text pair meets 4.5:1 and every control, focus and chart mark 3:1, checked by test in both modes |
| Status | `--glyph-attention`, `--glyph-critical`, `--glyph-success`, `--glyph-warning` | A status colour always travels with a symbol or a word |
| Grid spacing | `--col-gap`, `--row-gap`, `--card-pad` | The gap between columns, between rows, and the padding inside a card. They follow `--gutter` and `--section-gap`, which grow at 640 px and 1100 px |
| Score | `--ink`, `--staff`, `--staff-dim` (staff and note ink), `--section-gap` | Home's staves, measures and section rhythm; stream colours come from `--stream-color` set per section class |
| Motion | `--dur-press`, `--dur-fast`, `--dur-base`, `--dur-slow`, `--dur-breathe`; `--ease-out`, `--ease-in-out`, `--ease-spring` (arrivals only) | All durations are 0 ms under `prefers-reduced-motion: reduce`. `--dur-sweep` (the playhead) and `--stagger` (the per-item entrance step, with `--i` the item's index) follow |
| Charts | `--chart-grid`, `--chart-axis`, `--chart-label`, `--chart-label-size`, `--chart-stroke`, `--chart-dot`, `--chart-mark-radius`, `--chart-mark-gap`, `--chart-highlight`; series `--series-1` to `--series-8`, `--series-other` | Gridlines recede, labels are muted and tabular, and series colours mean identity, never status. Every chart has a table view |

## Using the tokens

- Reference names, never values: `padding: var(--space-4)`, not `16px`. Custom properties inherit into shadow roots, so a component's stylesheet can use them directly.
- Need a value the scale lacks? Add a token to `theme.css` (both themes when it is a colour) rather than a raw value in a component, and extend `test/theme-contrast.test.ts` when it is a colour pair.
- `test/theme-tokens.test.ts` loads the theme in a headless page in light and dark, and fails if any token the client reads is undeclared, if reduced motion leaves a duration, if a font URL is not a local `woff2` with its licence, or if the content security policy names any origin but its own.


## The grid and placing a section

Every page is one `.grid` (`src/grid.ts`): twelve columns, and each child is full width, a half, a third or two thirds, so column edges align across rows and across tabs. Below 768 px everything is full width; from 768 px halves and thirds sit in pairs; from 1100 px thirds are thirds. Gaps come from `--col-gap` and `--row-gap`, never from one-off values.

**Placing a section: what needs acting on goes first.** On Home the order is: Cues (answers waiting on the reader), then open work (In flight, open asks by age), open PRs and local review waiting for the reader, then what is blocked (Fermata), and only then the views that report rather than ask: the score, Movements, Coda, the deck and Brass. A new section is placed by asking "does this need the reader to act, and how soon?", not by when it was built. A section with nothing in it keeps its heading and says so in a tacet line (collapsing the empty ones to a single line is a follow-up).

## The stream picker

The picker is a labelled listbox, not a native select, so it can carry each stream's colour and cue count. The button shows a "Voice" caption, the stream swatch, the name and a count pill; the menu lists All streams (italic "tutti") and then each stream with its count, "tacet" when it has none. The current stream has a colour rail, a tinted row and a check. Keys: arrows, Home, End, type-ahead, Enter or Space to choose, Escape to close with focus back on the button.

Two variants were screenshotted: a refined list and a two-column grid of voice cards. The list won. It keeps the one-dimensional listbox keyboard model, stays aligned with the bar's rhythm, and scales to many streams. The card grid read well for three or four streams but needs two-dimensional arrow handling and ragged rows once names differ in length.

## Pagination

One pager (`src/pager.ts`, math in `src/page-math.ts`, styles in `src/pager-css.ts`) replaces every "Show all", "Show more" and "Load more". A list that is longer than its page size shows one page and a `nav.pager` under it: Previous, "Page N of M (a to b of T)", Next. Rules: the page size is set where the list is built; the page is kept by key so a redraw lands on the same page; the buttons use `aria-disabled` rather than `disabled` so keyboard focus is not lost at either end; rows that must always be seen (Others' PRs asked of you) sit above the paging on every page. Use `pagedRows(rows, { key, size, label })` for rows already in the DOM (it toggles `hidden`, no redraw) or `pager(view, ...)` when the list redraws itself.

## The stream tab

Top to bottom: the stream heading and cue line, the definition of done (centred, 760px at most), the links in columns, then the board (Where it stands, Cues, Fermata, In flight, Coda), and last the 14-day score. The board comes before the score because it is what needs acting on; the score is context. Section names are Home's (instrument word over the title), so a reader who knows Home knows this page, and the plain meaning ("needs you", "blocked") is read to a screen reader.

The definition of done is never written by the page. It is read from an open epic's "What done looks like" or the project's CONTEXT.md and shown as written; when neither exists the page says which file to add it to.

## Cost (Brass)

A number that is not from today is never drawn like a live gauge. A stale measurement says "Last measured <date>", mutes the section (the accent and status colours flatten to ink), and leaves the limit pendulum at rest. Gauges are said in words first: "Tokens read per turn: 417k, limit 200k". The model mix is a ring in the ink ramp (Opus darkest) with each goal as a tick on the ring and in words ("Opus 57%, goal at most 40%"), labelled with the day it was measured.

The pendulum has one positive use besides the limit: the day's tempo. Today's finished work items against the median of the seven days before, swinging right as the day fills (the centre is a typical day, full right is twice that) with a dynamics mark from pp to ff. It counts finished work items from the charts; merged PRs are not counted separately.

## The score beyond Home

Tabs other than Home borrow two pieces of the score's look from `home-concept.ts`: `INSTRUMENT_CSS` (an instrument name in the display italic over a plain heading, decoration only) and `TACET_CSS` with `tacet()` (an empty state that is a sentence plus the musical word for silence). Open PRs names its bands Cadence, Solo, Tutti and Sketches; empty lists on Open PRs, Others' PRs and Scripts use the rest glyph. A new tab should reuse these before inventing its own.
