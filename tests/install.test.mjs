import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import test from 'node:test';
import {fixture, project} from './helpers.mjs';

test('relocated runtime uses a fresh home config without installed hooks or GitHub access', (t) => {
  const f = fixture(t);
  const bundle = path.join(f.temp, 'relocated bundle');
  const home = path.join(f.temp, 'fresh home');
  const configDirectory = path.join(home, '.config/the-maestro');
  fs.mkdirSync(bundle);
  fs.mkdirSync(home);
  fs.cpSync(path.join(project, 'scripts'), path.join(bundle, 'scripts'), {recursive: true});
  fs.copyFileSync(path.join(project, 'settings.json'), path.join(bundle, 'settings.json'));
  const env = {...process.env, HOME: home, USERPROFILE: home, PATH: ''};
  const run = (script, args, input) => spawnSync(process.execPath, [
    path.join(bundle, 'scripts', script), ...args,
  ], {cwd: home, env, input: JSON.stringify(input), encoding: 'utf8'});

  const unconfigured = run('memory.mjs', ['current', 'fresh-session']);
  assert.equal(unconfigured.status, 1);
  assert.match(unconfigured.stderr, /Memory operation failed/);
  assert.equal(fs.existsSync(configDirectory), false);

  fs.mkdirSync(configDirectory, {recursive: true});
  fs.copyFileSync(f.config, path.join(configDirectory, 'settings.json'));
  const prompt = run('memory.mjs', ['hook'], {
    hook_event_name: 'UserPromptSubmit', session_id: 'fresh-session',
  });
  assert.equal(prompt.status, 0, prompt.stderr);
  const instructions = JSON.parse(prompt.stdout).hookSpecificOutput.additionalContext;
  assert.ok(instructions.includes(path.join(bundle, 'scripts/memory.mjs')));
  assert.ok(instructions.includes(path.join(configDirectory, 'settings.json')));
  const prepared = run('memory.mjs', ['prepare'], {
    session_id: 'fresh-session', topics: [], events: [], pages: [],
  });
  assert.equal(prepared.status, 0, prepared.stderr);
  const flushed = run('memory.mjs', ['flush', 'fresh-session']);
  assert.equal(flushed.status, 0, flushed.stderr);
  const [receipt] = JSON.parse(flushed.stdout).checkpoints;
  assert.equal(receipt.ledger, 'applied');
  assert.equal(receipt.index, 'applied');
  const stopped = run('memory.mjs', ['hook'], {
    hook_event_name: 'Stop', session_id: 'fresh-session',
  });
  assert.equal(stopped.status, 0, stopped.stderr);
  assert.match(stopped.stdout, /saved; 1 current-turn receipts; 0 incomplete/);

  const footer = run('statusline.mjs', [], {session_id: 'fresh-session'});
  assert.equal(footer.status, 0, footer.stderr);
  assert.match(footer.stdout, /Memory saved/);
  assert.match(footer.stdout, /Decisions 0/);
  assert.match(footer.stderr, /Open-PR count unavailable: ENOENT/);
  assert.doesNotMatch(footer.stderr, /settings unavailable/);
});
