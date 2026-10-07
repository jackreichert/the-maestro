/**
 * A throwaway FICTIONAL vault for tests, built from code in a temp dir (never a copy of real data). It holds tickets in
 * several shapes, files the reader must refuse (broken, unreadable, oversize, symlinked), and decoy secret-pattern files
 * each holding a unique canary string that must never appear in any output. `snapshot` fingerprints every file so a test
 * can assert the vault is byte-identical after the code under test has run.
 */
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, symlinkSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export interface NoteSpec {
  id: string; title: string; status?: string; type?: string; priority?: number; parent?: string; labels?: string[]; blockedBy?: string[];
  external?: string; points?: number; updated?: string; created?: string; done?: string; verified?: string;
}

const q = (v: string): string => `"${v.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
const list = (a: string[] = []): string => (a.length ? `[${a.map(q).join(', ')}]` : '[]');

/** A ticket note in the shape ticket.mjs writes. */
export function noteText(s: NoteSpec): string {
  const fm = ['---', `id: ${q(s.id)}`, `title: ${q(s.title)}`, `status: ${q(s.status ?? 'open')}`, 'reviewed: false', `type: ${q(s.type ?? 'task')}`, `priority: ${s.priority ?? 2}`,
    `labels: ${list(s.labels)}`, `blocked-by: ${list(s.blockedBy)}`, `parent: ${s.parent ? q(s.parent) : ''}`, `external: ${s.external ? q(s.external) : ''}`,
    `created: ${s.created ?? '2026-09-01'}`, `updated: ${s.updated ?? '2026-10-01'}`, '---', ''];
  const body = [`# ${s.id} — ${s.title}`, ''];
  if (s.done) body.push('## What done looks like', '', s.done, '');
  if (s.points) body.push('## Estimate', '', `${s.points} story points`, '');
  if (s.verified) body.push('## Verified', '', s.verified, '');
  return [...fm, ...body].join('\n');
}

export interface Fixture { root: string; outside: string; canaries: string[]; write: (rel: string, text: string) => void }

/** Unique, greppable strings; a test searches every response for each of them. */
export const CANARIES = ['CANARY-ENV-7f3a', 'CANARY-SSM-91bc', 'CANARY-TFVARS-5d2e', 'CANARY-TFSTATE-c40a', 'CANARY-KEY-e18d', 'CANARY-NPMRC-2b77', 'CANARY-CREDS-a6f1', 'CANARY-SECRETMD-3e90'];

