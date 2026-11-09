import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {execFileSync, spawn, spawnSync} from 'node:child_process';
import {setTimeout as sleep} from 'node:timers/promises';
import {EventStore} from '../scripts/lib/events.mjs';
import {observePR} from '../scripts/lib/pr-watch.mjs';
import {recoverJobs, runJob, snapshot} from '../scripts/lib/job.mjs';
import {alive, processIdentity} from '../scripts/lib/process.mjs';
import {fixture, project} from './helpers.mjs';

function setup(t) {
  const f = fixture(t);
  const root = path.join(f.temp, 'events');
  fs.mkdirSync(root, {mode: 0o700});
  const store = new EventStore(root);
  t.after(() => store.close());
  const identity = processIdentity(process.pid);
  store.attach('session-a', identity);
  return {store, identity, root, ...f};
}

function reminder(id = 'one', extra = {}) {
  return {id, type: 'reminder', due: '2030-01-01T10:00:00Z', timezone: 'UTC',
    expires: '2030-01-01T12:00:00Z', ...extra};
}
const now = Date.parse('2030-01-01T10:01:00Z');

test('reminders validate, deduplicate, survive reopening and require owner-scoped explicit ack', t => {
  const {store, identity, root} = setup(t);
  assert.throws(() => store.register(reminder('../bad'), identity.key, now));
  assert.throws(() => store.register(reminder('bad-zone', {timezone: 'not/a-zone'}), identity.key, now));
  assert.throws(() => store.register(reminder('no-offset', {due: '2030-01-01T10:00:00'}), identity.key, now));
  assert.throws(() => store.register(reminder('expired', {expires: '2020-01-01T12:00:00Z'}), identity.key, now));
  store.register(reminder(), identity.key, now);
  assert.throws(() => store.register(reminder(), identity.key, now));
  store.tick(() => { throw Error('must not fetch'); }, alive, now);
  store.tick(() => { throw Error('must not fetch'); }, alive, now);
  assert.equal(store.all('event').length, 1);
  const event = store.all('event')[0];
  assert.throws(() => store.ack(event.id, identity.key), /delivered/);
  assert.equal(store.deliver('another-owner', now), null);
  assert.equal(store.deliver(identity.key, now).attempts, 1);
  assert.throws(() => store.ack(event.id, 'another-owner'), /this process/);
  const reopened = new EventStore(root);
  try {
    assert.equal(reopened.get('event', event.id).status, 'inflight');
    assert.equal(reopened.ack(event.id, identity.key).status, 'acked');
    assert.equal(reopened.ack(event.id, identity.key).status, 'acked');
    assert.equal(reopened.deliver(identity.key, now + 100000), null);
  } finally { reopened.close(); }
});

test('persisted fractional backoff caps delivery at three, independent of turn completion', t => {
  const {store, identity, root} = setup(t);
  store.emit({id: 'manual', owner: identity.key}, 'stable', 'reminder', {}, 10.25);
  store.emit({id: 'manual', owner: identity.key}, 'stable', 'reminder', {}, 11.25);
  const first = store.deliver(identity.key, 10.25, 0.5);
  assert.equal(first.next, 10.75);
  assert.equal(store.deliver(identity.key, 10.74, 0.5), null);
  assert.equal(store.deliver(identity.key, 10.75, 0.5).attempts, 2);
  const reopened = new EventStore(root);
  try {
    assert.equal(reopened.deliver(identity.key, 11.75, 0.5).attempts, 3);
    assert.equal(reopened.deliver(identity.key, 13.75, 0.5), null);
    assert.equal(reopened.get('event', first.id).status, 'dead');
  } finally { reopened.close(); }
});

