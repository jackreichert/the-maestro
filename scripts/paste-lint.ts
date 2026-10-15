#!/usr/bin/env node
/**
 * PASTE LINT: checks command blocks handed to the user for their interactive zsh.
 *
 *   node scripts/paste-lint.ts <file>        a markdown file (its fenced bash/sh/zsh blocks) or a raw block file
 *   cat block.sh | node scripts/paste-lint.ts [--json]
 *
 * Run it on every block before it goes to the user; `journal.ts ask --paste` runs it too and refuses a block with findings.
 * A file or stdin holding a code fence is read as markdown and only its shell fences are checked; with no fence at all the
 * whole input is one raw block. Rules live in lib/paste-lint.ts.
 * Exit 0 clean, 1 on findings, 2 on bad usage.
 */
import { readFileSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { formatFindings, lintText } from './lib/paste-lint.ts';
import { printJson } from './lib/json-out.ts';

function main(argv: string[]): number {
  const json = argv.includes('--json');
  const files = argv.filter((a) => a !== '--json');
  if (files.length > 1 || files.some((f) => f.startsWith('-') && f !== '-')) { console.error('usage: paste-lint.ts [<file>] [--json]   (no file: read stdin)'); return 2; }
  const [file] = files;
  let text: string;
  try { text = readFileSync(file && file !== '-' ? file : 0, 'utf8'); } catch (e) { console.error(`paste-lint: cannot read ${file ?? 'stdin'}: ${(e as Error).message}`); return 2; }
  const findings = lintText(text);
  if (json) printJson(findings);
  else if (findings.length) console.error(formatFindings(findings, file ?? 'stdin'));
  else console.log('paste-lint: ok');
  return findings.length ? 1 : 0;
}

const isMain = () => { try { return realpathSync(process.argv[1]!) === fileURLToPath(import.meta.url); } catch { return false; } };
if (process.argv[1] && isMain()) process.exit(main(process.argv.slice(2)));
