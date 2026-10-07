/**
 * Which stream does a ticket tree belong to? Each root ticket (a ticket with no parent in the vault) is a unit, an epic when
 * it has children and a loose ticket when it has none; an epic the config lists by id is a unit too, even when nested. Rules
 * run in order and the first that decides wins; a unit belongs to exactly one stream, or to none when a rule is ambiguous.
 *   1. config: the stream lists the epic and does not exclude it
 *   2. ledger: the stream has the most ledger items linked to a ticket in the unit's tree (a tie is ambiguous)
 *   3. label: the unit carries `stream-<slug>` (two streams with the same slug are ambiguous)
 *   4. project: the unit's project is listed under exactly one stream (listed under two claims nothing)
 * A stream's `exclude` removes a unit from that stream under every rule. Rules are table entries, not an if-chain.
 */
import type { Forest } from '../vault/tickets.ts';
import type { Homes } from './config.ts';

export type Rule = 'config' | 'ledger' | 'label' | 'project';
/** One ledger item linked to a ticket, filed under a stream. */
export interface LedgerLink { stream: string; ticket: string }
export interface Claim { stream: string; rule: Rule }
export interface Ambiguity { rule: Rule; streams: string[] }
export interface Mapping { claims: Map<string, Claim>; ambiguous: Map<string, Ambiguity>; units: string[] }

export const slugOf = (stream: string): string => stream.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');

/** The ids of `id` and everything below it. */
export function subtree(forest: Forest, id: string): string[] {
  const out: string[] = [];
  const stack = [id];
  while (stack.length) {
    const cur = stack.pop() as string;
    out.push(cur);
    for (const c of forest.children(cur)) stack.push(c.id);
  }
  return out;
}

/** What a rule decides for a unit: no opinion (null), one stream, or several streams that tie. */
type Verdict = { streams: string[]; sure: boolean } | null;
interface Ctx { forest: Forest; homes: Homes; streams: string[]; links: LedgerLink[]; unit: string; eligible: string[] }
const RULES: { name: Rule; decide: (c: Ctx) => Verdict }[] = [
  { name: 'config', decide: (c) => verdict(c.eligible.filter((s) => c.homes.streams[s]?.epics.includes(c.unit))) },
  {
    name: 'ledger',
    decide: (c) => {
      const tree = new Set(subtree(c.forest, c.unit));
      const counts = new Map<string, number>();
      for (const l of c.links) if (tree.has(l.ticket) && c.eligible.includes(l.stream)) counts.set(l.stream, (counts.get(l.stream) ?? 0) + 1);
      const top = Math.max(0, ...counts.values());
      return verdict(top ? [...counts].filter(([, n]) => n === top).map(([s]) => s) : []);
    },
  },
  { name: 'label', decide: (c) => verdict(c.eligible.filter((s) => (c.forest.byId.get(c.unit)?.labels ?? []).includes(`stream-${slugOf(s)}`))) },
  {
    name: 'project',
    decide: (c) => {
      const project = c.forest.byId.get(c.unit)?.project;
      const owners = c.eligible.filter((s) => project && c.homes.streams[s]?.projects.includes(project));
      return owners.length === 1 ? { streams: owners, sure: true } : null;   // a project two streams list claims nothing
    },
  },
];
const verdict = (streams: string[]): Verdict => (streams.length ? { streams, sure: streams.length === 1 } : null);

export function mapUnits(forest: Forest, homes: Homes, streams: string[], links: LedgerLink[]): Mapping {
  const claims = new Map<string, Claim>();
  const ambiguous = new Map<string, Ambiguity>();
  const configured = Object.values(homes.streams).flatMap((s) => s.epics).filter((id) => forest.byId.has(id));
  const units = [...new Set([...[...forest.byId.keys()].filter((id) => !forest.parentOf.has(id)), ...configured])].sort();
  for (const unit of units) {
    const eligible = streams.filter((s) => !homes.streams[s]?.exclude.includes(unit));
    for (const rule of RULES) {
      const v = rule.decide({ forest, homes, streams, links, unit, eligible });
      if (!v) continue;
      if (v.sure) claims.set(unit, { stream: v.streams[0] as string, rule: rule.name }); else ambiguous.set(unit, { rule: rule.name, streams: v.streams });
      break;
    }
  }
  return { claims, ambiguous, units };
}
