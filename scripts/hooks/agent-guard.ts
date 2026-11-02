#!/usr/bin/env node
/**
 * agent-guard.ts: the PreToolUse hook for the Agent tool that enforces the slim-mode agent rules, so a session on a monthly
 * budget cannot fan out to expensive agents. Applied only when the configured mode is `slim`; in full mode it allows and prints nothing.
 *
 *   1. `tool_input.model` must be set explicitly (haiku, sonnet, opus or a full model id).
 *   2. Opus is for planning only: `subagent_type` is `Plan`, or the description or prompt holds the word "plan".
 *   3. At or over the hard line (`hardFraction * todayAllowance`), sonnet and opus are denied; haiku still passes.
 *   4. A call a subagent makes itself (the harness sets `agent_id`) is not checked.
 *
 * Today's spend comes from the cache file the footer already keeps (`spendCacheFile(EVENT_DIR)`); ccusage is never run here, and a
 * missing or unreadable cache means rule 3 does not apply. A deny is the PreToolUse JSON on stdout, exit 0. Allow prints nothing.
 * Fails open: any error is one stderr line and the call proceeds, so on an error this guard is advisory, not a hard stop.
 */
import { fileURLToPath } from 'node:url';
import { BUDGET, EVENT_DIR, MODE, WATCH_TZ } from '../local-config.ts';
import { budgetOn, evaluate } from '../lib/budget.ts';
import type { BudgetConfig } from '../lib/budget.ts';
import { readCache, spendCacheFile } from '../lib/spend.ts';
import { localDate } from '../lib/status-page/priorities.ts';
import { printJson } from '../lib/json-out.ts';
import { failOpen, readInput } from './ledger-hook.ts';

export interface GuardCall { agent_id?: string; tool_input?: { model?: unknown; subagent_type?: unknown; description?: unknown; prompt?: unknown } }
export interface GuardCtx { mode: 'full' | 'slim'; /** Today's spend is at or over the hard line. */ overHard: boolean }
export interface Decision { deny: boolean; reason?: string }

const ALLOW: Decision = { deny: false };
const deny = (reason: string): Decision => ({ deny: true, reason });
const MODEL = /^(haiku|sonnet|opus|claude-[a-z0-9.-]+)$/i;
const PLAN = /\bplan\b/i;

/** The slim-mode verdict for one Agent call. Pure: the spend state arrives in `ctx`. */
export function decide(input: GuardCall, ctx: GuardCtx): Decision {
  if (ctx.mode !== 'slim' || input.agent_id) return ALLOW;
  const ti = input.tool_input ?? {};
  const model = typeof ti.model === 'string' ? ti.model.trim() : '';
  if (!MODEL.test(model)) return deny('Slim mode: pass model explicitly on every Agent call (haiku, sonnet, opus, or a full model id).');
  const family = /opus/i.test(model) ? 'opus' : /sonnet/i.test(model) ? 'sonnet' : 'haiku';
  if (family !== 'haiku' && ctx.overHard) return deny(`Slim mode: today's spend is at or over the hard line, so ${family} agents are blocked. Use haiku, or do only what the user explicitly asks.`);
  if (family === 'opus' && !isPlanning(ti)) return deny('Slim mode: opus is for planning only. Use subagent_type Plan or say "plan" in the description, else pass sonnet or haiku.');
  return ALLOW;
}

function isPlanning(ti: NonNullable<GuardCall['tool_input']>): boolean {
  return ti.subagent_type === 'Plan' || [ti.description, ti.prompt].some((t) => typeof t === 'string' && PLAN.test(t));
}

/** True when the cached spend for today is at or over `hardFraction * todayAllowance`; false when the budget is off, it is no budget day, or the cache is missing or unreadable. */
export function overHardLine(cfg: BudgetConfig, eventDir: string, tz: string, now: number): boolean {
  if (!budgetOn(cfg)) return false;
  const cache = readCache(spendCacheFile(eventDir));
  if (!cache) return false;
  const v = evaluate(cfg, localDate(new Date(now), tz), cache.daily);
  return v.todayAllowance > 0 && v.todaySpend >= cfg.hardFraction * v.todayAllowance;
}

/** The PreToolUse deny object for the hook's stdin JSON, or null to allow. */
export function run(stdin: string, ctx: GuardCtx): object | null {
  let input: GuardCall;
  try { input = JSON.parse(stdin || '{}') as GuardCall; } catch { return null; }
  const d = decide(input, ctx);
  return d.deny ? { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: d.reason } } : null;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  failOpen('agent-guard', () => {
    if (MODE !== 'slim') return;
    const input = readInput();
    const ctx: GuardCtx = { mode: MODE, overHard: overHardLine(BUDGET, EVENT_DIR, WATCH_TZ, Date.now()) };
    const out = run(JSON.stringify(input), ctx);
    if (out) printJson(out);
  });
  process.exit(0);
}
