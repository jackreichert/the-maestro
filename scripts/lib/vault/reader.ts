/**
 * The guarded vault reader: the one way the home base touches the vault. Read-only by construction.
 *
 * Every request names a vault-relative path. Before anything is opened it must (1) be a plain relative path with no `..`,
 * no backslash and no NUL, (2) contain no secret-file name (secret-names.ts), (3) match a configured scope (the folders
 * the home base is allowed to read), (4) have every component below the root be a real directory or file, never a symlink,
 * and (5) resolve by realpath inside the real root. A file is then opened with O_NOFOLLOW and judged on its descriptor
 * (regular file, size cap) so a swap between check and open cannot widen what is read. Only `.md` files are ever opened.
 * Results carry vault-relative paths only; a refusal never contains an absolute path.
 */
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, readdirSync, realpathSync } from 'node:fs';
import { join, sep } from 'node:path';
import { hasSecretSegment, isSecretName } from './secret-names.ts';

/** Why a read or listing was refused. `denied` is never surfaced to a response: the name must not be repeated anywhere. */
export type Refusal = 'denied' | 'invalid-path' | 'out-of-scope' | 'not-markdown' | 'missing' | 'symlink' | 'not-file' | 'not-dir' | 'too-large' | 'unreadable' | 'root-unavailable';

export type ReadResult = { ok: true; text: string; mtimeMs: number; size: number } | { ok: false; reason: Refusal };
export type ListResult = { ok: true; dirs: string[]; files: string[] } | { ok: false; reason: Refusal };

/** A folder (or file) pattern the reader may serve, matched on the whole vault-relative path. */
export interface Scope { name: string; pattern: RegExp }
export interface ReaderOptions { root: string; dirScopes: readonly Scope[]; fileScopes: readonly Scope[] }
export interface VaultReader {
  /** The sub-directories and `.md` files directly inside `dir`, names only, secret names and symlinks left out. */
  list(dir: string): ListResult;
  /** The text of a `.md` file of at most `maxBytes`. */
  read(path: string, maxBytes: number): ReadResult;
  /** The first `bytes` bytes of a `.md` file of at most `maxBytes` (for headers of large documents). */
  head(path: string, bytes: number, maxBytes: number): ReadResult;
}

const SAFE_SEGMENT = /^[^\0/\\]+$/;

/** The path as segments when it is a plain vault-relative path, else null. */
export function cleanPath(path: string): string[] | null {
  if (!path || path.startsWith('/') || path.endsWith('/') || path.length > 1024) return null;
  const segs = path.split('/');
  return segs.every((s) => s !== '' && s !== '.' && s !== '..' && SAFE_SEGMENT.test(s)) ? segs : null;
}

export function createReader(opts: ReaderOptions): VaultReader {
  let realRoot: string | null = null;
  try { realRoot = realpathSync(opts.root); } catch { realRoot = null; }

  /** The checks every path passes before any open or listing. Returns the absolute path to use, or the refusal. */
  function admit(path: string, scopes: readonly Scope[], want: 'file' | 'dir'): { abs: string; ino: number; dev: number } | { reason: Refusal } {
    if (realRoot === null) return { reason: 'root-unavailable' };
    const segs = cleanPath(path);
    if (!segs) return { reason: 'invalid-path' };
    if (hasSecretSegment(path)) return { reason: 'denied' };
    if (!scopes.some((s) => s.pattern.test(path))) return { reason: 'out-of-scope' };
    let cur = realRoot;
    let last: { ino: number; dev: number; isFile: boolean; isDir: boolean } = { ino: 0, dev: 0, isFile: false, isDir: true };
    for (const seg of segs) {
      cur = join(cur, seg);
      try {
        const st = lstatSync(cur);
        if (st.isSymbolicLink()) return { reason: 'symlink' };
        last = { ino: st.ino, dev: st.dev, isFile: st.isFile(), isDir: st.isDirectory() };
      } catch (e) { return { reason: (e as NodeJS.ErrnoException).code === 'ENOENT' ? 'missing' : 'unreadable' }; }
    }
    try {
      const real = realpathSync(cur);
      if (real !== cur || !(real === realRoot || real.startsWith(`${realRoot}${sep}`))) return { reason: 'symlink' };
    } catch { return { reason: 'unreadable' }; }
    if (want === 'file' ? !last.isFile : !last.isDir) return { reason: want === 'file' ? 'not-file' : 'not-dir' };   // a FIFO or device named like a note is refused before it is opened
    return { abs: cur, ino: last.ino, dev: last.dev };
  }

  function open(path: string, bytes: number, maxBytes: number): ReadResult {
    if (!cleanPath(path)) return { ok: false, reason: 'invalid-path' };
    if (hasSecretSegment(path)) return { ok: false, reason: 'denied' };
    if (!path.endsWith('.md')) return { ok: false, reason: 'not-markdown' };
    const a = admit(path, opts.fileScopes, 'file');
    if ('reason' in a) return { ok: false, reason: a.reason };
    let fd: number | null = null;
    try {
      fd = openSync(a.abs, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      const st = fstatSync(fd);
      if (!st.isFile()) return { ok: false, reason: 'not-file' };
      if (st.ino !== a.ino || st.dev !== a.dev) return { ok: false, reason: 'symlink' };   // the file opened is not the one that was checked
      if (st.size > maxBytes) return { ok: false, reason: 'too-large' };
      const want = Math.min(st.size, bytes);
      const buf = Buffer.alloc(want);
      let got = 0;
      while (got < want) { const n = readSync(fd, buf, got, want - got, got); if (n === 0) break; got += n; }
      // A head cut can split a multi-byte character; a whole read must be valid UTF-8.
      const text = new TextDecoder('utf-8', { fatal: want === st.size }).decode(buf.subarray(0, got));
      return { ok: true, text, mtimeMs: st.mtimeMs, size: st.size };
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      return { ok: false, reason: code === 'ENOENT' ? 'missing' : code === 'ELOOP' ? 'symlink' : 'unreadable' };
    } finally {
      if (fd !== null) closeSync(fd);
    }
  }

  return {
    list(dir) {
      const a = admit(dir, opts.dirScopes, 'dir');
      if ('reason' in a) return { ok: false, reason: a.reason };
      try {
        const dirs: string[] = [];
        const files: string[] = [];
        for (const e of readdirSync(a.abs, { withFileTypes: true })) {
          if (isSecretName(e.name) || e.isSymbolicLink()) continue;   // dropped before anything else looks at them
          if (e.isDirectory()) dirs.push(e.name);
          else if (e.isFile() && e.name.endsWith('.md')) files.push(e.name);
        }
        const again = lstatSync(a.abs);
        if (!again.isDirectory() || again.ino !== a.ino || again.dev !== a.dev || realpathSync(a.abs) !== a.abs) return { ok: false, reason: 'symlink' };   // swapped while it was read
        return { ok: true, dirs: dirs.sort(), files: files.sort() };
      } catch { return { ok: false, reason: 'unreadable' }; }
    },
    read: (path, maxBytes) => open(path, maxBytes, maxBytes),
    head: (path, bytes, maxBytes) => open(path, bytes, maxBytes),
  };
}
