import {DatabaseSync} from 'node:sqlite';
import {randomUUID} from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import {canonical, hash, keys, requireValue, rootDirectory, scopedPath} from '../storage.mjs';

export const identifier = value => typeof value === 'string' && /^[a-zA-Z0-9][\w-]{0,127}$/.test(value);
const bounded = value => typeof value === 'string' && value.length > 0 && value.length <= 2000;
const timestamp = value => typeof value === 'string' && /(?:Z|[+-]\d\d:\d\d)$/.test(value)
  && Number.isFinite(Date.parse(value));

export class EventStore {
  constructor(root) {
    this.root = rootDirectory(root);
    const stat = fs.statSync(this.root);
    requireValue(stat.uid === process.getuid() && !(stat.mode & 0o077), 'Event root must be owner-only (mode 0700)');
    for (const suffix of ['', '-wal', '-shm', '-journal']) scopedPath(this.root, `events.sqlite${suffix}`);
    const file = scopedPath(this.root, 'events.sqlite');
    fs.closeSync(fs.openSync(file, 'a', 0o600));
    fs.chmodSync(file, 0o600);
    this.db = new DatabaseSync(file);
    this.db.exec(`PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS records (kind TEXT, id TEXT, json TEXT NOT NULL, PRIMARY KEY(kind,id));`);
    const meta = this.get('meta', 'schema');
    requireValue(!meta || (meta.version === 1 && meta.host === os.hostname()), 'Unsupported event schema or non-local state');
    this.put('meta', {id: 'schema', version: 1, host: os.hostname()});
  }