test('clear keeps process-owned inbox; resume migrates inactive ownership without old inbox records', t => {
  const {store, identity} = setup(t);
  store.register(reminder(), identity.key, now);
  store.tick(() => null, alive, now);
  const event = store.all('event')[0];
  store.detach('session-a');
  store.attach('session-clear', identity);
  assert.equal(store.all('session').length, 1);
  assert.equal(store.owner('session-clear'), identity.key);
  store.ack(store.deliver(identity.key, now).id, identity.key);
  store.detach('session-clear');
  const resumed = {...identity, key: 'other-process', pid: 123456};
  store.attach('session-clear', resumed);
  assert.equal(store.all('session').length, 1);
  assert.equal(store.get('event', event.id).owner, resumed.key);
  assert.equal(store.get('watch', 'one').owner, resumed.key);
  assert.equal(store.get('event', event.id).status, 'acked');
});

test('two sessions isolate cancellation and delivery; dead processes pause watches and release claims', t => {
  const {store, identity} = setup(t);
  const second = {...identity, key: 'second-window'};
  store.attach('session-b', second);
  assert.throws(() => store.attach('session-a', second), /another process/);
  store.register(reminder(), identity.key, now);
  assert.throws(() => store.cancel('one', second.key), /this process/);
  const claim = store.claim('runner', identity, () => true);
  assert.ok(claim);
  assert.equal(store.claim('runner', second, () => true), null);
  const replacement = store.claim('runner', second, () => false);
  store.release(claim);
  assert.equal(store.get('claim', 'runner').token, replacement.token);
  store.release(replacement);
  store.prune(value => value.key !== identity.key);
  store.tick(() => null, () => true, now);
  assert.equal(store.all('event').length, 0);
  store.attach('session-a', identity);
  store.tick(() => null, () => true, now);
  assert.equal(store.all('event').length, 1);
  store.cancel('one', identity.key);
  assert.equal(store.deliver(identity.key, now), null);
});

test('expiry suppresses overdue delivery and process identity checks start time, not just PID', t => {
  const {store, identity} = setup(t);
  store.register(reminder(), identity.key, now);
  store.tick(() => null, alive, now);
  assert.equal(store.deliver(identity.key, now + 3 * 3600000), null);
  assert.equal(store.all('event')[0].status, 'expired');
  assert.equal(alive(identity), true);
  assert.equal(alive({...identity, key: 'reused-pid'}), false);
});

function github() {
  const calls = [];
  const thread = {id: 'thread-1', isResolved: false, comments: {
    nodes: [{id: 'c1', updatedAt: 'time-1', url: 'https://example.test/first'}],
    pageInfo: {hasNextPage: true, endCursor: 'reply-next'},
  }};
  const run = args => {
    calls.push(args);
    if (args.includes('id=thread-1')) return {data: {node: {comments: {
      nodes: [{id: 'c2', updatedAt: 'time-2', url: 'https://example.test/reply'}],
      pageInfo: {hasNextPage: false, endCursor: null},
    }}}};
    if (args.includes('graphql')) return {data: {repository: {pullRequest: {
      state: 'OPEN', url: 'https://example.test/pr', mergeable: 'CONFLICTING', headRefOid: 'abc',
      reviewThreads: {nodes: args.includes('cursor=next') ? [] : [thread],
        pageInfo: {hasNextPage: !args.includes('cursor=next'), endCursor: 'next'}},
    }}}};
    const url = args.at(-1);
    if (url.includes('/check-runs')) return [{check_runs: [{id: 4, conclusion: 'failure', html_url: 'https://example.test/check'}]}];
    if (url.includes('/statuses')) return [[{id: 6, context: 'legacy', state: 'success'}],
      [{id: 5, context: 'legacy', state: 'failure'}]];
    return [[{id: 1, body: 'synthetic', state: 'COMMENTED', html_url: 'https://example.test/comment', updated_at: 'time'}], []];
  };
  return {run, calls, thread};
}

