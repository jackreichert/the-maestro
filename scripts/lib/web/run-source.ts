/**
 * What a run is made of, read fresh on the server every time it is asked about: a paste ask's block file, or (see run-script.ts) a catalog entry.
 * A source resolves to the exact text or argv that would execute, its sha256, the verdict of the guards and the one-run-at-a-time key. The page never
 * sends the text; it sends the sha256 it was shown, and the server runs only a command whose hash is still that.
 */
import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import { basename } from 'node:path';
import { checkBlock, MAX_BLOCK_BYTES, secretFileRefs } from '../run/command-guard.ts';
import type { ExtraGuard, Refusal } from '../run/command-guard.ts';
import type { Spec } from '../run/runner.ts';
import { withholdJson } from '../json-out.ts';
import { readBoard } from './api.ts';
import type { WebConfig } from './api.ts';

export const ASK_TIMEOUT_MS = 5 * 60_000;

export interface Resolved {
  key: string; source: 'ask' | 'script'; target: string; title: string;
  /** The command exactly as it will run (a shell block, or an argv line for display). */
  command: string;
  sha256: string; readOnly: boolean | null; tier: string | null;
  spec: Spec; timeoutMs: number;
  refusals: Refusal[];
}
export type Missing = { ok: false; status: number; error: string; message: string };
export type Lookup = { ok: true; item: Resolved } | Missing;

export const sha256 = (text: string): string => createHash('sha256').update(text).digest('hex');
const missing = (status: number, error: string, message: string): Missing => ({ ok: false, status, error, message });

/** True when the page would show `command` unchanged: the JSON reply scan must not replace any of it. */
export function shownVerbatim(command: string): boolean {
  const body = { command };
  return JSON.stringify(withholdJson(body)) === JSON.stringify(body);
}

/** The block file of a paste ask, or why it cannot be read. A symlink is followed, and the real file's name is checked like the given one. */
export function readBlockFile(path: string): { ok: true; block: string } | Missing {
  try {
    const real = realpathSync(path);
    if (secretFileRefs(basename(real)).length || secretFileRefs(basename(path)).length) return missing(422, 'refused', 'That block file is a secret file.');
    const st = lstatSync(real);
    if (!st.isFile()) return missing(404, 'missing', 'The block is not a file.');
    if (st.size > MAX_BLOCK_BYTES) return missing(422, 'refused', 'The block file is too big to run.');
    return { ok: true, block: readFileSync(real, 'utf8') };
  } catch {
    return missing(404, 'missing', 'The block file cannot be read. It may have moved.');
  }
}

/** Resolves an open paste ask by id: the block is read from the file the ledger row names, not from anything the page sent. */
export function resolveAsk(web: WebConfig, id: string, now: Date, extra?: ExtraGuard): Lookup {
  const { g } = readBoard(web, now);
  const ask = g.paste.find((a) => a.id === id);
  if (!ask || typeof ask.paste !== 'string') return missing(404, 'unknown', 'No such run-this ask is waiting.');
  const file = readBlockFile(ask.paste);
  if (!file.ok) return file;
  const verdict = checkBlock(file.block, extra);
  const refusals = verdict.ok ? [] : [...verdict.refusals];
  if (!shownVerbatim(file.block)) refusals.push({ rule: 'not-verbatim', message: 'The page cannot show this block exactly as it is, so it will not run it.' });
  return { ok: true, item: { key: `ask:${id}`, source: 'ask', target: id, title: String(ask.text ?? ''), command: file.block, sha256: sha256(file.block), readOnly: null, tier: null, spec: { kind: 'shell', command: file.block }, timeoutMs: ASK_TIMEOUT_MS, refusals } };
}
