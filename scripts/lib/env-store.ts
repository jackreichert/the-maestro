/**
 * ENV STORE: environment files kept outside every worktree, as `<root>/<repo>/<project>/<file>` (plus `<repo>/shared/`).
 * A worktree holds a symlink to its store file, so removing the worktree removes only the link.
 *
 * Nothing here ever prints or returns a file's contents: names, paths, modes and hashes only. The manifest at
 * `<root>/manifest.json` is names-only too: which store file belongs to which repo and project, and which worktrees link to it.
 */
import { createHash } from 'node:crypto';
import {
  chmodSync, copyFileSync, constants, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, realpathSync, renameSync, symlinkSync, unlinkSync, writeFileSync,
} from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

/** True for an environment or secrets-export file by name (`.env`, `.env.local`, `ssm-*.json`; templates such as `.env.example` are not). */
export function isEnvFile(path: string): boolean {
  const name = basename(path.replace(/\/+$/, ''));
  if (/^ssm-.*\.json$/.test(name)) return true;
  return /^\.env(\..+)?$/.test(name) && !/\.(example|sample|template|dist)$/.test(name);
}

/** Whether `path` is `root` or lies under it, compared by path segments (so `/a/store-x` is not inside `/a/store`). */
export const isInside = (path: string, root: string): boolean => {
  const rel = relative(root, path);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
};

/** The roots a path may be compared against: the root as given and, when it exists, its real path (macOS tmp dirs are symlinks). */
function rootsOf(root: string): string[] {
  const roots = [resolve(root)];
  try { roots.push(realpathSync(root)); } catch { /* the store need not exist yet */ }
  return roots;
}

/**
 * Whether `link` is a symlink whose target is inside the store root. A symlink is judged by where it points, never by its name:
 * a link to somewhere else is not store-managed. A dangling link counts when its target would be inside the store (removing a link never touches the target).
 */
export function isStoreLink(link: string, root: string): boolean {
  let st;
  try { st = lstatSync(link); } catch { return false; }
  if (!st.isSymbolicLink()) return false;
  const roots = rootsOf(root);
  let target: string;
  try { target = realpathSync(link); } catch { target = resolve(dirname(link), readlinkSync(link)); }
  return roots.some((r) => isInside(target, r));
}

/** The project a branch name points at: the first word of the branch that names an existing `<root>/<repo>/<project>/` directory (not `shared`), else undefined. */
export function projectFromBranch(root: string, repo: string, branch: string | undefined): string | undefined {
  if (!branch) return undefined;
  let projects: string[];
  try { projects = readdirSync(join(root, repo), { withFileTypes: true }).filter((e) => e.isDirectory() && e.name !== 'shared').map((e) => e.name); } catch { return undefined; }
  const words = branch.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  return projects.find((p) => words.includes(p.toLowerCase()));
}

// ── manifest ────────────────────────────────────────────────────────────────

export interface ManifestEntry { repo: string; project: string; file: string; worktrees: string[] }
export interface Manifest { version: 1; files: ManifestEntry[] }

export const manifestPath = (root: string): string => join(root, 'manifest.json');

/** The manifest, or an empty one when none exists yet. A manifest that is not valid throws rather than being overwritten. */
export function readManifest(root: string): Manifest {
  const path = manifestPath(root);
  if (!existsSync(path)) return { version: 1, files: [] };
  const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<Manifest>;
  if (parsed.version !== 1 || !Array.isArray(parsed.files)) throw new Error(`manifest ${path} is not a version 1 manifest; not touching it`);
  return parsed as Manifest;
}

/** Records that `worktree` links to the store file (repo, project, file). Idempotent; written atomically with mode 600. */
export function recordInManifest(root: string, entry: { repo: string; project: string; file: string; worktree: string }): void {
  const manifest = readManifest(root);
  let row = manifest.files.find((f) => f.repo === entry.repo && f.project === entry.project && f.file === entry.file);
  if (!row) { row = { repo: entry.repo, project: entry.project, file: entry.file, worktrees: [] }; manifest.files.push(row); }
  if (!row.worktrees.includes(entry.worktree)) row.worktrees.push(entry.worktree);
  manifest.files.sort((a, b) => `${a.repo}/${a.project}/${a.file}`.localeCompare(`${b.repo}/${b.project}/${b.file}`));
  const tmp = `${manifestPath(root)}.tmp-${process.pid}`;
  writeFileSync(tmp, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, manifestPath(root));
}

// ── move ────────────────────────────────────────────────────────────────────

export interface MoveRequest { root: string; worktree: string; file: string; project: string; repo?: string; dryRun?: boolean }
export interface MoveResult { status: 'moved' | 'already' | 'would-move'; store: string; link: string; repo: string; project: string }

