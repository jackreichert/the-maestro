#!/usr/bin/env node
/**
 * CACHE LINT: checks that the agent-facing docs keep the rules that stop prompt-cache expiry rewrites.
 *
 *   node scripts/cache-lint.ts [--root <repo>] [--json]
 *
 * The prompt cache lives 5 minutes. An agent that idles longer rewrites its whole context on its next turn,
 * so the brief tells agents never to wait on a full suite and never to sit idle more than 4 minutes. That
 * rule used to be prose only. This script makes it a check, and a test (cache-lint.test.ts) runs it on this
 * repo, so a doc edit that drops the rule or adds a long idle wait fails the suite.
 *
 * Rules:
 *   suites-line      reference/brief.md's standing block keeps its Suites line with the detached-job command,
 *                    the 4-minute ceiling and the targeted-tests-only reviewer rule.
 *   long-sleep       no `sleep N` over 270 seconds in an agent-facing doc (270 keeps one wake inside the TTL).
 *                    One blocking call with a long --timeout is allowed: it costs one rewrite, not one per poll.
 *   foreground-suite no full-suite command (`npm test`, `node --test` with no test file) in a playbook or bolero
 *                    doc: those run as a detached suite-run.ts job.
 * Exit 0 clean, 1 on findings, 2 on bad usage.
 */
import { existsSync, readFileSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { printJson } from './lib/json-out.ts';
import { printJson } from './lib/json-out.ts';

export interface Finding { rule: string; file: string; line: number; text: string }

/** Longest single sleep an agent-facing doc may ask for, in seconds: under the 5-minute cache TTL with margin. */
export const MAX_SLEEP_S = 270;
const SUITES_NEEDLES = ['suite-run.ts', '4 minutes', 'targeted tests plus tsc'];
const FULL_SUITE = /^\s*(?:\$\s*)?(?:npm (?:run )?test\b|node (?:--[\w-]+ )*--test(?: --[\w-]+(?:=\S+)?)*\s*$)/;
const SLEEP = /\bsleep\s+(\d+(?:\.\d+)?)\s?(s|m|h|sec|secs|seconds?|min|mins|minutes?|hours?)?\b/g;

const toSeconds = (n: number, unit: string): number => n * (unit.startsWith('h') ? 3600 : unit.startsWith('m') ? 60 : 1);

/** The Suites bullet of the standing brief block, or undefined when it is gone. */
export function suitesLine(brief: string): string | undefined {
  return brief.split('\n').find((l) => /^-\s+Suites:/.test(l));
}

/** Lints one doc. `kind` picks the rules: the brief gets suites-line, a playbook or bolero doc gets foreground-suite, all get long-sleep. */
export function lintDoc(file: string, text: string, kind: 'brief' | 'playbook' | 'other'): Finding[] {
  const out: Finding[] = [];
  const lines = text.split('\n');
  let fenced = false;
  lines.forEach((raw, i) => {
    if (/^\s*```/.test(raw)) { fenced = !fenced; return; }
    for (const m of raw.matchAll(SLEEP)) {
      if (toSeconds(Number(m[1]), m[2] || 's') > MAX_SLEEP_S) out.push({ rule: 'long-sleep', file, line: i + 1, text: raw.trim().slice(0, 120) });
    }
    if (kind === 'playbook' && fenced && FULL_SUITE.test(raw)) out.push({ rule: 'foreground-suite', file, line: i + 1, text: raw.trim().slice(0, 120) });
  });
  if (kind === 'brief') {
    const line = suitesLine(text);
    const missing = line ? SUITES_NEEDLES.filter((n) => !line.includes(n)) : SUITES_NEEDLES;
    if (!line || missing.length) out.push({ rule: 'suites-line', file, line: line ? lines.indexOf(line) + 1 : 1, text: line ? `Suites line lacks: ${missing.join(', ')}` : 'no "- Suites:" line in the brief' });
  }
  return out;
}

const walk = (dir: string): string[] => !existsSync(dir) ? [] : readdirSync(dir).flatMap((n) => {
  const p = join(dir, n);
  return statSync(p).isDirectory() ? (n === 'node_modules' ? [] : walk(p)) : p.endsWith('.md') ? [p] : [];
});

/** Lints every agent-facing doc under `root`: reference/, playbooks/, bolero/, cost/ and SKILL.md. */
export function lintRepo(root: string): Finding[] {
  const files = [join(root, 'SKILL.md'), ...['reference', 'playbooks', 'bolero', 'cost'].flatMap((d) => walk(join(root, d)))].filter(existsSync);
  return files.flatMap((f) => {
    const rel = relative(root, f);
    const kind = rel === join('reference', 'brief.md') ? 'brief' : /^(playbooks|bolero)\//.test(rel) ? 'playbook' : 'other';
    return lintDoc(rel, readFileSync(f, 'utf8'), kind);
  });
}

function main(argv: string[]): number {
  let root = fileURLToPath(new URL('..', import.meta.url));
  let json = false;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--root' && argv[i + 1]) root = argv[++i]!;
    else if (argv[i] === '--json') json = true;
    else { console.error('usage: cache-lint.ts [--root <repo>] [--json]'); return 2; }
  }
  const findings = lintRepo(root);
  if (json) printJson(findings);
  else if (findings.length) for (const f of findings) console.error(`${f.file}:${f.line} [${f.rule}] ${f.text}`);
  else console.log('cache-lint: ok');
  return findings.length ? 1 : 0;
}

const isMain = () => { try { return realpathSync(process.argv[1]!) === fileURLToPath(import.meta.url); } catch { return false; } };
if (process.argv[1] && isMain()) process.exit(main(process.argv.slice(2)));
