/**
 * The Podium's one column system. A page is a `.grid` of twelve columns; each child is full width, a half, a third or two thirds,
 * so every column edge on every tab falls on the same lines. Gutters and row gaps come from tokens (`--col-gap`, `--row-gap`), never
 * from one-off values. Below 768 px everything is full width; from 768 px halves and thirds sit in pairs; from 1100 px thirds are thirds.
 */
export const GRID_CSS = `
  .grid { display: grid; grid-template-columns: repeat(12, minmax(0, 1fr)); gap: var(--row-gap) var(--col-gap); }
  .grid > * { grid-column: 1 / -1; min-width: 0; }
  @media (min-width: 768px) {
    .grid > .half, .grid > .third { grid-column: span 6; }
  }
  @media (min-width: 1100px) {
    .grid > .third { grid-column: span 4; }
    .grid > .two-thirds { grid-column: span 8; }
  }
`;
