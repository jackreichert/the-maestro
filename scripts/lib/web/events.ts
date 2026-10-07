/**
 * Live updates for the Podium page: Server-Sent Events over one shared file watcher.
 *
 * The hub stats the files the board is built from every `intervalMs` (default 2 s); when their combined stamp changes it
 * tells every subscriber the new `seq` (a short hash of the stamp). It runs only while someone is subscribed: the first
 * subscriber starts the timers, the last one leaving stops them, so an idle server does no work and a disconnected client
 * leaves nothing behind. All connections share the one loop. The files are only stat-ed, never read.
 */
import { createHash } from 'node:crypto';
import { readdirSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { join } from 'node:path';
import { stampAll } from '../stamp.ts';
import { DIRTY_PRS } from '../status-page/dirty.ts';
import { PRS_CACHE } from '../status-page/prcache.ts';
import { PODIUM_FILE } from '../status-page/seen.ts';
import { openStream } from './guard.ts';

export const DEFAULT_INTERVAL_MS = 2000;
export const DEFAULT_KEEPALIVE_MS = 25_000;

export interface Subscriber { changed(seq: string): void; keepAlive(): void }
export interface ChangeHub { subscribe(s: Subscriber): () => void; readonly size: number; readonly running: boolean }
export interface HubOptions { files: () => string[]; intervalMs?: number; keepAliveMs?: number }

/** The files the board depends on: the ledger and its registry, priorities, the PR cache and dirty marker, the page, the stream maps and the tab fragments. */
export function boardFiles(vault: string, project: string, statusDir: string): string[] {
  const root = join(vault, 'Projects', project);
  let fragments: string[] = [];
  try { fragments = readdirSync(join(statusDir, 'fragments')).filter((n) => n.endsWith('.md')).sort().map((n) => join(statusDir, 'fragments', n)); } catch { /* no fragments directory yet */ }
  return [
    join(root, 'Journal', 'ledger.jsonl'), join(root, 'streams.json'),
    ...['priorities.md', PRS_CACHE, DIRTY_PRS, PODIUM_FILE, 'ticket-map.json', 'stream-overrides.json'].map((n) => join(statusDir, n)),
    ...fragments,
  ];
}

const seqOf = (stamp: string): string => createHash('sha1').update(stamp).digest('hex').slice(0, 12);

export function createChangeHub(o: HubOptions): ChangeHub {
  const subs = new Set<Subscriber>();
  let timers: NodeJS.Timeout[] = [];
  let last = '';
  const start = (): void => {
    last = stampAll(o.files());   // the baseline is "now": a client that just connected has already fetched current data
    timers = [
      setInterval(() => {
        const sig = stampAll(o.files());
        if (sig === last) return;
        last = sig;
        const seq = seqOf(sig);
        for (const s of [...subs]) s.changed(seq);
      }, o.intervalMs ?? DEFAULT_INTERVAL_MS),
      setInterval(() => { for (const s of [...subs]) s.keepAlive(); }, o.keepAliveMs ?? DEFAULT_KEEPALIVE_MS),
    ];
    for (const t of timers) t.unref();   // a watcher must never keep the process alive
  };
  const stop = (): void => { for (const t of timers) clearInterval(t); timers = []; };
  return {
    subscribe(s) {
      if (subs.size === 0) start();
      subs.add(s);
      return () => { if (subs.delete(s) && subs.size === 0) stop(); };
    },
    get size() { return subs.size; },
    get running() { return timers.length > 0; },
  };
}

/** Answer one `GET /api/events` request: open the stream and subscribe until the client goes away. The caller has already run the guard. */
export function serveEvents(_req: IncomingMessage, res: ServerResponse, hub: ChangeHub): void {
  openStream(res);
  const live = (): boolean => !res.writableEnded && !res.destroyed;
  const off = hub.subscribe({
    changed: (seq) => { if (live()) res.write(`event: changed\ndata: ${JSON.stringify({ seq })}\n\n`); },
    keepAlive: () => { if (live()) res.write(': keepalive\n\n'); },
  });
  res.on('close', off);
  res.on('error', off);
}
