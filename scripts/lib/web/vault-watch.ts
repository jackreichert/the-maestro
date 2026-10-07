/**
 * The vault paths the change hub stats, so a ticket closing, a brief edited or a note added wakes the home base like any board file.
 * The hub only ever stats these paths. The list is built through the guarded reader (secret names and symlinks are already dropped
 * by it) and refreshed at most every `refreshMs`, because listing is the only cost and stat-ing a few thousand paths is cheap.
 *
 * Watched: each project's `Tickets`, `Tickets/Archive`, document folders and `Briefs` directories (a directory's mtime changes when
 * a file is added, removed or renamed), every `.md` in `Briefs` and `Tickets` (edits), then document files while the cap allows.
 * Past the cap only directories and briefs stay watched, so an edit to an existing document shows on the next reload instead.
 */
import { join } from 'node:path';
import { DOC_DIR_SCOPES, DOC_FILE_SCOPES, DOC_FOLDERS } from '../home/docs.ts';
import { BRIEF_DIR_SCOPES, BRIEF_FILE_SCOPES } from '../home/brief.ts';
import { createReader } from '../vault/reader.ts';
import { TICKET_DIR_SCOPES, TICKET_FILE_SCOPES } from '../vault/tickets.ts';

export const WATCH_CAP = 3000;
export const WATCH_REFRESH_MS = 30_000;
const PROJECT_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export interface VaultWatch { files: () => string[]; refresh: () => void }

export function vaultWatch(root: string, o: { cap?: number; refreshMs?: number; now?: () => number } = {}): VaultWatch {
  const cap = o.cap ?? WATCH_CAP;
  const refreshMs = o.refreshMs ?? WATCH_REFRESH_MS;
  const now = o.now ?? Date.now;
  const reader = createReader({ root, dirScopes: [...TICKET_DIR_SCOPES, ...DOC_DIR_SCOPES, ...BRIEF_DIR_SCOPES], fileScopes: [...TICKET_FILE_SCOPES, ...DOC_FILE_SCOPES, ...BRIEF_FILE_SCOPES] });
  let cached: string[] = [];
  let at = Number.NEGATIVE_INFINITY;

  const build = (): string[] => {
    const top = reader.list('Projects');
    const projects = top.ok ? top.dirs.filter((p) => PROJECT_NAME.test(p)) : [];
    const dirs: string[] = ['Projects'];
    const important: string[] = [];
    const docs: string[] = [];
    for (const p of projects) {
      const base = `Projects/${p}`;
      for (const sub of ['Tickets', 'Tickets/Archive', 'Briefs', ...DOC_FOLDERS]) {
        const dir = `${base}/${sub}`;
        const ls = reader.list(dir);
        if (!ls.ok) continue;
        dirs.push(dir);
        const target = sub === 'Tickets' || sub === 'Tickets/Archive' || sub === 'Briefs' ? important : docs;
        for (const f of ls.files) target.push(`${dir}/${f}`);
      }
    }
    return [...dirs, ...important, ...docs].slice(0, cap).map((rel) => join(root, rel));
  };

  const refresh = (): void => { try { cached = build(); } catch { cached = []; } at = now(); };
  return { files: () => { if (now() - at >= refreshMs) refresh(); return cached; }, refresh };
}
