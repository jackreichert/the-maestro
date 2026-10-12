/**
 * Whether a tool call only reads. Used to judge a subagent by the tools it actually called, not by the agent type's name.
 * Dependency-free so `pick` in token-metrics.ts can call it while it is the only code that looks at a transcript line;
 * only the boolean leaves, the command text never does.
 */

/** Tools that cannot change files, repositories or remote state. Anything not listed (an MCP tool, Skill, Agent) counts as a write. SubagentHandback only returns the report. */
const READ_ONLY_TOOLS = new Set(['Read', 'Grep', 'Glob', 'LS', 'WebFetch', 'WebSearch', 'ToolSearch', 'NotebookRead', 'TodoWrite', 'TaskGet', 'TaskList', 'SubagentHandback']);

const GIT_READS = 'status|log|diff|show|blame|rev-parse|rev-list|ls-files|ls-tree|merge-base|for-each-ref|cat-file|show-ref|describe|branch|remote|fetch|ls-remote|grep|worktree\\s+list';
/** Commands that read; a Bash call is read-only when every `;`, `&&`, `||` or pipe segment starts with one of these. */
const READ_ONLY_COMMAND = new RegExp(`^(ls|cat|head|tail|wc|pwd|echo|grep|rg|find|stat|file|which|tree|du|df|date|sort|uniq|cut|tr|jq|diff|basename|dirname|realpath|cd|awk|set|test|true|nl|readlink|sed\\s+-n|git\\s+(-C\\s+\\S+\\s+)?(${GIT_READS})|gh\\s+(pr|issue|run)\\s+(view|list|status|checks|diff))(\\s|$)`);
/** Anything that writes or runs something else: a redirect to a file, find's exec and delete, sed in place, tee, a git branch delete or rename. */
const WRITES = /(^|[^0-9&>])>{1,2}\s*[^&\s]|\s-exec\b|\s-delete\b|\bsed\s+(-\w*\s+)*-i|\btee\b|\bgit\s+(-C\s+\S+\s+)?branch\s+-[dDmMcC]/;
/** Substitution can run anything inside an argument, so it is never judged read-only. */
const SUBSTITUTION = /\$\(|`|<\(/;

/** The command with the text inside quotes emptied, so a `|` or `>` in a pattern is not mistaken for shell syntax. */
const unquoted = (command: string): string => command.replace(/'[^']*'|"(?:[^"\\]|\\.)*"/g, "''");

/** Whether one segment reads: a loop header or terminator, `do <cmd>`, or `xargs <cmd>` over a read-only command. */
function segmentReads(segment: string): boolean {
    const s = segment.replace(/^(\w+=\S+\s+)+/, '');
    if (/^(for\s+\w+\s+in\b.*|done|do)$/.test(s)) return true;
    if (s.startsWith('do ')) return segmentReads(s.slice(3).trim());
    const xargs = /^xargs\s+(-\S+\s+)*(.+)$/.exec(s);
    return READ_ONLY_COMMAND.test(xargs ? xargs[2] : s);
}

/** Whether one Bash command line only reads. A redirect to /dev/null does not count as a write. */
export function bashReadOnly(command: string): boolean {
    const cleaned = unquoted(command.replace(/\\\n/g, ' ')).replace(/\d*>\s*&\d|\d*>>?\s*\/dev\/null/g, '');
    if (SUBSTITUTION.test(command) || WRITES.test(cleaned)) return false;
    // Split on the original's separators outside quotes: the quoted text is already emptied above.
    const segments = cleaned.split(/&&|\|\||;|\||\n/).map((x) => x.trim()).filter(Boolean);
    return segments.length > 0 && segments.every(segmentReads);
}

/** Whether a tool call only reads. `command` is the Bash command line, ignored for other tools. */
export const toolReadOnly = (name: string, command = ''): boolean => (name === 'Bash' ? bashReadOnly(command) : READ_ONLY_TOOLS.has(name));
