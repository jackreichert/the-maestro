/**
 * Jira freeze guard: the decision behind scripts/hooks/jira-freeze-guard.ts.
 *
 * A ticket carrying a frozen label (the `next_frozen_labels` setting, e.g. `pilot-hold` in an org overlay) must never be
 * written to. Reads are never blocked. This repo has no Jira write code of its own: every write is an agent calling an Atlassian MCP
 * tool, so the single door is a PreToolUse hook, and this module is its logic (pure, with the label lookup injected).
 *
 * Fails closed: with frozen labels configured, a write whose ticket labels cannot be read is refused, and so is a write whose
 * tool name is not a known read. With no frozen labels configured the guard does nothing.
 */

/** Atlassian MCP tool names (any server prefix) that only read. Anything else on an Atlassian server counts as a write. */
const READ_TOOL = /^(get|search|fetch|lookup|list|find|atlassianuserinfo)/i;
const ISSUE_KEY = /^[A-Z][A-Z0-9_]*-\d+$/;
const ISSUE_FIELD = /^(issueidorkey|issuekey|issueid|issue|key|parent|parentkey|inwardissue|outwardissue|issues|issuekeys)$/i;

export interface Decision { deny: boolean; reason: string }
/** Labels of one issue, or undefined when they cannot be read. */
export type LabelLookup = (issue: string) => string[] | undefined;

/** The Atlassian tool's own name (`mcp__<server>__<tool>` -> `<tool>`), or undefined when this is not an Atlassian tool. */
export function atlassianTool(toolName: string): string | undefined {
  const m = /^mcp__(.+?)__(.+)$/.exec(toolName);
  return m && /atlassian|jira/i.test(m[1]) ? m[2] : undefined;
}

/** Every issue key or id a tool call names, and every label it would set, found anywhere in its input. */
export function targets(input: unknown): { issues: string[]; labelsBeingSet: string[] } {
  const issues = new Set<string>();
  const labels: string[] = [];
  const walk = (v: unknown, field: string, depth: number): void => {
    if (depth > 8 || v === null || v === undefined) return;
    if (typeof v === 'string' || typeof v === 'number') {
      const t = String(v).trim();
      if (ISSUE_KEY.test(t) || (ISSUE_FIELD.test(field) && /^\d+$/.test(t))) issues.add(t);
      if (/^labels$/i.test(field) && typeof v === 'string') labels.push(t);
      return;
    }
    if (Array.isArray(v)) { for (const x of v) walk(x, field, depth + 1); return; }
    if (typeof v === 'object') for (const [k, x] of Object.entries(v as Record<string, unknown>)) walk(x, k, depth + 1);
  };
  walk(input, '', 0);
  return { issues: [...issues], labelsBeingSet: labels };
}

/** Allow or refuse one tool call. `frozen` is compared without case. */
export function decide(toolName: string, input: unknown, frozen: string[], lookup: LabelLookup): Decision {
  const allow: Decision = { deny: false, reason: '' };
  const tool = atlassianTool(toolName);
  if (!tool || !frozen.length || READ_TOOL.test(tool)) return allow;
  const want = new Set(frozen.map((l) => l.toLowerCase()));
  const { issues, labelsBeingSet } = targets(input);
  const setting = labelsBeingSet.find((l) => want.has(l.toLowerCase()));
  if (setting) return { deny: true, reason: `jira-freeze-guard: ${tool} would set the frozen label "${setting}". Refused: nothing is written to a frozen ticket.` };
  for (const issue of issues) {
    const have = lookup(issue);
    if (!have) return { deny: true, reason: `jira-freeze-guard: ${tool} on ${issue} refused because its labels could not be read (set jira_labels_command; the guard fails closed while frozen labels are configured).` };
    const hit = have.find((l) => want.has(l.toLowerCase()));
    if (hit) return { deny: true, reason: `jira-freeze-guard: ${issue} carries the frozen label "${hit}", so ${tool} is refused. Never write to a frozen ticket; reads are fine.` };
  }
  return allow;
}
