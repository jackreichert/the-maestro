/**
 * The PR-dirty marker, `<statusDir>/.now-dirty-prs`: pr-watch and pr-merged touch it when they report something, and the
 * status-refresh type reads its modification time to know the page's PR tables are out of date. Only the time matters, not the content.
 * Touching is best effort and never creates the status directory: a watcher must not fail, or invent a folder, over a page nobody keeps.
 */
import { existsSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { CONFIGURED_PROJECT, CONTAINER_PROJECT, statusDirFor } from '../../local-config.ts';

export const DIRTY_PRS = '.now-dirty-prs';

/** Marks the PR data dirty. `dir` defaults to the configured status directory. */
export function markPrsDirty(dir: string = statusDirFor(CONFIGURED_PROJECT || CONTAINER_PROJECT)): void {
  try {
    if (dir && existsSync(dir)) writeFileSync(join(dir, DIRTY_PRS), `${Date.now()}\n`);
  } catch { /* a missed touch costs one stale PR table until the next idle refresh */ }
}

/** When the marker was last touched, epoch ms; 0 when it never was. */
export function prsDirtyAt(dir: string): number {
  try { return statSync(join(dir, DIRTY_PRS)).mtimeMs; } catch { return 0; }
}
