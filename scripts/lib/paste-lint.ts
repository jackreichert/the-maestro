/**
 * PASTE LINT: checks a command block meant for the user's interactive zsh before it is handed over.
 *
 * Each rule is one row of RULES (id, message, fix hint, a finder). A finder gets the block's logical lines
 * (continuations joined, heredoc bodies and quoted text blanked in `code`) and returns the indexes it flags.
 * Rules that cannot be checked reliably are left out on purpose; see README "paste-lint.ts".
 */

export interface Line { n: number; raw: string; code: string; noSingle: string }
export interface Finding { rule: string; line: number; text: string; message: string; fix: string }
export interface Rule { id: string; message: string; fix: string; find: (lines: Line[]) => number[] }

const CMD_START = String.raw`(?:^|&&|\|\||[;|(]|\$\()\s*(?:\w+=\S*\s+)*`;
const COMMANDS = 'uv|node|npx|npm|aws|psql|docker|python3?|gh|git|terraform|kubectl|make|pnpm|yarn|curl|pg_dump|cargo|go';
const URI_ISH = /(?:^|["'=])\w[\w+.-]*:\/\/|\$\{?\w*(?:URL|URI|DSN|CONN\w*)\}?/i;

/** Blanks quoted text (keeping length and the quote marks). `single` only blanks single quotes. */
function blankQuotes(s: string, single: boolean): string {
  let out = '';
  let q = '';
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!;
    if (q) {
      if (c === q) { q = ''; out += c; } else if (c === '\\' && q === '"') { out += '  '; i++; } else out += single && q === '"' ? c : ' ';
    } else if (c === '\\') { out += c + (s[i + 1] ?? ''); i++; } else if (c === '"' || c === "'") { q = c; out += c; } else out += c;
  }
  return out;
}

/** Splits a block into logical lines: `\` continuations joined, heredoc bodies dropped. */
export function toLines(block: string): Line[] {
  const lines: Line[] = [];
  const src = block.split('\n');
  let heredoc = '';
  for (let i = 0; i < src.length; i++) {
    const n = i + 1;
    let raw = src[i]!;
    if (heredoc) { if (raw.trim() === heredoc) heredoc = ''; continue; }
    while (raw.endsWith('\\') && i + 1 < src.length) raw = raw.slice(0, -1) + ' ' + src[++i]!.trim();
    const h = blankQuotes(raw, false).includes('<<') ? raw.match(/<<-?\s*['"\\]?([A-Za-z_]\w*)['"]?/) : null;
    if (h) heredoc = h[1]!;
    lines.push({ n, raw, code: blankQuotes(raw, false), noSingle: blankQuotes(raw, true) });
  }
  return lines;
}

/** A finder that flags every line whose `code` matches. */
const onCode = (re: RegExp) => (lines: Line[]): number[] => lines.flatMap((l, i) => (re.test(l.code) ? [i] : []));

/** Splits one command on whitespace, quotes kept in the token, stopping at an unquoted `|`, `&` or `;`. */
function words(from: string): string[] {
  const out: string[] = [];
  let cur = '';
  let q = '';
  for (const c of from) {
    if (q) { cur += c; if (c === q) q = ''; continue; }
    if (c === '"' || c === "'") { q = c; cur += c; } else if (/[|&;]/.test(c)) break;
    else if (/\s/.test(c)) { if (cur) out.push(cur); cur = ''; } else cur += c;
  }
  if (cur) out.push(cur);
  return out;
}

/** psql options whose next word is their value, never a connection string. */
const VALUE_OPTS = new Set(['-c', '--command', '-v', '--set', '--variable', '-f', '--file', '-o', '--output', '-h', '--host', '-p', '--port', '-U', '--username', '-F', '-P', '-T', '-L', '-R', '-b']);

/** psql given a connection URI (literal or a *_URL variable) as its own argument, plus -d/--dbname: psql ignores -d. */
function psqlUriWithDbname(lines: Line[]): number[] {
  return lines.flatMap((l, i) => {
    const at = l.code.search(new RegExp(CMD_START + String.raw`psql\b`));
    if (at < 0) return [];
    const w = words(l.raw.slice(l.raw.indexOf('psql', Math.max(0, at))));
    const isFlag = (t: string) => t === '-d' || t === '--dbname';
    const isDb = (t: string) => isFlag(t) || /^--dbname=/.test(t) || /^-d\S/.test(t);
    const dbValue = (t: string, j: number) => (isFlag(t) ? w[j + 1] ?? '' : t.replace(/^--dbname=|^-d/, ''));
    const uris = w.filter((t, j) => !t.startsWith('-') && URI_ISH.test(t) && !isFlag(w[j - 1] ?? '') && !VALUE_OPTS.has(w[j - 1] ?? ''));
    const dbFlag = w.some((t, j) => isDb(t) && !URI_ISH.test(dbValue(t, j)));
    return uris.length && dbFlag ? [i] : [];
  });
}

/** A `#` after whitespace on a line that already has a command, outside quotes. */
function inlineComment(lines: Line[]): number[] {
  return lines.flatMap((l, i) => (/\S\s+#/.test(l.code.replace(/\\#/g, '  ')) ? [i] : []));
}

/** NAME="uv run ..." (a command line in a string) later used as a bare `$NAME` command. */
function stringCommandVar(lines: Line[]): number[] {
  const names = new Set<string>();
  const out: number[] = [];
  lines.forEach((l, i) => {
    const m = l.raw.match(new RegExp(String.raw`^\s*(?:export\s+|local\s+)?([A-Za-z_]\w*)=(["'])(?:${COMMANDS})\s+[^"']*\2\s*$`));
    if (m) { names.add(m[1]!); return; }
    for (const name of names) if (new RegExp(CMD_START + String.raw`\$(?:${name}|\{${name}\})(?:\s|$)`).test(l.code)) out.push(i);
  });
  return [...new Set(out)];
}

export const RULES: Rule[] = [
  {
    id: 'psql-uri-dbname',
    message: 'psql ignores -d/--dbname when it is given a connection URI, so the command runs against the URI database, not the one named.',
    fix: 'Put the database in the URI path (postgres://user@host:5432/<db>) and drop -d, or drop the URI and pass -h/-U/-d.',
    find: psqlUriWithDbname,
  },
  {
    id: 'inline-comment',
    message: 'Inline # comment: interactive zsh has comments off, so # becomes a command and the line before it can run partly or not at all.',
    fix: 'Move the note outside the block, or put it in an echo.',
    find: inlineComment,
  },
  {
    id: 'string-command-var',
    message: 'A command line stored in a string variable and run as $VAR: zsh does not word-split $VAR, so it looks for one command with that whole name.',
    fix: 'Define a function: M() { uv run ... "$@"; }, then call M.',
    find: stringCommandVar,
  },
  {
    id: 'modifier-needs-braces',
    message: 'A history-style modifier after a bare variable ("$X:r") is easy to misread and breaks when a word character follows.',
    fix: 'Use the braced form: "${X:r}".',
    find: (lines) => lines.flatMap((l, i) => (/\$[A-Za-z_]\w*:(?:[rhteluqQaA])(?![\w])/.test(l.noSingle) ? [i] : [])),
  },
  {
    id: 'bare-node-ts',
    message: 'Bare node running a .ts file: the terminal default is Node 16, which cannot run TypeScript.',
    fix: 'Call /opt/homebrew/bin/node explicitly.',
    find: onCode(new RegExp(CMD_START + String.raw`node\s+(?:-\S+\s+)*\S*\.ts\b`)),
  },
  {
    id: 'github-merge-approve',
    message: 'A paste block must not merge or approve on GitHub: that is the user\'s deliberate step, and a block can be run thinking it is local-only.',
    fix: 'Delete the step and say "merge #N when ready" outside the block.',
    find: onCode(new RegExp(CMD_START + String.raw`gh\s+pr\s+(?:merge\b|approve\b|review\b[^|&;]*(?:--approve|\s-a\b))`)),
  },
];

/** Lints one block of shell; `offset` is added to line numbers so findings point into the source file. */
export function lintBlock(block: string, offset = 0, rules: Rule[] = RULES): Finding[] {
  const lines = toLines(block);
  return rules.flatMap((r) => r.find(lines).map((i) => ({
    rule: r.id, line: lines[i]!.n + offset, text: lines[i]!.raw.trim(), message: r.message, fix: r.fix,
  }))).sort((a, b) => a.line - b.line || a.rule.localeCompare(b.rule));
}

/** The fenced bash/sh/zsh/shell blocks of a markdown document, with the line each body starts after. */
export function fencedBlocks(markdown: string): { body: string; offset: number }[] {
  const out: { body: string; offset: number }[] = [];
  const re = /^( {0,3})(`{3,}|~{3,})[ \t]*(bash|sh|zsh|shell|console)?[^\n]*\n([\s\S]*?)^\1?\2[`~]*[ \t]*$/gim;
  for (const m of markdown.matchAll(re)) {
    if (!m[3]) continue;
    const before = markdown.slice(0, m.index! + m[0].indexOf('\n') + 1);
    out.push({ body: m[4]!, offset: before.split('\n').length - 1 });
  }
  return out;
}

/** Lints text that holds fenced shell blocks; with no fence at all the whole text is one raw block (a block file). */
export function lintText(text: string): Finding[] {
  if (!/^ {0,3}(`{3,}|~{3,})/m.test(text)) return lintBlock(text);
  return fencedBlocks(text).flatMap((b) => lintBlock(b.body, b.offset));
}

/** Findings as printable lines: location, rule, the offending text, then message and fix. */
export function formatFindings(findings: Finding[], label = 'block'): string {
  return findings.map((f) => `${label}:${f.line} [${f.rule}] ${f.text}\n  ${f.message}\n  fix: ${f.fix}`).join('\n');
}