export function buildFixture(): Fixture {
  const base = mkdtempSync(join(tmpdir(), 'home-vault-'));
  const root = join(base, 'vault');
  const outside = join(base, 'outside');
  mkdirSync(root, { recursive: true });
  mkdirSync(outside, { recursive: true });
  const write = (rel: string, text: string): void => { mkdirSync(join(root, rel, '..'), { recursive: true }); writeFileSync(join(root, rel), text); };
  const t = (project: string, spec: NoteSpec, archived = false): void => write(`Projects/${project}/Tickets/${archived ? 'Archive/' : ''}${spec.id}.md`, noteText(spec));

  const A = 'avonlea-api';
  t(A, { id: 'avonlea-api-042', title: 'Move the sync to the new pipeline', type: 'epic', priority: 1, status: 'in-progress', external: 'jira-AV-1201', done: 'The new pipeline is primary for seven days. Nothing reads the old one.' });
  t(A, { id: 'avonlea-api-043', title: 'Port the loader', status: 'closed', parent: 'avonlea-api-042', points: 2, verified: '2026-10-02 checked the loader on the staging copy' });
  t(A, { id: 'avonlea-api-044', title: 'Port the validator', status: 'closed', parent: 'avonlea-api-042', points: 3 });
  t(A, { id: 'avonlea-api-045', title: 'Backfill the archive', status: 'in-progress', parent: 'avonlea-api-042', points: 3, external: 'AV-1202', updated: '2026-09-01' });
  t(A, { id: 'avonlea-api-046', title: 'Rate limit', status: 'blocked', parent: 'avonlea-api-042', points: 2 });
  t(A, { id: 'avonlea-api-047', title: 'Alerts', parent: 'avonlea-api-042', blockedBy: ['avonlea-api-046'], points: 5 });
  t(A, { id: 'avonlea-api-048', title: 'Cutover rehearsal', type: 'epic', parent: 'avonlea-api-042' });
  t(A, { id: 'avonlea-api-049', title: 'Rehearsal data', status: 'closed', parent: 'avonlea-api-048', points: 2 });
  t(A, { id: 'avonlea-api-050', title: 'Rehearsal runbook', parent: 'avonlea-api-048', points: 8 });
  t(A, { id: 'avonlea-api-051', title: 'Retire the old cron', status: 'closed', parent: 'avonlea-api-042', points: 1 }, true);
  t(A, { id: 'avonlea-api-052', title: 'Document the pipeline', parent: 'avonlea-api-042' });
  t(A, { id: 'avonlea-api-060', title: 'A loose fix', priority: 3 });
  t('green-gables', { id: 'green-gables-001', title: 'Pilot readiness', type: 'epic', labels: ['stream-green-gables'] });
  t('green-gables', { id: 'green-gables-002', title: 'Pilot checklist', parent: 'green-gables-001', status: 'closed', points: 1 });
  t('green-gables', { id: 'green-gables-003', title: 'Cross-project child', parent: 'green-gables-001', points: 2 });
  t(A, { id: 'avonlea-api-070', title: 'Child of another project', parent: 'green-gables-001' });
  t('loop-lab', { id: 'loop-lab-001', title: 'One', parent: 'loop-lab-002' });
  t('loop-lab', { id: 'loop-lab-002', title: 'Two', parent: 'loop-lab-001' });
  write(`Projects/${A}/Tickets/_Index.md`, '# index\n');
  write(`Projects/${A}/Tickets/no-frontmatter.md`, '# no frontmatter here\n');
  write(`Projects/${A}/Tickets/huge.md`, `---\nid: "avonlea-api-999"\ntitle: "huge"\n---\n${'x'.repeat(300 * 1024)}`);
  write(`Projects/${A}/Tickets/locked.md`, noteText({ id: 'avonlea-api-998', title: 'locked' }));
  chmodSync(join(root, `Projects/${A}/Tickets/locked.md`), 0);
  writeFileSync(join(outside, 'outside-ticket.md'), noteText({ id: 'outside-001', title: 'outside the vault' }));
  symlinkSync(join(outside, 'outside-ticket.md'), join(root, `Projects/${A}/Tickets/link.md`));
  symlinkSync(outside, join(root, 'Projects/outside-dir'));

  // Docs for the link rail.
  write(`Projects/${A}/CONTEXT.md`, '---\ntitle: Avonlea API context\n---\n# Context\n');
  write(`Projects/${A}/DECISIONS.md`, '# Decisions\n');
  write(`Projects/${A}/Plans/2026-10-01-cutover.md`, '---\nstatus: active\nupdated: 2026-10-01\n---\n# Cutover plan\n');
  write(`Projects/${A}/Plans/2026-09-01-old.md`, '---\nstatus: done\nupdated: 2026-09-02\n---\n# Old plan\n');
  write(`Projects/${A}/Research/notes.md`, '# Research notes\n');
  write(`Projects/${A}/Runbooks/cutover.md`, '# Cutover runbook\n');

  // Decoys: secret-pattern names next to every root. None may be opened, listed or echoed.
  const decoys: [string, string][] = [['.env.local', 'CANARY-ENV-7f3a'], ['ssm-test.json', 'CANARY-SSM-91bc'], ['prod.tfvars', 'CANARY-TFVARS-5d2e'], ['terraform.tfstate', 'CANARY-TFSTATE-c40a'],
    ['id_ed25519', 'CANARY-KEY-e18d'], ['.npmrc', 'CANARY-NPMRC-2b77'], ['credentials.json', 'CANARY-CREDS-a6f1'], ['credentials.md', 'CANARY-SECRETMD-3e90'], ['.env.md', 'CANARY-SECRETMD-3e90']];
  for (const dir of ['', 'Projects', `Projects/${A}`, `Projects/${A}/Tickets`, `Projects/${A}/Tickets/Archive`, `Projects/${A}/Plans`, `Projects/${A}/Runbooks`]) {
    for (const [name, canary] of decoys) write(join(dir, name), `${canary}\n`);
  }
  write(`Projects/${A}/Tickets/ssm-ticket.md`, noteText({ id: 'avonlea-api-997', title: 'named like a secret' }));
  return { root, outside, canaries: CANARIES, write };
}

/** A fingerprint of every file, directory and symlink under `root`: equal before and after means nothing was written. */
export function snapshot(root: string): string {
  const lines: string[] = [];
  const walk = (dir: string, rel: string): void => {
    for (const name of readdirSync(dir).sort()) {
      const p = join(dir, name);
      const r = rel ? `${rel}/${name}` : name;
      const st = lstatSync(p);
      if (st.isSymbolicLink()) lines.push(`L ${r} -> ${readlinkSync(p)}`);
      else if (st.isDirectory()) { lines.push(`D ${r} ${st.mode}`); walk(p, r); }
      else if ((st.mode & 0o444) === 0) lines.push(`F ${r} ${st.mode} unreadable ${st.size} ${st.mtimeMs}`);
      else lines.push(`F ${r} ${st.mode} ${createHash('sha256').update(readFileSync(p)).digest('hex')} ${st.mtimeMs}`);
    }
  };
  walk(root, '');
  return lines.join('\n');
}

/** Throws when any canary appears in `text`. */
export function assertNoCanary(text: string, canaries: string[] = CANARIES): void {
  for (const c of canaries) if (text.includes(c)) throw new Error(`canary ${c} leaked`);
}
