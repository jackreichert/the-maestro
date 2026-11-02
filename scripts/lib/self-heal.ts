/**
 * self-heal.ts: what session start does when the loop supervisor or the Podium web server is down.
 *
 * Both are idempotent and never install anything: a launchd plist is loaded only when it is already installed, and the Podium is
 * started by hand only when it has no plist. Every launchctl call goes through the injected runner and the detached spawn and the
 * connect probe are injected too, so a test never touches launchd or starts a server.
 */
import { existsSync } from 'node:fs';
import { bootstrap, isLoaded, kickstart } from './launchd.ts';
import type { Launchctl } from './launchd.ts';

/** `started`: the thing was asked to start (and, for the Podium, answers). `not-installed`: nothing to load. `failed`: tried and did not work. `skipped`: not something this will start. */
export interface Heal { action: 'started' | 'not-installed' | 'failed' | 'skipped'; message: string }

export interface SupervisorHealEnv { launchctl: Launchctl; uid: number; label: string; plist: string; plistExists?: (path: string) => boolean }

/** Loads the plist when launchd does not know the job, else kickstarts it (`restart` adds -k). Returns the launchctl result and a failure message. */
function loadOrKick(env: { launchctl: Launchctl; uid: number; label: string; plist: string }, restart: boolean): { loaded: boolean; ok: boolean; failure: string } {
  const loaded = isLoaded(env.launchctl, env.uid, env.label);
  const r = loaded ? kickstart(env.launchctl, env.uid, env.label, restart) : bootstrap(env.launchctl, env.uid, env.plist);
  return { loaded, ok: r.ok, failure: `${loaded ? 'launchctl kickstart' : 'launchctl bootstrap'} failed: ${r.output || 'no output'}` };
}

/** Brings the loop supervisor back: loads its plist when installed but not loaded, otherwise kickstarts it (a no-op when it is running). */
export function healSupervisor(env: SupervisorHealEnv): Heal {
  if (!(env.plistExists ?? existsSync)(env.plist)) return { action: 'not-installed', message: `no plist at ${env.plist}` };
  const r = loadOrKick(env, false);
  return r.ok
    ? { action: 'started', message: r.loaded ? `asked launchd to start ${env.label}` : `loaded ${env.plist} into launchd` }
    : { action: 'failed', message: r.failure };
}

export interface PodiumHealEnv {
  launchctl: Launchctl; uid: number; label: string; plist: string;
  /** The footer link; only a loopback http URL is ever started. */
  url: string;
  /** Starts `web.ts --port <port>` detached, logging to a file. */
  spawnWeb: (port: number) => void;
  /** True when something answers at the URL. */
  probe: (url: string) => boolean;
  sleep: (ms: number) => void;
  plistExists?: (path: string) => boolean;
  /** How long to wait for it to answer (default 10 s). */
  waitMs?: number;
}

/** The port of a loopback http URL, or null for anything else (a remote or non-http link is not ours to start). */
export function loopbackPort(url: string): number | null {
  const m = /^http:\/\/(?:127\.0\.0\.1|localhost):(\d{1,5})(?:\/|$)/.exec(url);
  const port = m ? Number(m[1]) : 0;
  return port >= 1 && port <= 65535 ? port : null;
}

/** Brings the Podium back: through launchd when its plist is installed, else a detached `web.ts --port`. Reports started only once it answers. */
export function healPodium(env: PodiumHealEnv): Heal {
  const port = loopbackPort(env.url);
  if (port === null) return { action: 'skipped', message: `${env.url} is not a loopback http link, so it is not started` };
  const viaLaunchd = (env.plistExists ?? existsSync)(env.plist);
  if (viaLaunchd) {
    const r = loadOrKick(env, true);
    if (!r.ok) return { action: 'failed', message: r.failure };
  } else {
    try { env.spawnWeb(port); } catch (err) { return { action: 'failed', message: `could not start web.ts: ${err instanceof Error ? err.message : String(err)}` }; }
  }
  const via = viaLaunchd ? 'through launchd' : `as a detached server on port ${port}`;
  for (let waited = 0; waited <= (env.waitMs ?? 10_000); waited += 500) {
    if (env.probe(env.url)) return { action: 'started', message: `started ${via}, answering at ${env.url}` };
    env.sleep(500);
  }
  return { action: 'failed', message: `started ${via} but nothing answered at ${env.url} in time` };
}
