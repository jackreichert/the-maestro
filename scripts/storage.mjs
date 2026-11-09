import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import os from 'node:os';
import {isUtf8} from 'node:buffer';

export function requireValue(condition, message) {
  if (!condition) throw new Error(message);
}

export const hash = (text) => crypto.createHash('sha256').update(text).digest('hex');
export const canonical = (value) => {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).filter((key) => value[key] !== undefined).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
};

export function prohibited(name) {
  return /^\.env/i.test(name) || /^ssm-.*\.json$/i.test(name);
}

export function rootDirectory(value) {
  requireValue(typeof value === 'string' && path.isAbsolute(value), 'Configured roots must be absolute existing directories');
  requireValue(!value.split(path.sep).some(prohibited), 'Prohibited root');
  const stat = fs.lstatSync(value);
  requireValue(stat.isDirectory() && !stat.isSymbolicLink(), 'Root must be a directory, not a symlink');
  const root = fs.realpathSync(value);
  requireValue(!root.split(path.sep).some(prohibited), 'Prohibited resolved root');
  return root;
}

export function scopedPath(root, relative) {
  requireValue(typeof relative === 'string' && relative.length > 0
    && !path.isAbsolute(relative) && !relative.includes('\\')
    && relative.split('/').every((part) => part && part !== '.' && part !== '..' && !prohibited(part)),
  'Unsafe relative path');
  let target = root;
  for (const part of relative.split('/')) {
    target = path.join(target, part);
    if (!fs.existsSync(target)) {
      try {
        fs.lstatSync(target);
      } catch (error) {
        if (error.code === 'ENOENT') continue;
        throw error;
      }
    }
    const stat = fs.lstatSync(target);
    requireValue(!stat.isSymbolicLink(), 'Symlink targets are not allowed');
  }
  return target;
}

