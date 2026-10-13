/**
 * The develop twin of a staging PR. In a repo that promotes work develop then staging, a PR into `staging` merges only after its
 * develop twin has merged, so the Podium must not call it ready before then. Everything here is pure; the one GitHub read that feeds
 * it (`RepoFlow`, per repo) is made by the PR fetch and stored in the PR cache, so a page load never reaches GitHub.
 */
import type { RawPr } from './generate.ts';

/** A develop PR paired with a staging PR. `merged` is false while it is open. */
export interface DevelopTwin { number: number; url: string; merged: boolean }

/** What the fetch learns about one repo: whether it has the develop-then-staging flow, and its recently merged develop PRs. */
export interface RepoFlow { hasDevelop: boolean; hasStaging: boolean; openDevelop: { number: number; url: string; head: string }[]; mergedDevelop: { number: number; url: string; head: string }[] }

/** A head branch without a trailing `-staging` or `-develop`, so `fix/x-staging` and `fix/x-develop` share a stem. */
export const branchStem = (head: string): string => head.replace(/-(staging|develop)$/, '');

const sameChange = (a: string, b: string): boolean => a === b || branchStem(a) === branchStem(b);

/** The develop PR for a staging PR's head branch (`open` is every open develop PR of the repo, whoever authored it): an open one wins over a merged one, the lowest number wins within each. Undefined when none matches. */
export function findDevelopTwin(head: string, open: { number: number; url: string; head: string }[], merged: { number: number; url: string; head: string }[]): DevelopTwin | undefined {
  const lowest = (list: { number: number; url: string; head: string }[]) => list.filter((c) => sameChange(c.head, head)).sort((a, b) => a.number - b.number)[0];
  const o = lowest(open);
  if (o) return { number: o.number, url: o.url, merged: false };
  const m = lowest(merged);
  return m ? { number: m.number, url: m.url, merged: true } : undefined;
}

/**
 * Marks each open staging PR in a develop-then-staging repo with its develop twin (`null`: none found). PRs elsewhere are returned
 * untouched, which is how a repo with no staging branch (or no develop branch) stays unaffected. `flowOf` is called once per repo
 * that has an open staging PR. A repo it cannot read (returns undefined) is marked `null`, so its staging PRs wait: a failed read must never turn into Ready.
 */
export function withDevelopTwins(raw: RawPr[], flowOf: (repo: string) => RepoFlow | undefined): RawPr[] {
  const flows = new Map<string, RepoFlow | undefined>();
  const flow = (repo: string): RepoFlow | undefined => {
    if (!flows.has(repo)) flows.set(repo, flowOf(repo));
    return flows.get(repo);
  };
  return raw.map((p) => {
    if (p.baseRefName !== 'staging') return p;
    const f = flow(p.repository.nameWithOwner);
    if (!f) return { ...p, developTwin: null };
    if (!f.hasDevelop || !f.hasStaging) return p;
    const open = [...f.openDevelop, ...raw.filter((o) => o.repository.nameWithOwner === p.repository.nameWithOwner && o.baseRefName === 'develop').map((o) => ({ number: o.number, url: o.url, head: o.headRefName }))];
    return { ...p, developTwin: findDevelopTwin(p.headRefName, open, f.mergedDevelop) ?? null };
  });
}

/** True when `v` is a stored `developTwin`: absent, null, or a twin with the three fields. */
export function isStoredTwin(v: unknown): boolean {
  if (v === undefined || v === null) return true;
  if (typeof v !== 'object') return false;
  const t = v as Record<string, unknown>;
  return typeof t.number === 'number' && typeof t.url === 'string' && typeof t.merged === 'boolean';
}