  close() { this.db.close(); }
  get(kind, id) {
    const row = this.db.prepare('SELECT json FROM records WHERE kind=? AND id=?').get(kind, id);
    return row ? JSON.parse(row.json) : null;
  }
  all(kind) {
    return this.db.prepare('SELECT json FROM records WHERE kind=? ORDER BY id').all(kind).map(row => JSON.parse(row.json));
  }
  put(kind, value) {
    this.db.prepare('INSERT OR REPLACE INTO records VALUES (?,?,?)').run(kind, value.id, JSON.stringify(value));
    return value;
  }
  transaction(action) {
    this.db.exec('BEGIN IMMEDIATE');
    try { const result = action(); this.db.exec('COMMIT'); return result; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }

  attach(session, identity) {
    requireValue(identifier(session), 'Invalid session ID');
    return this.transaction(() => {
      const previous = this.all('session').find(s => s.session === session && s.id !== identity.key);
      if (previous?.active) throw new Error('Session already registered to another process; detach/reconcile it first');
      if (previous) {
        for (const kind of ['watch', 'event', 'job']) for (const record of this.all(kind)) {
          if (record.owner === previous.id) this.put(kind, {...record, owner: identity.key});
        }
        this.db.prepare('DELETE FROM records WHERE kind=? AND id=?').run('session', previous.id);
      }
      return this.put('session', {id: identity.key, session, identity, active: true});
    });
  }

  detach(session, owner) {
    return this.transaction(() => {
      for (const record of this.all('session')) if (record.session === session && (!owner || record.id === owner)) {
        this.put('session', {...record, active: false});
      }
    });
  }

  prune(isAlive) {
    for (const record of this.all('session')) {
      if (record.active && !isAlive(record.identity)) this.detach(record.session, record.id);
    }
    for (const claim of this.all('claim')) if (!isAlive(claim.identity)) this.release(claim);
    return this.all('session').filter(s => s.active);
  }

  owner(session) {
    const record = this.all('session').find(s => s.active && s.session === session);
    requireValue(record, 'No active registration for session');
    return record.id;
  }

  claim(role, identity, isAlive) {
    return this.transaction(() => {
      const old = this.get('claim', role);
      if (old && isAlive(old.identity)) return null;
      return this.put('claim', {id: role, identity, token: randomUUID()});
    });
  }

  release(claim) {
    if (!claim) return;
    this.transaction(() => {
      if (this.get('claim', claim.id)?.token === claim.token) {
        this.db.prepare('DELETE FROM records WHERE kind=? AND id=?').run('claim', claim.id);
      }
    });
  }

  register(input, owner, now = Date.now()) {
    keys(input, ['id', 'type', 'due', 'timezone', 'expires', 'repo', 'number'],
      ['id', 'type', 'expires']);
    requireValue(identifier(input.id) && ['reminder', 'pr'].includes(input.type), 'Invalid watch ID/type');
    requireValue(timestamp(input.expires) && Date.parse(input.expires) > now, 'Expiry must be a future offset timestamp');
    if (input.type === 'reminder') {
      requireValue(timestamp(input.due) && Date.parse(input.due) < Date.parse(input.expires)
        && bounded(input.timezone), 'Reminder requires due timestamp, time zone and later expiry');
      new Intl.DateTimeFormat('en', {timeZone: input.timezone});
    } else {
      requireValue(typeof input.repo === 'string' && /^[\w.-]+\/[\w.-]+$/.test(input.repo)
        && Number.isSafeInteger(input.number) && input.number > 0, 'Invalid repository/PR number');
    }
    return this.transaction(() => {
      requireValue(!this.get('watch', input.id), 'Watch ID already exists; use a new ID');
      return this.put('watch', {...input, owner, status: 'active', next: now, failures: 0});
    });
  }

  cancel(id, owner) {
    return this.transaction(() => {
      const watch = this.get('watch', id);
      requireValue(watch && watch.owner === owner, 'Unknown watch for this process');
      this.put('watch', {...watch, status: 'cancelled'});
      for (const event of this.all('event')) if (event.watch === id && !['acked', 'dead'].includes(event.status)) {
        this.put('event', {...event, status: 'cancelled'});
      }
    });
  }

  emit(watch, key, type, detail, now = Date.now()) {
    const id = hash(`${watch.id}:${key}`).slice(0, 32);
    if (this.get('event', id)) return;
    this.put('event', {id, watch: watch.id, owner: watch.owner, type, detail,
      created: now, status: 'pending', attempts: 0, next: now});
  }

  deliver(owner, now = Date.now(), retry = 30000) {
    return this.transaction(() => {
      for (const event of this.all('event')) {
        if (event.owner !== owner || !['pending', 'inflight'].includes(event.status) || event.next > now) continue;
        const watch = this.get('watch', event.watch);
        if (watch && Date.parse(watch.expires) <= now) {
          this.put('event', {...event, status: 'expired'});
          continue;
        }
        if (event.attempts >= 3) { this.put('event', {...event, status: 'dead'}); continue; }
        return this.put('event', {...event, status: 'inflight', attempts: event.attempts + 1,
          delivered: now, next: now + retry * 2 ** event.attempts});
      }
      return null;
    });
  }

  ack(id, owner) {
    return this.transaction(() => {
      const event = this.get('event', id);
      requireValue(event && event.owner === owner, 'Unknown event for this process');
      requireValue(['inflight', 'acked'].includes(event.status), 'Only delivered events may be acknowledged');
      return this.put('event', {...event, status: 'acked'});
    });
  }

  tick(checkPR, isAlive, now = Date.now()) {
    const sessions = this.prune(isAlive);
    const owners = new Set(sessions.map(s => s.id));
    let checkedPR = false;
    for (const watch of this.all('watch').sort((a, b) => a.next - b.next)) {
      if (watch.status !== 'active') continue;
      if (Date.parse(watch.expires) <= now) {
        this.transaction(() => {
          const current = this.get('watch', watch.id);
          if (current.status === 'active') this.put('watch', {...current, status: 'expired'});
        });
        continue;
      }
      if (!owners.has(watch.owner) || watch.next > now) continue;
      if (watch.type === 'pr' && checkedPR) continue;
      if (watch.type === 'pr') checkedPR = true;
      let result;
      try { result = watch.type === 'pr' ? checkPR(watch) : null; }
      catch (error) {
        this.transaction(() => {
          const current = this.get('watch', watch.id);
          if (current.status !== 'active') return;
          this.emit(current, `error:${current.failures === 0 ? now : current.errorSince}`, 'watch-error',
            'PR observation unavailable; inspect runner log. Unknown is not clean.', now);
          this.put('watch', {...current, failures: current.failures + 1, errorSince: current.errorSince ?? now,
            next: now + Math.min(900000, 60000 * 2 ** Math.min(current.failures, 4))});
        });
        console.error(`PR watch ${watch.id} failed: ${error.message}`);
        continue;
      }
      this.transaction(() => {
        const current = this.get('watch', watch.id);
        if (current.status !== 'active') return;
        if (watch.type === 'reminder') {
          if (Date.parse(watch.due) <= now) {
            this.emit(current, 'due', 'reminder', {due: current.due, timezone: current.timezone}, now);
            this.put('watch', {...current, status: 'completed'});
          }
          return;
        }
        for (const item of result.items) {
          if (!(current.seen ?? []).includes(item.key)) this.emit(current, `${current.generation ?? 0}:${item.key}`, item.type, item.url, now);
        }
        if (result.closed) for (const event of this.all('event')) {
          if (event.watch === watch.id && ['pending', 'inflight'].includes(event.status)) {
            this.put('event', {...event, status: 'cancelled'});
          }
        }
        const seen = result.items.map(i => i.key);
        const changed = canonical(seen) !== canonical(current.seen ?? []);
        this.put('watch', {...current, seen, generation: (current.generation ?? 0) + (changed ? 1 : 0),
          next: now + 60000, failures: 0, errorSince: null, status: result.closed ? 'completed' : 'active'});
      });
    }
    return sessions;
  }
}
