/** install-podium-web: the plist fills completely and runs web.ts on the footer's port; the port parser and commands are exact. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { fillTemplate } from './install-loop-supervisor.ts';
import { DEFAULT_PORT, WEB_LABEL, portFromUri, webCommands } from './install-podium-web.ts';

const template = readFileSync(fileURLToPath(new URL(`./launchd/${WEB_LABEL}.plist.template`, import.meta.url)), 'utf8');
const values = { NODE: '/n/node', REPO: '/r', PORT: '47700', LEDGER_ROOT: '/l', PROJECT: 'p', LOG: '/log', PATH: '/bin' };

test('the template fills with no placeholder left, runs web.ts on the port, and restarts it on exit', () => {
  const plist = fillTemplate(template, values);
  assert.match(plist, /<string>\/r\/scripts\/web\.ts<\/string>\s*<string>--port<\/string>\s*<string>47700<\/string>/);
  assert.match(plist, /<key>KeepAlive<\/key>\s*<true\/>/);
  assert.match(plist, /<key>RunAtLoad<\/key>\s*<true\/>/);
  assert.match(plist, new RegExp(`<string>${WEB_LABEL}</string>`));
});

test('a value the template needs but the installer forgot throws', () => {
  const { PORT: _port, ...rest } = values;
  assert.throws(() => fillTemplate(template, rest), /\{\{PORT\}\}/);
});

test('portFromUri reads a loopback footer link and falls back to the default for anything else', () => {
  assert.equal(portFromUri('http://127.0.0.1:47700/'), 47700);
  assert.equal(portFromUri('http://localhost:5000'), 5000);
  for (const bad of [undefined, '', 'obsidian://open?vault=x', 'http://example.com:47700/', 'http://127.0.0.1:99999/', 'http://127.0.0.1/']) assert.equal(portFromUri(bad), DEFAULT_PORT, String(bad));
});

test('commands name the web label, not the loop label', () => {
  const c = webCommands("/p's.plist", 501);
  assert.equal(c.unload, `launchctl bootout gui/501/${WEB_LABEL}`);
  assert.equal(c.load, "launchctl bootstrap gui/501 '/p'\\''s.plist'");
});
