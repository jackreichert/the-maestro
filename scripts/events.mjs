import fs from 'node:fs';
import {fileURLToPath} from 'node:url';
import {spawn} from 'node:child_process';
import {setTimeout as sleep} from 'node:timers/promises';
import {EventStore, identifier} from './lib/events.mjs';
import {alive, claudeProcess, processIdentity} from './lib/process.mjs';
import {observePR} from './lib/pr-watch.mjs';
import {recoverJobs, runJob} from './lib/job.mjs';
import {requireValue, scopedPath} from './storage.mjs';

const script = fileURLToPath(import.meta.url);

function input() {
  const text = fs.readFileSync(0, 'utf8');
  requireValue(text.length < 65536, 'Input too large');
  return JSON.parse(text);
}

function ensureRunner(store) {
  const claim = store.get('claim', 'runner');
  if (claim && alive(claim.identity)) return;
  const fd = fs.openSync(scopedPath(store.root, 'runner.log'), 'a', 0o600);
  try {
    const child = spawn(process.execPath, [script, 'runner', '--root', store.root], {
      detached: true, stdio: ['ignore', fd, fd],
    });
    child.on('error', error => console.error(`Event runner spawn failed: ${error.message}`));
    child.unref();
  } finally { fs.closeSync(fd); }
}

async function runner(store) {
  const claim = store.claim('runner', processIdentity(process.pid), alive);
  if (!claim) return;
  try {
    while (true) {
      recoverJobs(store);
      if (!store.tick(observePR, alive).length) return;
      await sleep(1000);
    }
  } finally { store.release(claim); }
}

async function listener(store, session, seconds, source) {
  const identity = claudeProcess();
  store.prune(alive);
  const current = store.get('session', identity.key);
  if (current && current.session !== session && current.active) {
    // Only SessionStart may replace an existing session after /clear.
    requireValue(source === 'SessionStart', 'Stale session hook');
  }
  store.attach(session, identity);
  ensureRunner(store);
  let claim;
  for (let attempt = 0; attempt < 5 && !claim; attempt++) {
    claim = store.claim(`listener-${identity.key}`, processIdentity(process.pid), alive);
    if (!claim) await sleep(500);
  }
  if (!claim) return;
  try {
    const until = Date.now() + seconds * 1000;
    let runnerCheck = Date.now() + 2000;
    while (Date.now() < until && alive(identity)) {
      const current = store.get('session', identity.key);
      if (!current?.active || current.session !== session) return;
      if (Date.now() >= runnerCheck) { ensureRunner(store); runnerCheck = Date.now() + 2000; }
      const event = store.deliver(identity.key);
      if (event) {
        console.error(`Maestro event ${event.type}; ID ${event.id}; local details: ${store.root}/events.sqlite`);
        process.exitCode = 2;
        return;
      }
      await sleep(500);
    }
    console.error('Maestro listener ended; monitoring will re-arm at the next configured hook.');
  } finally { store.release(claim); }
}

export async function main(argv) {
  const [command, ...args] = argv;
  const options = {};
  for (let i = 0; i < args.length; i += 2) {
    requireValue(['--root', '--session', '--id', '--seconds'].includes(args[i])
      && args[i + 1] && !Object.hasOwn(options, args[i]), 'Expected unique named options');
    options[args[i]] = args[i + 1];
  }
  requireValue(options['--root'], '--root must name an existing private local directory');
  const allowed = {
    register: ['--session'], run: ['--session'], cancel: ['--id'], ack: ['--id'],
    detail: ['--id'], list: [], tick: [], runner: [], hook: ['--seconds'], end: [],
  };
  requireValue(Object.hasOwn(allowed, command)
    && Object.keys(options).every(k => k === '--root' || allowed[command].includes(k)), 'Unknown command/option');
  const store = new EventStore(options['--root']);
  let result;
  try {
    switch (command) {
      case 'hook': {
        const event = input();
        const seconds = Number(options['--seconds'] ?? 3500);
        requireValue(identifier(event.session_id) && seconds >= 1 && seconds <= 86400, 'Invalid hook session/timeout');
        await listener(store, event.session_id, seconds, event.hook_event_name);
        break;
      }
      case 'end': {
        const event = input();
        const identity = claudeProcess();
        if (store.get('session', identity.key)?.session === event.session_id) store.detach(event.session_id, identity.key);
        break;
      }
      case 'runner': await runner(store); break;
      case 'tick': recoverJobs(store); result = store.tick(observePR, alive); break;
      case 'register':
      case 'run': {
        const owner = store.owner(options['--session']);
        requireValue(claudeProcess().key === owner, 'Session belongs to another Claude process');
        result = command === 'run' ? await runJob(store, input(), owner) : store.register(input(), owner);
        if (command === 'run' && (result.status !== 'passed' || !result.unchanged)) {
          process.exitCode = Number.isInteger(result.code) && result.code > 0 && result.code <= 255 ? result.code : 1;
        }
        break;
      }
      case 'cancel':
        store.cancel(options['--id'], claudeProcess().key);
        result = {cancelled: options['--id']};
        break;
      case 'ack': result = store.ack(options['--id'], claudeProcess().key); break;
      case 'detail':
        result = store.get('event', options['--id']);
        requireValue(result, 'Unknown event');
        break;
      case 'list':
        result = Object.fromEntries(['session', 'watch', 'event', 'job'].map(kind => [kind, store.all(kind)]));
        break;
    }
    if (result !== undefined) console.log(JSON.stringify(result, null, 2));
  } finally { store.close(); }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main(process.argv.slice(2)).catch(error => {
    console.error(`Maestro events: ${error.message}`);
    process.exitCode = 1;
  });
}
