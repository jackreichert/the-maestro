// Run: node --test scripts/lib/vault/tickets-parity.test.ts
// The in-process rollup is a port of xenophon's. This runs the REAL ticket.mjs on a throwaway fixture vault and asserts the
// numbers are the same. Set XENOPHON_TICKET_SCRIPT to point at another copy; the test is skipped (and says so) when none exists.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { buildForest, loadTickets, TICKET_DIR_SCOPES, TICKET_FILE_SCOPES } from './tickets.ts';
import type { Rollup } from './tickets.ts';
import { createReader } from './reader.ts';
import { buildFixture } from './fixture.ts';

const SCRIPT = process.env.XENOPHON_TICKET_SCRIPT || join(homedir(), '.claude/skills/xenophon/scripts/ticket.mjs');

/** ticket.mjs's `formatRollup`, to compare against the string it prints. */
function formatRollup(r: Rollup): string {
  if (!r.total) return '';
  return [`${r.closed}/${r.total} closed${r.direct === r.total ? '' : ` (${r.direct} direct)`}`, r.blocked ? `${r.blocked} blocked` : null, r.ptsTotal ? `${r.ptsDone}/${r.ptsTotal} pts` : null].filter(Boolean).join(', ');
}

const ticketmjs = (vault: string, project: string, ...args: string[]) => spawnSync(process.execPath, [SCRIPT, ...args, '--vault', vault, '--project', project], {
  encoding: 'utf8', env: { ...process.env, VAULT_ROOT: '', XENOPHON_CONFIG: '', XENOPHON_DECIDER: '' },
});

test('rollups equal ticket.mjs list --tree and show on the fixture vault', { skip: existsSync(SCRIPT) ? false : `ticket.mjs not found at ${SCRIPT}` }, () => {
  const fx = buildFixture();
  // ticket.mjs cannot read a file that is not readable, so the hostile notes the reader refuses are taken out for the comparison.
  chmodSync(join(fx.root, 'Projects/avonlea-api/Tickets/locked.md'), 0o644);
  for (const f of ['locked.md', 'link.md', 'huge.md']) rmSync(join(fx.root, 'Projects/avonlea-api/Tickets', f));
  const ours = loadTickets(createReader({ root: fx.root, dirScopes: TICKET_DIR_SCOPES, fileScopes: TICKET_FILE_SCOPES }), fx.root);
  const forest = buildForest(ours.tickets);

  const seen = new Set<string>();
  let warned = '';
  for (const project of ours.projects) {
    const r = ticketmjs(fx.root, project, 'list', '--tree', '--status', 'all');
    assert.equal(r.status, 0, r.stderr);
    warned += r.stderr;
    for (const line of r.stdout.split('\n')) {
      const m = line.replace(/^[ │├└─]+/, '').match(/^(\S+) \[\w+\] \S+ P\d+(?: \d+pt)? {2}.*?(?: {2}▣ (.*))?$/);
      if (!m || !forest.byId.has(m[1] as string)) continue;
      const id = m[1] as string;
      seen.add(id);
      assert.equal(formatRollup(forest.roll(id)), m[2] ?? '', `rollup of ${id}`);
    }
  }
  assert.ok(seen.size >= 15, `compared ${seen.size} tickets`);
  assert.ok(seen.has('avonlea-api-042') && seen.has('green-gables-001') && seen.has('avonlea-api-051'));
  assert.match(warned, /parent cycle/);
  assert.equal(forest.cycles.length, 1);

  const show = ticketmjs(fx.root, 'avonlea-api', 'show', 'avonlea-api-042');
  assert.equal(show.status, 0, show.stderr);
  assert.match(show.stdout, new RegExp(`rollup: ${formatRollup(forest.roll('avonlea-api-042')).replace(/[()/]/g, '\\$&')}`));
  const c = forest.roll('avonlea-api-042');
  assert.equal(c.total, 10);
});