test('PR observation paginates threads, replies, conversations, reviews, checks and legacy statuses', () => {
  const f = github();
  const result = observePR({repo: 'example/sample', number: 1}, f.run);
  assert.equal(result.items.filter(i => i.type === 'pr-feedback').length, 3);
  assert.ok(result.items.some(i => i.url.endsWith('/reply')));
  assert.ok(result.items.some(i => i.type === 'pr-conflict'));
  assert.equal(result.items.filter(i => i.type === 'pr-check-failed').length, 1);
  assert.ok(f.calls.some(args => args.includes('cursor=next')));
  assert.ok(f.calls.some(args => args.includes('cursor=reply-next')));
  assert.equal(f.calls.filter(args => args.includes('--paginate')).length, 4);
  f.thread.comments.nodes[0].updatedAt = 'edited';
  const edited = observePR({repo: 'example/sample', number: 1}, f.run);
  assert.notEqual(result.items.find(i => i.key.startsWith('thread:')).key,
    edited.items.find(i => i.key.startsWith('thread:')).key);
  assert.throws(() => observePR({repo: 'example/sample', number: 1}, () => ({errors: ['synthetic']})), /GraphQL/);
});

test('PR watches deduplicate unchanged state, report recovery/reoccurrence and unknown failures explicitly', t => {
  const {store, identity} = setup(t);
  const watch = {id: 'pr', type: 'pr', repo: 'example/sample', number: 1, expires: '2030-01-02T00:00:00Z'};
  store.register(watch, identity.key, now);
  const result = {closed: false, items: [{key: 'conflict', type: 'pr-conflict', url: 'https://example.test/pr'}]};
  store.tick(() => result, alive, now);
  store.tick(() => result, alive, now + 60000);
  assert.equal(store.all('event').length, 1);
  store.tick(() => ({closed: false, items: []}), alive, now + 120000);
  store.tick(() => result, alive, now + 180000);
  assert.equal(store.all('event').length, 2);
  const original = console.error;
  const errors = [];
  console.error = message => errors.push(message);
  try {
    store.tick(() => { throw Error('synthetic unavailable'); }, alive, now + 240000);
    store.tick(() => { throw Error('synthetic unavailable'); }, alive, now + 300000);
  } finally { console.error = original; }
  assert.equal(errors.length, 2);
  assert.equal(store.all('event').filter(e => e.type === 'watch-error').length, 1);
  assert.equal(store.get('watch', 'pr').failures, 2);
  store.tick(() => ({closed: true, items: []}), alive, now + 600000);
  assert.equal(store.get('watch', 'pr').status, 'completed');
});

test('command wrapper records passing/failing results and recovers persisted or lost runs', async t => {
  const {store, identity, temp} = setup(t);
  const cwd = path.join(temp, 'checkout');
  fs.mkdirSync(cwd);
  const git = args => execFileSync('git', ['-C', cwd, '-c', 'core.hooksPath=/dev/null',
    '-c', 'commit.gpgsign=false', ...args], {stdio: 'pipe'});
  git(['init', '-q']);
  fs.writeFileSync(path.join(cwd, 'file.txt'), 'synthetic\n');
  git(['add', 'file.txt']);
  git(['-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-qm', 'test: create fixture']);
  const options = {id: 'pass', argv: [process.execPath, '-e', 'console.log("synthetic")'],
    cwd, configuration: 'synthetic-config-v1', survive_session: false};
  const passed = await runJob(store, options, identity.key);
  assert.equal(passed.status, 'passed');
  assert.equal(passed.unchanged, true);
  assert.deepEqual(passed.argv, options.argv);
  assert.match(fs.readFileSync(path.join(store.root, passed.output), 'utf8'), /synthetic/);
  const before = snapshot(cwd);
  fs.writeFileSync(path.join(cwd, 'file.txt'), 'synthetic change\n');
  assert.notEqual(snapshot(cwd).diff, before.diff);
  const failed = await runJob(store, {...options, id: 'fail', argv: [process.execPath, '-e', 'process.exit(3)']}, identity.key);
  assert.equal(failed.status, 'failed');
  assert.equal(failed.code, 3);
  assert.equal(failed.unchanged, true);
  const stale = await runJob(store, {...options, id: 'stale',
    argv: [process.execPath, '-e', 'require("node:fs").writeFileSync("file.txt","new synthetic revision")']}, identity.key);
  assert.equal(stale.status, 'passed');
  assert.equal(stale.unchanged, false);
  const cancelledPromise = runJob(store, {...options, id: 'cancel-on-exit',
    argv: [process.execPath, '-e', 'setTimeout(()=>{},10000)']}, identity.key);
  store.detach('session-a');
  assert.equal((await cancelledPromise).status, 'cancelled');
  store.attach('session-a', identity);
  const survivingPromise = runJob(store, {...options, id: 'survive',
    survive_session: true, argv: [process.execPath, '-e', 'setTimeout(()=>{},50)']}, identity.key);
  store.detach('session-a');
  const resumed = {...identity, key: 'resumed-window'};
  store.attach('session-a', resumed);
  const survived = await survivingPromise;
  assert.equal(survived.status, 'passed');
  assert.equal(survived.owner, resumed.key);
  assert.equal(store.all('event').find(e => e.detail.run === 'survive').owner, resumed.key);
  store.put('job', {...passed, status: 'running'});
  recoverJobs(store, () => false);
  assert.equal(store.get('job', 'pass').status, 'passed');
  store.put('job', {...passed, id: 'lost', status: 'running'});
  recoverJobs(store, () => false);
  assert.equal(store.get('job', 'lost').status, 'lost');
  assert.equal(store.all('event').length, 6);
});

