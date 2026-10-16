/** The pager's styles, kept apart from pager.ts so dom.ts can include them without an import cycle. Tokens only. */
export const PAGER_CSS = `
  nav.pager { display: flex; flex-wrap: wrap; align-items: center; gap: var(--space-2) var(--space-3); margin-top: var(--space-4); font-size: var(--text-sm); color: var(--text-secondary); }
  nav.pager button.pg {
    font: inherit; font-weight: var(--weight-medium); color: var(--text-primary); min-height: 36px; min-width: 36px; padding: 0 var(--space-3);
    border: 1px solid var(--border-strong); border-radius: var(--radius-sm); background: transparent; cursor: pointer;
  }
  @media (hover: hover) { nav.pager button.pg:hover:not([aria-disabled=true]) { background: var(--accent-soft); } }
  nav.pager button.pg[aria-disabled=true] { color: var(--text-muted); border-color: var(--border); cursor: default; }
  nav.pager button.pg:focus-visible { outline: 2px solid var(--focus); outline-offset: 2px; }
  nav.pager .pg-status { font-variant-numeric: tabular-nums; }
  nav.pager .pg-status strong { color: var(--text-primary); font-weight: var(--weight-semibold); }
  nav.pager .pg-range { color: var(--text-muted); }
  @media (forced-colors: active) { nav.pager button.pg { border-color: ButtonText; } nav.pager button.pg[aria-disabled=true] { color: GrayText; border-color: GrayText; } }
`;
