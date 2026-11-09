import fs from 'node:fs';
import {spawn, execFileSync} from 'node:child_process';
import {setTimeout as sleep} from 'node:timers/promises';
import {hash, keys, prohibited, requireValue, rootDirectory, scopedPath, writeJson} from '../storage.mjs';
import {identifier} from './events.mjs';
import {alive, processIdentity} from './process.mjs';

export function snapshot(cwd) {
  const git = args => execFileSync('git', ['-C', cwd, ...args], {encoding: 'utf8', timeout: 10000, maxBuffer: 4 * 1024 * 1024});
  const head = git(['rev-parse', 'HEAD']).trim();
  requireValue(fs.realpathSync(git(['rev-parse', '--show-toplevel']).trim()) === cwd, 'Run from the checkout root');
  requireValue(!git(['ls-files', '--stage']).split('\n').some(line => line.startsWith('160000 ')),
    'Command snapshots do not support submodules; use a standalone checkout');
  const dirty = git(['status', '--porcelain=v1', '-uno']);
  const changed = git(['diff', '--name-only', '-z', 'HEAD', '--']);
  requireValue(changed.split('\0').every(file => !file.split('/').some(prohibited)),
    'Tracked secret-file changes cannot be snapshotted; isolate this run');
  const untracked = git(['ls-files', '--others', '--exclude-standard', '-z']);
  requireValue(!untracked, 'Command runs require an isolated checkout without untracked files');
  const diff = git(['diff', '--no-ext-diff', '--no-textconv', '--binary', 'HEAD', '--',
    '.', ':(exclude)**/.env*', ':(exclude)**/ssm-*.json']);
  return {head, status: hash(dirty), diff: hash(diff)};
}

export async function runJob(store, input, owner) {
  keys(input, ['id', 'argv', 'cwd', 'configuration', 'survive_session'],
    ['id', 'argv', 'cwd', 'configuration', 'survive_session']);
  requireValue(identifier(input.id) && Array.isArray(input.argv) && input.argv.length > 0
    && input.argv.length <= 100 && input.argv.every(s => typeof s === 'string' && s.length <= 4096 && !s.includes('\0'))
    && input.argv[0] && typeof input.configuration === 'string' && input.configuration.length <= 2000
    && typeof input.survive_session === 'boolean', 'Invalid command run');
  requireValue(store.get('session', owner)?.active, 'Command requires an active session');
  const cwd = rootDirectory(input.cwd);
  const tested = snapshot(cwd);
  const id = input.id;
  const identity = processIdentity(process.pid);
  store.transaction(() => {
    requireValue(!store.get('job', id), 'Run ID already exists');
    store.put('job', {id, owner, tested, argv: input.argv, configuration: input.configuration, cwd,
      survive_session: input.survive_session, identity, status: 'running'});
  });
  const output = `${id}.output.log`;
  const fd = fs.openSync(scopedPath(store.root, output), 'wx', 0o600);
  let child;
  let timer;
  let killTimer;
  let ended = false;
  const stop = () => {
    if (!child?.pid || ended) return;
    ended = true;
    try { process.kill(-child.pid, 'SIGTERM'); }
    catch (error) { if (error.code !== 'ESRCH') throw error; }
    killTimer = setTimeout(() => {
      try { process.kill(-child.pid, 'SIGKILL'); }
      catch (error) { if (error.code !== 'ESRCH') throw error; }
    }, 3000);
  };
  try {
    child = spawn(input.argv[0], input.argv.slice(1), {cwd, stdio: ['ignore', fd, fd], shell: false, detached: true});
    if (child.pid) store.put('job', {...store.get('job', id), child: processIdentity(child.pid)});
    process.once('SIGTERM', stop);
    timer = setInterval(() => {
      if (input.survive_session || ended) return;
      const session = store.get('session', owner);
      if (!session?.active || !alive(session.identity)) stop();
    }, 500);
    const result = await new Promise(resolve => {
      child.once('error', error => resolve({status: 'failed', error: error.code}));
      child.once('exit', (code, signal) => resolve({status: ended ? 'cancelled' : code === 0 ? 'passed' : 'failed', code, signal}));
    });
    if (ended) await sleep(3100);
    const job = store.get('job', id);
    let unchanged = false;
    try { unchanged = JSON.stringify(snapshot(cwd)) === JSON.stringify(tested); }
    catch (error) { console.error(`Run ${id} snapshot no longer verifiable: ${error.message}`); }
    const completed = {...job, ...result, unchanged, finished: Date.now(), output};
    writeJson(store.root, `${id}.result.json`, completed);
    store.transaction(() => {
      store.put('job', completed);
      store.emit({id: `job-${id}`, owner: job.owner}, 'complete', 'command-complete',
        {run: id, status: completed.status, unchanged, result: `${id}.result.json`});
    });
    return completed;
  } finally {
    clearInterval(timer);
    clearTimeout(killTimer);
    process.removeListener('SIGTERM', stop);
    fs.closeSync(fd);
  }
}

export function recoverJobs(store, isAlive = alive) {
  for (const job of store.all('job')) {
    if (job.status !== 'running' || isAlive(job.identity)) continue;
    if (job.child && isAlive(job.child) && !job.survive_session) {
      try { process.kill(-job.child.pid, 'SIGKILL'); }
      catch (error) { if (error.code !== 'ESRCH') throw error; }
    }
    const resultPath = scopedPath(store.root, `${job.id}.result.json`);
    const result = fs.existsSync(resultPath) ? JSON.parse(fs.readFileSync(resultPath, 'utf8'))
      : {...job, status: 'lost', commandMaySurvive: job.survive_session};
    requireValue(result.id === job.id && result.owner === job.owner
      && ['passed', 'failed', 'cancelled', 'lost'].includes(result.status), 'Invalid command result');
    store.transaction(() => {
      store.put('job', result);
      store.emit({id: `job-${job.id}`, owner: job.owner}, 'complete', 'command-complete',
        {run: job.id, status: result.status, result: `${job.id}.result.json`});
    });
  }
}
