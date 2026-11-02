/** self-heal: the supervisor and Podium repairs, run against a fake launchctl; nothing here touches launchd or starts a server. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { healPodium, healSupervisor, loopbackPort } from './self-heal.ts';
import type { Launchctl } from './launchd.ts';

/** A fake launchctl: `loaded` is what `print` answers, `fail` makes the named verb fail. Records every call. */
function fake(loaded: boolean, fail: string[] = []) {
  const calls: string[] = [];
  const launchctl: Launchctl = (args) => {
    calls.push(args.join(' '));
    if (args[0] === 'print') return { ok: loaded, output: '' };
    return fail.includes(args[0]!) ? { ok: false, output: `${args[0]} refused` } : { ok: true, output: '' };
  };
  return { launchctl, calls };
}
const here = () => true;
const nowhere = () => false;
const sup = { uid: 501, label: 'L', plist: '/p/L.plist' };

test('an installed supervisor that is not loaded is bootstrapped', () => {
  const f = fake(false);
  const r = healSupervisor({ ...sup, launchctl: f.launchctl, plistExists: here });
  assert.equal(r.action, 'started');
  assert.deepEqual(f.calls, ['print gui/501/L', 'bootstrap gui/501 /p/L.plist']);
});

test('a loaded supervisor is kickstarted without -k, so a running one is left alone', () => {
  const f = fake(true);
  assert.equal(healSupervisor({ ...sup, launchctl: f.launchctl, plistExists: here }).action, 'started');
  assert.deepEqual(f.calls, ['print gui/501/L', 'kickstart gui/501/L']);
});

test('no installed plist means nothing is run and nothing is installed', () => {
  const f = fake(false);
  const r = healSupervisor({ ...sup, launchctl: f.launchctl, plistExists: nowhere });
  assert.equal(r.action, 'not-installed');
  assert.deepEqual(f.calls, []);
});

test('a launchctl failure is reported with its output', () => {
  const r = healSupervisor({ ...sup, launchctl: fake(false, ['bootstrap']).launchctl, plistExists: here });
  assert.equal(r.action, 'failed');
  assert.match(r.message, /bootstrap failed: bootstrap refused/);
});

test('loopbackPort accepts only an http loopback link with a port', () => {
  assert.equal(loopbackPort('http://127.0.0.1:47700/'), 47700);
  assert.equal(loopbackPort('http://localhost:8080'), 8080);
  for (const bad of ['https://127.0.0.1:47700/', 'http://example.com:47700/', 'http://127.0.0.1/', 'http://127.0.0.1:0/', 'http://127.0.0.1:99999/', '']) assert.equal(loopbackPort(bad), null, bad);
});

/** A Podium env whose probe answers true after `answerAfter` probes; `spawned` records detached starts. */
function podium(over: { answerAfter?: number; plistExists?: () => boolean; launchctl?: Launchctl; url?: string; spawnWeb?: (port: number) => void } = {}) {
  const spawned: number[] = [];
  const slept: number[] = [];
  let probes = 0;
  const f = fake(false);
  const env = {
    launchctl: over.launchctl ?? f.launchctl, uid: 501, label: 'W', plist: '/p/W.plist', url: over.url ?? 'http://127.0.0.1:47700/',
    spawnWeb: over.spawnWeb ?? ((port: number) => { spawned.push(port); }),
    probe: () => probes++ >= (over.answerAfter ?? 0),
    sleep: (ms: number) => { slept.push(ms); },
    plistExists: over.plistExists ?? nowhere, waitMs: 2000,
  };
  return { env, spawned, slept, calls: f.calls };
}

test('with no Podium plist it starts a detached server on the configured port and reports up only once it answers', () => {
  const p = podium({ answerAfter: 2 });
  const r = healPodium(p.env);
  assert.deepEqual(p.spawned, [47700]);
  assert.equal(r.action, 'started');
  assert.match(r.message, /detached server on port 47700, answering at http:\/\/127\.0\.0\.1:47700\//);
  assert.equal(p.slept.length, 2, 'it waited between probes');
  assert.deepEqual(p.calls, [], 'no launchctl call without a plist');
});

test('a server that never answers is reported failed, not up', () => {
  const r = healPodium(podium({ answerAfter: 999 }).env);
  assert.equal(r.action, 'failed');
  assert.match(r.message, /nothing answered/);
});

test('with the Podium plist installed it goes through launchd: bootstrap when not loaded, kickstart -k when loaded, no detached spawn', () => {
  const idle = podium({ plistExists: here });
  assert.equal(healPodium(idle.env).action, 'started');
  assert.deepEqual(idle.calls, ['print gui/501/W', 'bootstrap gui/501 /p/W.plist']);
  const loaded = fake(true);
  const p = podium({ plistExists: here, launchctl: loaded.launchctl });
  assert.equal(healPodium(p.env).action, 'started');
  assert.deepEqual(loaded.calls, ['print gui/501/W', 'kickstart -k gui/501/W']);
  assert.deepEqual([...idle.spawned, ...p.spawned], []);
});

test('a link that is not a loopback http URL is never started', () => {
  const p = podium({ url: 'https://podium.example.com/' });
  assert.equal(healPodium(p.env).action, 'skipped');
  assert.deepEqual(p.spawned, []);
});

test('a spawn that throws is reported failed', () => {
  const r = healPodium(podium({ spawnWeb: () => { throw new Error('no ledger root'); } }).env);
  assert.equal(r.action, 'failed');
  assert.match(r.message, /no ledger root/);
});
