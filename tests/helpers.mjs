import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {loadSettings} from '../scripts/storage.mjs';

export const project = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
export const cliPath = path.join(project, 'scripts/memory.mjs');

export function fixture(t) {
  const temp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'maestro-test-')));
  t.after(() => fs.rmSync(temp, {recursive: true, force: true}));
  const ledger = path.join(temp, 'ledger');
  const vault = path.join(temp, 'vault');
  fs.mkdirSync(ledger);
  fs.mkdirSync(vault);
  const config = path.join(temp, 'settings.json');
  fs.writeFileSync(config, JSON.stringify({paths: {ledger_root: ledger, vault_root: vault}}));
  return {...loadSettings(path.join(project, 'settings.json'), config), temp, config};
}

export function memoryCli(f, command, args = [], stdin) {
  return spawnSync(process.execPath, [cliPath, command, '--settings', f.config, ...args], {
    input: stdin === undefined ? undefined : JSON.stringify(stdin), encoding: 'utf8',
  });
}
