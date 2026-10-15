/**
 * COMMAND GUARD: everything a block must pass before the Podium server will run it. The checks run on the text that is about to execute,
 * on the server, every time; the page's own copy of the text is never consulted.
 *
 * A block is refused when it fails paste-lint (the rules a block handed to a person already obeys), names a secret file (`.env*`, `ssm-*.json`,
 * as the secret-file hook does; templates such as `.env.example` are fine), dumps the environment, carries a secret-shaped string (so what
 * the page shows is what runs, never a withheld copy), is too big, or holds a NUL byte. Optionally the user's own secret-file hook is asked as well,
 * when it is installed; the built-in matcher is the floor and does not depend on it.
 */
import { lintBlock, toLines } from '../paste-lint.ts';
import { secretShaped } from '../withhold.ts';

export const MAX_BLOCK_BYTES = 64 * 1024;

export interface Refusal { rule: string; message: string; line?: number }
export type Verdict = { ok: true } | { ok: false; refusals: Refusal[] };

const TEMPLATE = /\.(?:example|sample|template)|^example\./i;
/** A path part that names a secret file: `.env`, `.env.local`, `.env*`, `prod.env`, `ssm-params.json`, `ssm-*`. */
/** A dot-file or `ssm*` word built with a glob or an expansion (`.e*`, `.en?`, `.[e]nv`, `.$(printf e)nv`, `ssm?params`): it can name a secret file without ever spelling it. */
const GLOBBED = /^\.[^\s]*[*?[$`]|^ssm[^\s]*[*?[$`]/i;
const PROTECTED = /^\.env|\.env(?:\.|$)|^ssm-/i;

/** The words of the text that name a protected file, found as written and again with quotes and backslashes removed (`.e"nv"`, `.en\v`). */
export function secretFileRefs(text: string): string[] {
  const hits = new Set<string>();
  for (const view of [text, text.replace(/["'\\`]/g, '')]) {
    for (const word of view.split(/[\s;&|<>(){}=,:]+/)) {
      for (const part of word.split('/')) {
        if (!part || TEMPLATE.test(part)) continue;
        if (PROTECTED.test(part) || GLOBBED.test(part)) hits.add(part);
      }
    }
  }
  return [...hits];
}

/** Commands that print the whole environment, where the secrets are. */
const ENV_DUMP = [
  /(?:^|[\s;&|(`{])(?:printenv|compgen|environ)(?![\w-])|(?:^|[\s;&|(`{])env\s*(?:$|[;&|)`}<>]|-[u0i]\b)|process\.env\b|os\.environ\b|ENV\[/,
  /(?:^|[;&|(]|\$\()\s*(?:\/usr\/bin\/)?(?:env|printenv)\s*(?:$|[;&|)<>]|-0\b|--null\b)/,
  /(?:^|[;&|(]|\$\()\s*(?:export|declare|typeset)\s+-[A-Za-z]*[xp][A-Za-z]*\s*(?:$|[;&|)])/,
  /(?:^|[;&|(]|\$\()\s*(?:export|set|declare|typeset)\s*(?:$|[;&|)])/,
  /\/proc\/[^\s/]+\/environ/,
];

function envDump(block: string): Refusal[] {
  return toLines(block).flatMap((l) => (ENV_DUMP.some((re) => re.test(l.code) || (re === ENV_DUMP[0] && re.test(l.raw))) ? [{ rule: 'env-dump', line: l.n, message: 'This line prints the environment, which holds secrets. Name the one variable you need.' }] : []));
}

/** The user's own secret-file hook, when it exists: asked in addition to the built-in matcher, never instead of it. */
export type ExtraGuard = (command: string) => string | null;

/** True when the block, as a whole, has a secret-shaped line (a pasted key or token). */
const secretLines = (block: string): number[] => block.split('\n').flatMap((l, i) => (secretShaped(l) ? [i + 1] : []));

/** Checks one shell block. Pure apart from the optional `extra` guard. */
export function checkBlock(block: string, extra?: ExtraGuard): Verdict {
  const refusals: Refusal[] = [];
  if (!block.trim()) refusals.push({ rule: 'empty', message: 'The block is empty.' });
  if (Buffer.byteLength(block) > MAX_BLOCK_BYTES) refusals.push({ rule: 'too-big', message: `The block is over ${MAX_BLOCK_BYTES / 1024} KB.` });
  if (block.includes('\0')) refusals.push({ rule: 'nul-byte', message: 'The block holds a NUL byte.' });
  if (refusals.length) return { ok: false, refusals };
  for (const f of lintBlock(block)) refusals.push({ rule: f.rule, line: f.line, message: `${f.message} Fix: ${f.fix}` });
  for (const ref of secretFileRefs(block)) refusals.push({ rule: 'secret-file', message: `The block names a secret file (${ref}). Reference variable names, never the files.` });
  refusals.push(...envDump(block));
  for (const n of secretLines(block)) refusals.push({ rule: 'secret-shaped', line: n, message: 'This line looks like a secret. Reference a variable name instead.' });
  const hook = extra?.(block);
  if (hook) refusals.push({ rule: 'secret-file-hook', message: hook });
  return refusals.length ? { ok: false, refusals } : { ok: true };
}

/** The refusals as printable text, for a log line or a CLI. */
export const describe = (v: Verdict): string => (v.ok ? 'ok' : v.refusals.map((r) => `[${r.rule}]${r.line ? ` line ${r.line}` : ''} ${r.message}`).join('\n'));
