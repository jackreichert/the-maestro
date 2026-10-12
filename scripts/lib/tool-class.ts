/**
 * Whether a tool call only reads. Used to judge a subagent by the tools it actually called, not by the agent type's name.
 * Dependency-free so `pick` in token-metrics.ts can call it while it is the only code that looks at a transcript line;
 * only the boolean leaves, the command text never does.
 */

/** Tools that cannot change files, repositories or remote state. Anything not listed (an MCP tool, Skill, Agent) counts as a write. */
const READ_ONLY_TOOLS = new Set(['Read', 'Grep', 'Glob', 'LS', 'WebFetch', 'WebSearch', 'ToolSearch', 'NotebookRead', 'TodoWrite', 'TaskGet', 'TaskList']);

/** Commands that read; a Bash call is read-only when every `;`, `&&`, `||` or pipe segment starts with one of these. */
const READ_ONLY_COMMAND = /^(ls|cat|head|tail|wc|pwd|echo|grep|rg|find|stat|file|which|tree|du|df|date|sort|uniq|cut|tr|jq|diff|basename|dirname|realpath|cd|git\s+(status|log|diff|show|blame|rev-parse|ls-files|branch|remote|fetch|ls-remote|grep)|gh\s+(pr|issue|run)\s+(view|list|status|checks|diff))(\s|$)/;
/** Anything that writes or runs something else: a redirect to a file, find's exec and delete, sed in place. */
const WRITES = /(^|[^0-9&>])>{1,2}\s*[^&\s]|\s-exec\b|\s-delete\b|\bsed\s+(-\w*\s+)*-i|\btee\b/;

/** Whether one Bash command line only reads. A redirect to /dev/null does not count as a write. */
export function bashReadOnly(command: string): boolean {
    const cleaned = command.replace(/\d*>\s*&\d|\d*>>?\s*\/dev\/null/g, '');
    if (WRITES.test(cleaned)) return false;
    const segments = cleaned.split(/&&|\|\||;|\||\n/).map((s) => s.trim().replace(/^(\w+=\S+\s+)+/, '')).filter(Boolean);
    return segments.length > 0 && segments.every((s) => READ_ONLY_COMMAND.test(s));
}

/** Whether a tool call only reads. `command` is the Bash command line, ignored for other tools. */
export const toolReadOnly = (name: string, command = ''): boolean => (name === 'Bash' ? bashReadOnly(command) : READ_ONLY_TOOLS.has(name));