export function readText(root, relative) {
  const file = scopedPath(root, relative);
  try {
    requireValue(fs.lstatSync(file).isFile(), 'Expected a regular file');
    const bytes = fs.readFileSync(file);
    requireValue(isUtf8(bytes), 'Invalid UTF-8 file; preserve bytes and reconcile');
    return bytes.toString('utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

export function readJson(root, relative) {
  const text = readText(root, relative);
  if (text === null) return null;
  try {
    return JSON.parse(text);
  } catch {
    throw new Error('Invalid persisted JSON; manual reconciliation required');
  }
}

function syncDirectory(directory) {
  const fd = fs.openSync(directory, 'r');
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}

export function ensureDirectory(root, relative) {
  scopedPath(root, relative);
  let directory = root;
  for (const part of relative.split('/')) {
    const next = path.join(directory, part);
    if (!fs.existsSync(next)) {
      fs.mkdirSync(next, {mode: 0o700});
      syncDirectory(directory);
    }
    requireValue(fs.lstatSync(next).isDirectory(), 'Expected a directory');
    directory = next;
  }
}

export function atomicWrite(root, relative, text) {
  const file = scopedPath(root, relative);
  if (path.dirname(relative) !== '.') ensureDirectory(root, path.dirname(relative));
  scopedPath(root, relative);
  const temp = `${file}.${crypto.randomUUID()}.tmp`;
  try {
    const fd = fs.openSync(temp, 'wx', 0o600);
    try {
      fs.writeFileSync(fd, text);
      fs.fsyncSync(fd);
    } finally { fs.closeSync(fd); }
    fs.renameSync(temp, file);
    syncDirectory(path.dirname(file));
    requireValue(fs.readFileSync(file, 'utf8') === text, 'Write read-back failed');
  } finally {
    if (fs.existsSync(temp)) fs.unlinkSync(temp);
  }
}

export const writeJson = (root, relative, value) => atomicWrite(root, relative, `${JSON.stringify(value, null, 2)}\n`);

export function withLock(root, action) {
  const lock = scopedPath(root, '.writer.lock');
  try {
    fs.mkdirSync(lock, {mode: 0o700});
  } catch (error) {
    if (error.code === 'EEXIST') throw new Error('Writer lock held; retry later or reconcile stale ownership manually');
    throw error;
  }
  try {
    fs.writeFileSync(path.join(lock, 'owner.json'), JSON.stringify({pid: process.pid, host: os.hostname(), started: new Date().toISOString()}), {flag: 'wx', mode: 0o600});
    return action();
  } finally {
    if (fs.existsSync(path.join(lock, 'owner.json'))) fs.unlinkSync(path.join(lock, 'owner.json'));
    fs.rmdirSync(lock);
  }
}

export function appendLine(root, relative, value) {
  const file = scopedPath(root, relative);
  if (path.dirname(relative) !== '.') ensureDirectory(root, path.dirname(relative));
  const line = Buffer.from(`${JSON.stringify(value)}\n`);
  const fd = fs.openSync(scopedPath(root, relative), 'a+', 0o600);
  try {
    const initialSize = fs.fstatSync(fd).size;
    fs.writeFileSync(fd, line);
    fs.fsyncSync(fd);
    const readBack = Buffer.alloc(line.length);
    requireValue(fs.fstatSync(fd).size === initialSize + line.length
      && fs.readSync(fd, readBack, 0, line.length, initialSize) === line.length && line.equals(readBack),
    'Append read-back failed; preserve journal and reconcile');
  } finally { fs.closeSync(fd); }
  syncDirectory(path.dirname(file));
}

export function keys(object, allowed, required = []) {
  requireValue(object && typeof object === 'object' && !Array.isArray(object), 'Expected an object');
  requireValue(Object.keys(object).every((key) => allowed.includes(key)), 'Unknown field');
  requireValue(required.every((key) => Object.hasOwn(object, key)), 'Missing required field');
}

function merge(base, overrides) {
  const result = Object.assign(Object.create(null), base);
  for (const [key, value] of Object.entries(overrides)) {
    result[key] = value && typeof value === 'object' && !Array.isArray(value)
      ? merge(Object.hasOwn(base, key) ? base[key] ?? {} : {}, value) : value;
  }
  return result;
}

function settingsJson(file, optional) {
  try {
    requireValue(path.isAbsolute(file) && !file.split(path.sep).some(prohibited), 'Prohibited settings file');
    requireValue(fs.lstatSync(file).isFile()
      && !fs.realpathSync(file).split(path.sep).some(prohibited), 'Prohibited settings target');
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    if (optional && error.code === 'ENOENT') return {};
    throw new Error('Settings unavailable or invalid; correct the configuration');
  }
}

function readSettings(defaultFile, localFile) {
  const base = settingsJson(defaultFile, false);
  const local = settingsJson(localFile, true);
  keys(base, ['schema_version', 'paths', 'pr_budget', 'repos'], ['schema_version', 'paths', 'pr_budget', 'repos']);
  keys(local, ['schema_version', 'paths', 'pr_budget', 'repos']);
  if (local.paths) keys(local.paths, ['vault_root', 'ledger_root', 'container_root']);
  if (local.pr_budget) keys(local.pr_budget, ['max_code_files', 'max_changed_code_lines']);
  const settings = merge(base, local);
  requireValue(settings.schema_version === 1, 'Unsupported settings schema');
  keys(settings.paths, ['vault_root', 'ledger_root', 'container_root'], ['vault_root', 'ledger_root', 'container_root']);
  for (const value of Object.values(settings.paths)) {
    requireValue(value === null || (typeof value === 'string' && path.isAbsolute(value)), 'Invalid configured path');
  }
  keys(settings.pr_budget, ['max_code_files', 'max_changed_code_lines'], ['max_code_files', 'max_changed_code_lines']);
  requireValue(Object.values(settings.pr_budget).every((value) => Number.isInteger(value) && value > 0)
    && settings.pr_budget.max_changed_code_lines <= 1000, 'Invalid PR budget');
  keys(settings.repos, Object.keys(settings.repos));
  for (const [repo, config] of Object.entries(settings.repos)) {
    requireValue(/^[\w.-]+\/[\w.-]+$/.test(repo), 'Invalid repo key');
    keys(config, ['branch_flow', 'environments', 'max_code_files']);
    requireValue(!config.branch_flow || ['maintained-staging', 'repo-specific'].includes(config.branch_flow), 'Invalid branch flow');
    if (config.max_code_files !== undefined) requireValue(Number.isInteger(config.max_code_files) && config.max_code_files > 0, 'Invalid repo budget');
    if (config.environments !== undefined) {
      keys(config.environments, Object.keys(config.environments));
      requireValue(Object.entries(config.environments).every(([key, value]) => key && typeof value === 'string' && value.length > 0), 'Invalid environment mapping');
    }
  }
  return settings;
}

function requireSeparateRoots(ledger, vault) {
  requireValue(ledger !== vault && !ledger.startsWith(`${vault}${path.sep}`) && !vault.startsWith(`${ledger}${path.sep}`),
    'Ledger and vault roots must be separate, non-overlapping directories');
}

export function loadSettings(defaultFile, localFile) {
  const settings = readSettings(defaultFile, localFile);
  const ledger = rootDirectory(settings.paths.ledger_root);
  const vault = rootDirectory(settings.paths.vault_root);
  requireSeparateRoots(ledger, vault);
  return {settings, ledger, vault};
}

export function loadStatuslineSettings(defaultFile, localFile) {
  const settings = readSettings(defaultFile, localFile);
  const ledger = settings.paths.ledger_root === null ? null : rootDirectory(settings.paths.ledger_root);
  const vault = settings.paths.vault_root === null ? null : rootDirectory(settings.paths.vault_root);
  if (ledger && vault) requireSeparateRoots(ledger, vault);
  return {settings, ledger, vault};
}
