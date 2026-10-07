/** What a blocked item waits for, read from its ledger gate token. Pure and DOM-free. */
import { longDate } from './glance.ts';
import type { PrCard } from './types.ts';

/** How a gate reads on a row: the words before the target, the target's label, and a link when one is known. */
export interface GateView { lead: string; label: string; url?: string; mono: boolean }

/** The ledger's gate grammar (journal.ts --gate): gh:pr:<repo>#N, date:YYYY-MM-DD or ticket:<id>. */
const GATE = /^(?:gh:pr:([\w.-]+(?:\/[\w.-]+)?)#(\d+)|date:(\d{4}-\d{2}-\d{2})|ticket:([\w.-]+))$/;

/**
 * A gate token as words and, for a pull request, a link labelled `repo#n`. The link comes from the open PR the server
 * already sent when one matches; failing that, an `owner/repo` token (checked against the strict grammar above) names
 * its GitHub pull request. A bare repo with no matching open PR stays plain text. Anything off-grammar is free text.
 */
export function gateView(gate: string, prs: Pick<PrCard, 'repo' | 'short' | 'number' | 'url'>[]): GateView {
  const m = GATE.exec(gate.trim());
  if (!m) return { lead: 'Waiting on', label: gate.trim(), mono: false };
  const [, repo, num, day, ticket] = m;
  if (day) return { lead: 'Waiting until', label: longDate(day) || day, mono: false };
  if (ticket) return { lead: 'Waiting on', label: ticket, mono: true };
  // `.` and `..` fit the character class but are not repo names; they would only resolve to the wrong github.com path.
  if (repo!.split('/').some((seg) => /^\.+$/.test(seg))) return { lead: 'Waiting on', label: gate.trim(), mono: false };
  const n = Number(num);
  const name = repo!.toLowerCase();
  const short = name.slice(name.lastIndexOf('/') + 1);
  const open = prs.find((p) => p.number === n && [p.repo.toLowerCase(), p.short.toLowerCase()].includes(name));
  const url = open?.url ?? (name.includes('/') ? `https://github.com/${repo}/pull/${n}` : undefined);
  return { lead: 'Waiting on', label: `${short}#${n}`, mono: true, ...(url ? { url } : {}) };
}
