/**
 * The shared engine for "tagged source" watchers: poll something cheap for every tag in a registry, do nothing when it has
 * not moved, and only on a change run the refresh and emit ONE actionable line. No model is involved until that line.
 * A source (Notion today; a tracker later) supplies a TagAdapter; this file owns what must be the same for all of them:
 * the loop state, rate-limit backoff, failure counting, de-duplication and the wording of the events.
 *
 *   probe(registry, tags)   one cheap call for every tag: unchanged / changed / gone (404, 403, archived), or rate-limited, or an error
 *   refresh(registry, tag)  re-pull one changed tag: same (moved but nothing to read) / changed (note, diff file, +/- counts) / gone / rate-limited / error
 *
 * Events:  <LABEL>-CHANGED tag=<tag> note=<path> diff=<path> summary=+A/-R lines      actionable
 *          <LABEL>-UNSHARED tag=<tag> reason=<404|403|archived>                         actionable, once per transition
 *          <LABEL>-CHECK-FAILING tag=<tag> <message>                                    informational, once after 3 failures in a row
 * A 429 is silent: the engine waits out Retry-After (at least a minute) and checks again; nothing is reported for it.
 * The target of a watch is the registry file (an absolute path to a .json file).
 */
import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { CheckContext, EventType, Run, WatchEvent } from './types.ts';

export type ProbeVerdict = 'unchanged' | 'changed' | { gone: string };
export type ProbeResult =
  | { kind: 'ok'; tags: Record<string, ProbeVerdict> }
  | { kind: 'rate-limited'; retryAfter: number }
  | { kind: 'error'; message: string };
export type RefreshResult =
  | { kind: 'same' }
  | { kind: 'changed'; id: string; note: string; diff: string; added: number; removed: number }
  | { kind: 'gone'; reason: string }
  | { kind: 'rate-limited'; retryAfter: number }
  | { kind: 'error'; message: string };

export interface TagAdapter {
  /** Upper-case event prefix, e.g. NOTION. */
  label: string;
  tags(registryFile: string): string[];
  probe(registryFile: string, tags: string[], run: Run): ProbeResult;
  refresh(registryFile: string, tag: string, run: Run): RefreshResult;
}

export interface TagState { status: 'ok' | 'unshared'; reason: string; fails: number; error: string; change: { id: string; note: string; diff: string; added: number; removed: number } | null }
export interface TagWatchState { tags: Record<string, TagState>; retryAt: number }

const FAILURES_BEFORE_EVENT = 3;
const MIN_BACKOFF_S = 60;
const blank = (): TagState => ({ status: 'ok', reason: '', fails: 0, error: '', change: null });

/** One tick for one registry. Never throws for a source problem: it records it in the state instead. */
export function checkTags(adapter: TagAdapter, registryFile: string, ctx: Pick<CheckContext, 'run' | 'now' | 'prev'>): TagWatchState {
  const prev = (ctx.prev as TagWatchState | null | undefined) ?? { tags: {}, retryAt: 0 };
  if (prev.retryAt > ctx.now) return prev;
  const names = adapter.tags(registryFile);
  const next: TagWatchState = { tags: Object.fromEntries(names.map((t) => [t, { ...(prev.tags[t] ?? blank()) }])), retryAt: 0 };
  const failAll = (message: string): TagWatchState => {
    for (const s of Object.values(next.tags)) { s.fails += 1; s.error = message; }
    return next;
  };
  if (!names.length) return next;
  const probe = adapter.probe(registryFile, names, ctx.run);
  if (probe.kind === 'error') return failAll(probe.message);
  if (probe.kind === 'rate-limited') return { ...prev, tags: next.tags, retryAt: ctx.now + Math.max(MIN_BACKOFF_S, probe.retryAfter) * 1000 };
  for (const tag of names) {
    const verdict = probe.tags[tag] ?? 'unchanged';
    const state = next.tags[tag] as TagState;
    if (typeof verdict === 'object') { Object.assign(state, { status: 'unshared', reason: verdict.gone, fails: 0, error: '' }); continue; }
    if (verdict === 'unchanged') { Object.assign(state, { status: 'ok', reason: '', fails: 0, error: '' }); continue; }
    const r = adapter.refresh(registryFile, tag, ctx.run);
    if (r.kind === 'rate-limited') return { ...next, retryAt: ctx.now + Math.max(MIN_BACKOFF_S, r.retryAfter) * 1000 };
    if (r.kind === 'error') { state.fails += 1; state.error = r.message; continue; }
    if (r.kind === 'gone') { Object.assign(state, { status: 'unshared', reason: r.reason, fails: 0, error: '' }); continue; }
    Object.assign(state, { status: 'ok', reason: '', fails: 0, error: '' });
    if (r.kind === 'changed') state.change = { id: r.id, note: r.note, diff: r.diff, added: r.added, removed: r.removed };
  }
  return next;
}