test('PR observation cannot resurrect cancelled watches or route resumed events back to an old process', t => {
  const {store, identity} = setup(t);
  const watch = {id: 'pr', type: 'pr', repo: 'example/sample', number: 1, expires: '2030-01-02T00:00:00Z'};
  store.register(watch, identity.key, now);
  store.tick(() => {
    store.detach('session-a');
    store.attach('session-a', {...identity, key: 'new-owner'});
    return {closed: false, items: [{key: 'conflict', type: 'pr-conflict', url: 'https://example.test/pr'}]};
  }, () => true, now);
  assert.equal(store.all('event')[0].owner, 'new-owner');
  assert.equal(store.get('watch', 'pr').owner, 'new-owner');
  store.tick(() => {
    store.cancel('pr', 'new-owner');
    return {closed: false, items: []};
  }, () => true, now + 60000);
  assert.equal(store.get('watch', 'pr').status, 'cancelled');
});

test('event CLI rejects unknown fields/options and never starts a service outside a Claude ancestor', t => {
  const {root} = setup(t);
  const run = (command, args = [], input) => spawnSync(process.execPath, [
    path.join(project, 'scripts/events.mjs'), command, '--root', root, ...args,
  ], {encoding: 'utf8', input: JSON.stringify(input)});
  assert.equal(run('list').status, 0);
  assert.notEqual(run('list', ['--mystery', '1']).status, 0);
  const hook = run('hook', [], {session_id: 'synthetic'});
  assert.notEqual(hook.status, 0);
  assert.match(hook.stderr, /No verified Claude ancestor/);
  assert.ok(!fs.existsSync(path.join(root, 'runner.log')));
});

async function until(check) {
  for (let i = 0; i < 100; i++) {
    const result = check();
    if (result) return result;
    await sleep(50);
  }
  throw Error('Timed out waiting for synthetic subprocess');
}

test('real runner processes elect one owner, recover due events, and stop after the final session ends', async t => {
  const {store, root, identity} = setup(t);
  const due = new Date(Date.now() - 1000).toISOString();
  store.register(reminder('live-due', {due, expires: new Date(Date.now() + 60000).toISOString()}), identity.key);
  const children = Array.from({length: 2}, () => spawn(process.execPath, [
    path.join(project, 'scripts/events.mjs'), 'runner', '--root', root,
  ], {stdio: ['ignore', 'ignore', 'pipe']}));
  const exited = children.map(child => new Promise(resolve => child.once('exit', code => resolve(code))));
  t.after(() => children.forEach(child => { if (child.exitCode === null) child.kill(); }));
  const claim = await until(() => store.get('claim', 'runner'));
  assert.ok(children.some(child => child.pid === claim.identity.pid));
  await until(() => store.all('event').length === 1);
  await until(() => children.some(child => child.exitCode === 0));
  assert.equal(children.filter(child => child.exitCode === null).length, 1);
  store.detach('session-a');
  assert.deepEqual(await Promise.all(exited), [0, 0]);
  assert.equal(store.get('claim', 'runner'), null);
});

