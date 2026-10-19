/**
 * The merge-sweep's prune of the Others' PRs tab: a teammate PR card leaves the cache, and the review drafts queued for it are rejected, once the PR
 * is merged or closed, or once a person other than you, the author and the bots has reviewed or commented on it (the rule in lib/teammate/settled.ts,
 * read live per PR by lib/drafts/settle.ts). A PR you were asked to review and have not reviewed stays: that is the one exception the rule already makes.
 *
 * Idempotent: a second run finds nothing left to prune. A PR GitHub cannot be read for stays on the tab, and never makes the run fail. It posts nothing.
 */
import { settleStaleDrafts, readFacts } from '../drafts/settle.ts';
import type { SettledDraft } from '../drafts/settle.ts';
import { spawnRead } from '../drafts/reconcile.ts';
import type { GhRead } from '../drafts/reconcile.ts';
import { settledReason } from './settled.ts';
import { readOthersCache, writeOthersCache } from './others.ts';

export interface PrunedCard { repo: string; number: number; reason: string }
export interface PruneResult { cards: PrunedCard[]; drafts: SettledDraft[]; /** Cards whose PR could not be read and so were left. */ unread: number }
export interface PruneOptions { statusDir: string; draftsFile: string; self: string; run?: GhRead; now?: () => Date }

/** Drops settled cards from the cached tab and rejects settled drafts. Each pruned item is also passed to `log`. */
export function pruneOthers(o: PruneOptions, log: (line: string) => void = () => {}): PruneResult {
  const run = o.run ?? spawnRead;
  const cache = o.statusDir ? readOthersCache(o.statusDir) : null;
  const cards: PrunedCard[] = [];
  let unread = 0;
  if (cache) {
    const keep = cache.prs.filter((p) => {
      const facts = readFacts(run, p.repo, p.number, o.self);
      if (!facts) { unread += 1; return true; }
      const why = settledReason(facts);
      if (!why) return true;
      cards.push({ repo: p.repo, number: p.number, reason: why.text });
      return false;
    });
    if (cards.length) writeOthersCache(o.statusDir, { ...cache, prs: keep });
  }
  const drafts = settleStaleDrafts(o.draftsFile, o.self, { run, ...(o.now ? { now: o.now } : {}) });
  for (const c of cards) log(`pruned card ${c.repo}#${c.number}: ${c.reason}`);
  for (const d of drafts) log(`rejected draft ${d.id} on ${d.repo}#${d.pr}: ${d.reason}`);
  return { cards, drafts, unread };
}
