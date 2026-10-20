#!/usr/bin/env node
/**
 * SLACK TRIAGE: the deterministic prefilter over slack-watch new-messages files (lib/slack-triage.ts holds the rules engine).
 *
 *   node scripts/slack-triage.ts [--rules <file.json>] [--tag <tag>] [--counts] <new-messages file>...
 *
 * Prints one JSON line per message: tag, channel group, playbook, file, line, time, author, verdict (drop, model, surface, escalate),
 * label, route, and the rule and reason behind it. It prints no message text; the reader opens the file at the line. `--counts`
 * prints one line of verdict totals instead, for the cost report. The rules file comes from `--rules`, else `slack_triage_rules`
 * in the config (relative to the overlay folder). Read-only: it never writes the notes, the ledger or Slack.
 *
 * Exit: 0 printed, 2 bad arguments or an unreadable or invalid rules file (the error names every problem).
 */
import { readFileSync, realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { countVerdicts, loadRules, triageText } from './lib/slack-triage.ts';
import type { Decision, TriageRules } from './lib/slack-triage.ts';
import { printJson } from './lib/json-out.ts';
import { SLACK_TRIAGE_RULES } from './local-config.ts';

const USAGE = 'node scripts/slack-triage.ts [--rules <file.json>] [--tag <tag>] [--counts] <new-messages file>...';

interface Options { rules: string; tag: string; counts: boolean; files: string[] }

function parseOptions(argv: string[]): Options | string {
  const o: Options = { rules: SLACK_TRIAGE_RULES, tag: '', counts: false, files: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === '--counts') { o.counts = true; continue; }
    if (a === '--rules' || a === '--tag') {
      const v = argv[++i];
      if (!v || v.startsWith('--')) return `${a} needs a value`;
      if (a === '--rules') o.rules = v; else o.tag = v;
      continue;
    }
    if (a.startsWith('--')) return `unknown option ${a}`;
    o.files.push(a);
  }
  if (!o.files.length) return 'name at least one new-messages file';
  if (!o.rules) return 'no rules file: pass --rules or set slack_triage_rules in the config';
  return o;
}

function main(argv: string[]): number {
  if (argv.includes('--help') || argv.includes('-h')) { console.log(USAGE); return 0; }
  const o = parseOptions(argv);
  if (typeof o === 'string') { console.error(`slack-triage: ${o}\n${USAGE}`); return 2; }
  let rules: TriageRules;
  try { rules = loadRules(o.rules); } catch (err) { console.error(`slack-triage: ${err instanceof Error ? err.message : String(err)}`); return 2; }
  const all: (Decision & { file: string })[] = [];
  for (const f of o.files) {
    let text: string;
    try { text = readFileSync(f, 'utf8'); } catch { console.error(`slack-triage: cannot read ${f}`); return 2; }
    const file = resolve(f);
    for (const d of triageText(text, file, rules, o.tag || undefined)) all.push({ ...d, file });
  }
  if (o.counts) { const c = countVerdicts(all); console.log(`messages=${all.length} drop=${c.drop} model=${c.model} surface=${c.surface} escalate=${c.escalate}`); return 0; }
  for (const d of all) printJson(d, { compact: true });
  return 0;
}

const isMain = (): boolean => { try { return realpathSync(process.argv[1] ?? '') === fileURLToPath(import.meta.url); } catch { return false; } };
if (isMain()) process.exitCode = main(process.argv.slice(2));
