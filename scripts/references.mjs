import crypto from 'node:crypto';
import fs from 'node:fs';
import {DatabaseSync} from 'node:sqlite';
import {identifier, validateEnvelope} from './schema.mjs';
import {keys, readJson, requireValue, scopedPath, writeJson} from './storage.mjs';

const short = value => typeof value === 'string' && /^[a-zA-Z0-9]{4}$/.test(value);
const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';

function requireInitialAllocation(root) {
  const file = scopedPath(root, 'Index/ledger.sqlite');
  if (!fs.existsSync(file)) return;
  for (const suffix of ['-journal', '-wal', '-shm']) scopedPath(root, `Index/ledger.sqlite${suffix}`);
  const db = new DatabaseSync(file, {readOnly: true});
  try {
    const metadata = db.prepare("SELECT name FROM sqlite_master WHERE name = 'metadata'").get();
    requireValue(!metadata || !db.prepare("SELECT value FROM metadata WHERE key = 'short_references'").get(),
      'Event reference reservations missing; restore from backup before continuing');
  } finally { db.close(); }
}

function legacyPending(root) {
  const directory = scopedPath(root, 'Pending');
  if (!fs.existsSync(directory)) return [];
  const events = [];
  for (const session of fs.readdirSync(directory)) {
    requireValue(identifier(session), 'Invalid pending session directory');
    for (const file of fs.readdirSync(scopedPath(root, `Pending/${session}`))) {
      if (!file.endsWith('.json') || file.endsWith('.state.json')) continue;
      const payload = validateEnvelope(readJson(root, `Pending/${session}/${file}`));
      requireValue(payload.session_id === session && file === `${payload.id}.json`, 'Pending identity/path mismatch');
      events.push(...payload.events);
    }
  }
  return events;
}

// Call under the ledger writer lock: reservations include uncommitted prepares.
export function eventReferences(root, events, generate = () =>
  Array.from({length: 4}, () => alphabet[crypto.randomInt(alphabet.length)]).join('')) {
  const stored = readJson(root, 'event-references.json');
  const saved = stored ?? {version: 1, entries: []};
  keys(saved, ['version', 'entries'], ['version', 'entries']);
  requireValue(saved.version === 1 && Array.isArray(saved.entries), 'Invalid event references');
  const byId = new Map();
  const byRef = new Map();
  for (const entry of saved.entries) {
    keys(entry, ['id', 'ref'], ['id', 'ref']);
    requireValue(identifier(entry.id) && short(entry.ref) && !byId.has(entry.id) && !byRef.has(entry.ref),
      'Invalid or duplicate event reference');
    byId.set(entry.id, entry.ref);
    byRef.set(entry.ref, entry.id);
  }
  if (!stored) {
    requireInitialAllocation(root);
    events = [...events, ...legacyPending(root)];
  }
  const ids = new Set([...byId.keys(), ...events.map(event => event.id)]);
  for (const id of ids) {
    requireValue(!byRef.has(id) || byRef.get(id) === id, 'Event ID conflicts with a reserved short reference');
  }
  const requested = new Set(events.map(event => event.short_ref ?? (short(event.id) ? event.id : null)).filter(Boolean));
  for (const event of events) {
    if (byId.has(event.id)) {
      requireValue(!event.short_ref || event.short_ref === byId.get(event.id), 'Event short reference changed');
      continue;
    }
    let ref = event.short_ref ?? (short(event.id) ? event.id : null);
    if (ref) requireValue(short(ref) && !byRef.has(ref) && (!ids.has(ref) || ref === event.id), 'Short reference collision');
    for (let attempt = 0; !ref && attempt < 128; attempt++) {
      const candidate = generate();
      requireValue(short(candidate), 'Invalid generated short reference');
      if (!byRef.has(candidate) && !ids.has(candidate) && !requested.has(candidate)) ref = candidate;
    }
    requireValue(ref, 'Short reference allocation exhausted; retry without discarding reservations');
    byId.set(event.id, ref);
    byRef.set(ref, event.id);
  }
  if (!stored || byId.size !== saved.entries.length) {
    writeJson(root, 'event-references.json', {version: 1, entries: [...byId].map(([id, ref]) => ({id, ref}))});
  }
  return byId;
}
