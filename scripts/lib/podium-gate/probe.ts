/** The two ways the gate reaches a Podium: over HTTP (a live or temp server) and the library rule from this checkout's own code. */
import type { Probe, Reply } from './checks.ts';

const TIMEOUT_MS = 5000;

/** GET against a base URL. A refused connection or a timeout is status 0, never a throw. */
export function httpProbe(base: string, rule: Probe['plainLanguageRule'] = libraryRule): Probe {
  return {
    async get(path: string): Promise<Reply> {
      try {
        const r = await fetch(new URL(path, base), { signal: AbortSignal.timeout(TIMEOUT_MS) });
        return { status: r.status, text: await r.text() };
      } catch { return { status: 0, text: '' }; }
    },
    plainLanguageRule: rule,
  };
}

/** Whether this checkout's library check carries the plain-language rule and the rule flags a bare ticket id (and spares one cited as evidence). */
export async function libraryRule(): Promise<'absent' | 'works' | 'broken'> {
  try {
    const m = (await import('../library/rules.ts')) as { RULES?: { id: string }[]; bareIds?: (line: string, repos: ReadonlySet<string>) => string[] };
    if (!m.RULES?.some((r) => r.id === 'plain-language') || typeof m.bareIds !== 'function') return 'absent';
    const flagged = m.bareIds('- The sync follows MAESTRO-149 here.', new Set());
    const spared = m.bareIds('- The sync retries nightly (verified 2026-10-08, MAESTRO-149).', new Set());
    return flagged.length === 1 && spared.length === 0 ? 'works' : 'broken';
  } catch { return 'absent'; }
}
