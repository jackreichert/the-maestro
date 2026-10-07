/** Which open PRs name a ticket? A ticket id or tracker key in the head branch name or the title, at a token boundary (so `x-05` never matches `x-051`, and `x-5` never matches `arya-x-5`). */
import type { Pr } from '../status-page/render.ts';
import { isHttpUrl } from './config.ts';
import type { Ref } from './types.ts';

const escape = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const MAX_PRS = 3;

export function prsNaming(prs: Pr[], names: string[]): { shown: Ref[]; more: number } {
  const wanted = names.filter(Boolean).map((n) => new RegExp(`(?<![A-Za-z0-9_-])${escape(n)}(?![A-Za-z0-9])`, 'i'));
  if (!wanted.length) return { shown: [], more: 0 };
  const hits = prs.filter((p) => isHttpUrl(p.url) && wanted.some((re) => re.test(p.headRefName) || re.test(p.title))).sort((a, b) => a.repo.localeCompare(b.repo) || a.number - b.number);
  return { shown: hits.slice(0, MAX_PRS).map((p) => ({ label: `${p.short}#${p.number}`, url: p.url })), more: Math.max(0, hits.length - MAX_PRS) };
}
