/** The pager's styles, kept apart from pager.ts so dom.ts can include them without an import cycle. Tokens only. */
export const PAGER_CSS = `
  /* A row type that sets its own display would otherwise show through the attribute, so a paged-out row would stay on screen and in the tab order. */
  [hidden] { display: none !important; }
  nav.pager { display: flex; flex-wrap: wrap; align-items: center; gap: var(--space-2) var(--space-3); margin-top: var(--space-4); font-size: var(--text-sm); color: var(--text-secondary); }
  nav.pager button.pg {
    font: inherit; font-weight: var(--weight-medium); color: var(--text-primary); min-height: 36px; min-width: 36px; padding: 0 var(--space-3);
    border: 1px solid var(--border-strong); border-radius: var(--radius-sm); background: transparent; cursor: pointer;
  }
  @media (hover: hover) { nav.pager button.pg:hover:not([aria-disabled=true]) { background: var(--accent-soft); } }
  nav.pager button.pg[aria-disabled=true] { color: var(--text-muted); border-color: var(--border); cursor: default; }
  nav.pager button.pg:focus-visible { outline: 2px solid var(--focus); outline-offset: 2px; }
  nav.pager .pg-status { font-variant-numeric: tabular-nums; }
  nav.pager .pg-note { color: var(--text-muted); }
  nav.pager .pg-note:empty { display: none; }
  @media (forced-colors: active) { nav.pager button.pg { border-color: ButtonText; } nav.pager button.pg[aria-disabled=true] { color: GrayText; border-color: GrayText; } }
`;