test('production listener emits neutral exit-2 notification and explicit same-process ack under a synthetic Claude executable', async t => {
  const {store, root, temp, identity} = setup(t);
  // A renamed Node executable provides an actual ancestor named claude, without an API/model.
  const executable = path.join(temp, 'claude');
  fs.copyFileSync(process.execPath, executable, fs.constants.COPYFILE_FICLONE);
  fs.chmodSync(executable, 0o700);
  const claim = store.claim('runner', identity, () => false);
  const cli = path.join(project, 'scripts/events.mjs');
  const checkout = path.join(temp, 'commands');
  fs.mkdirSync(checkout);
  execFileSync('git', ['-C', checkout, 'init', '-q']);
  execFileSync('git', ['-C', checkout, '-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false',
    '-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '--allow-empty', '-qm', 'test: create fixture']);
  const code = `
    const {spawn,spawnSync} = require('node:child_process');
    const cli = ${JSON.stringify(cli)}, root = ${JSON.stringify(root)};
    const hook = spawn(process.execPath,[cli,'hook','--root',root,'--seconds','4'],{stdio:['pipe','ignore','pipe']});
    hook.stdin.end(JSON.stringify({session_id:'synthetic-claude',hook_event_name:'SessionStart'}));
    let message=''; hook.stderr.on('data',d=>message+=d);
    hook.on('exit',async status=>{
      const {EventStore}=await import(${JSON.stringify(new URL('../scripts/lib/events.mjs', import.meta.url).href)});
      const db=new EventStore(root), event=db.all('event').find(e=>e.type==='reminder'); db.close();
      const ack=spawnSync(process.execPath,[cli,'ack','--root',root,'--id',event?.id??'missing'],{encoding:'utf8'});
      const run=spawnSync(process.execPath,[cli,'run','--root',root,'--session','synthetic-claude'],{encoding:'utf8',
        input:JSON.stringify({id:'failed-cli',argv:[process.execPath,'-e','process.exit(3)'],
          cwd:${JSON.stringify(checkout)},configuration:'synthetic',survive_session:false})});
      const end=spawnSync(process.execPath,[cli,'end','--root',root],{encoding:'utf8',input:JSON.stringify({session_id:'synthetic-claude'})});
      console.log(JSON.stringify({status,message,ack:ack.status,end:end.status,run:run.status,result:JSON.parse(run.stdout)}));
    });`;
  const parent = spawn(executable, ['-e', code], {stdio: ['ignore', 'pipe', 'pipe']});
  let output = '';
  let errors = '';
  parent.stdout.on('data', data => { output += data; });
  parent.stderr.on('data', data => { errors += data; });
  const exited = new Promise(resolve => parent.once('exit', code => resolve(code)));
  t.after(() => { if (parent.exitCode === null) parent.kill(); });
  const owner = await until(() => store.all('session').find(s => s.session === 'synthetic-claude'));
  store.emit({id: 'synthetic', owner: owner.id}, 'due', 'reminder', 'UNTRUSTED_CONTENT_DO_NOT_ECHO');
  assert.equal(await exited, 0, errors);
  const result = JSON.parse(output);
  assert.equal(result.status, 2, result.message);
  assert.equal(result.ack, 0);
  assert.equal(result.end, 0);
  assert.equal(result.run, 3);
  assert.equal(result.result.status, 'failed');
  assert.ok(!result.message.includes('UNTRUSTED_CONTENT'));
  assert.equal(store.all('event').find(e => e.type === 'reminder').status, 'acked');
  store.release(claim);
});