/** The events for a state change. A change speaks once (by its id), a transition into unshared once, a failing check once. */
export function tagEvents(label: string, prev: TagWatchState | null, next: TagWatchState): WatchEvent[] {
  const events: WatchEvent[] = [];
  for (const [tag, s] of Object.entries(next.tags)) {
    const before = prev?.tags[tag];
    if (s.change && s.change.id !== before?.change?.id) events.push({ summary: `${label}-CHANGED tag=${tag} note=${s.change.note} diff=${s.change.diff} summary=+${s.change.added}/-${s.change.removed} lines`, actionable: true });
    if (s.status === 'unshared' && before?.status !== 'unshared') events.push({ summary: `${label}-UNSHARED tag=${tag} reason=${s.reason}`, actionable: true });
    if (s.fails === FAILURES_BEFORE_EVENT && (before?.fails ?? 0) < FAILURES_BEFORE_EVENT) events.push({ summary: `${label}-CHECK-FAILING tag=${tag} ${s.error}`, actionable: false });
  }
  return events;
}

/** `<this repo>/../<skill>`, `~/dev-env/skills/<skill>`, `~/.claude/skills/<skill>`: first with `rel` inside. `<SKILL>_DIR` in the environment wins. */
export function findSkillFile(skill: string, rel: string, env: NodeJS.ProcessEnv = process.env): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const override = env[`${skill.toUpperCase().replace(/-/g, '_')}_DIR`];
  const roots = [override, join(here, '..', '..', '..', skill), join(homedir(), 'dev-env', 'skills', skill), join(homedir(), '.claude', 'skills', skill)].filter((r): r is string => Boolean(r));
  const found = roots.map((r) => join(r, rel)).find((f) => existsSync(f));
  if (!found) throw new Error(`the ${skill} skill is not installed (looked for ${rel} under: ${roots.join(', ')}); set ${skill.toUpperCase().replace(/-/g, '_')}_DIR`);
  return found;
}

/** An event type over a lazily loaded adapter, so a missing skill fails one check loudly instead of breaking the loop at import. */
export function tagWatchType(skill: string, adapterFile: string, defaults: { interval: number }): Required<Pick<EventType<TagWatchState>, 'check' | 'diff' | 'validate' | 'defaultTtlMs'>> & { interval: number; network: true; notifies: 'default'; backoff: false; slowInQuiet: true } {
  let adapter: TagAdapter | null = null;
  const load = (): TagAdapter => (adapter ??= createRequire(import.meta.url)(findSkillFile(skill, adapterFile)) as TagAdapter);
  return {
    interval: defaults.interval,
    network: true,
    notifies: 'default',
    backoff: false,
    slowInQuiet: true,
    check: (target, ctx) => checkTags(load(), target, ctx),
    diff: (prev, next) => tagEvents(load().label, prev, next),
    validate(target) {
      if (!isAbsolute(target) || !target.endsWith('.json')) throw new Error(`target must be the absolute path of the tag registry (a .json file), got "${target}"`);
    },
    // The old watcher ran until stopped, like pr-watch: a watch lives 72h, not the loop's 24h.
    defaultTtlMs: () => 72 * 3600 * 1000,
  };
}
