/** A cheap change stamp for files: modification time and size, so a rewrite with the same length is still noticed. */
import { statSync } from 'node:fs';

/** `mtime:size` for one file, or `-` when it cannot be read (missing counts as a state, so creating it is a change). */
export const stamp = (path: string): string => { try { const s = statSync(path); return `${s.mtimeMs}:${s.size}`; } catch { return '-'; } };

/** One stamp for a set of files, in the order given: it changes when any of them does. */
export const stampAll = (paths: string[]): string => paths.map(stamp).join('|');