/** A refusal: the move did not happen and nothing was changed that a rerun cannot finish. */
export class MoveRefused extends Error {}

const PROJECT_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const sha = (path: string): string => createHash('sha256').update(readFileSync(path)).digest('hex');

/** The repo a worktree belongs to: the directory holding the shared git dir (the main checkout), not the worktree's own name. */
function repoOf(worktree: string): string {
  const r = spawnSync('git', ['-C', worktree, 'rev-parse', '--path-format=absolute', '--git-common-dir'], { encoding: 'utf8' });
  if (r.status !== 0) throw new MoveRefused(`${worktree} is not a git worktree`);
  return basename(dirname(r.stdout.trim()));
}

/** Creates each missing directory from `root` down to `dir` with mode 700; existing directories are left as they are. */
function mkdir700(dir: string, root: string): void {
  const missing: string[] = [];
  for (let d = dir; !existsSync(d) && isInside(d, root); d = dirname(d)) missing.unshift(d);
  for (const d of missing) { mkdirSync(d, { mode: 0o700 }); chmodSync(d, 0o700); }
}

function validate(req: MoveRequest): { worktree: string; rel: string; path: string } {
  if (!PROJECT_NAME.test(req.project) || req.project === '.' || req.project === '..') throw new MoveRefused(`project "${req.project}" is not a plain name (letters, digits, dot, dash, underscore)`);
  const worktree = realpathSync(req.worktree);
  if (isAbsolute(req.file) || req.file.split('/').includes('..')) throw new MoveRefused('file must be a path relative to the worktree, without ..');
  const rel = req.file.replace(/^\.\//, '');
  if (!isEnvFile(rel)) throw new MoveRefused(`${basename(rel)} is not an environment file name (.env, .env.*, ssm-*.json); templates such as .env.example are not moved`);
  const path = join(worktree, rel);
  let parent: string;
  try { parent = realpathSync(dirname(path)); } catch { throw new MoveRefused(`no such directory for ${rel} in the worktree`); }
  if (!isInside(parent, worktree)) throw new MoveRefused(`${rel} resolves outside the worktree`);
  return { worktree, rel, path: join(parent, basename(path)) };
}

/**
 * Moves one real environment file of a worktree into the store and leaves a symlink at its old path.
 * Refuses to overwrite a store file, except to finish an interrupted move (same bytes already stored). Idempotent: a path that is
 * already a symlink into the store only has the manifest brought up to date. Copy, verify, then atomically replace the original
 * with the link, so at no point is the only copy missing.
 */
export function moveIntoStore(req: MoveRequest): MoveResult {
  const { worktree, rel, path } = validate(req);
  const root = resolve(req.root);
  const repo = req.repo ?? repoOf(worktree);
  if (!PROJECT_NAME.test(repo)) throw new MoveRefused(`repo "${repo}" is not a plain name`);
  const store = join(root, repo, req.project, rel);
  if (!isInside(store, root)) throw new MoveRefused('the store path would fall outside the store root');
  const result = (status: MoveResult['status']): MoveResult => ({ status, store, link: path, repo, project: req.project });
  const st = lstatSync(path, { throwIfNoEntry: false });
  if (!st) throw new MoveRefused(`no such file ${rel} in the worktree`);
  if (st.isSymbolicLink()) {
    if (!isStoreLink(path, root)) throw new MoveRefused(`${rel} is a symlink that does not point into the store; not touching it`);
    if (realpathSync(path) !== (existsSync(store) ? realpathSync(store) : store)) throw new MoveRefused(`${rel} already links into the store, but to a different project or file than ${repo}/${req.project}/${rel}`);
    if (!req.dryRun) recordInManifest(root, { repo, project: req.project, file: rel, worktree });
    return result('already');
  }
  if (!st.isFile()) throw new MoveRefused(`${rel} is not a regular file`);
  if (existsSync(store) && sha(store) !== sha(path)) throw new MoveRefused(`${store} already exists and differs; refusing to overwrite it`);
  if (req.dryRun) return result('would-move');

  mkdir700(dirname(store), root);
  if (!existsSync(store)) {
    copyFileSync(path, store, constants.COPYFILE_EXCL);
    chmodSync(store, st.mode & 0o700 || 0o600); // owner bits only: group and other access is dropped
  }
  if (sha(store) !== sha(path)) { unlinkSync(store); throw new MoveRefused('the copy did not match the original; nothing was changed'); }
  const tmp = `${path}.store-link-${process.pid}`;
  symlinkSync(store, tmp);
  renameSync(tmp, path);
  recordInManifest(root, { repo, project: req.project, file: rel, worktree });
  return result('moved');
}
