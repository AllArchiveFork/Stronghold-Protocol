// The feedback board's storage: one SQLite file through Node's built-in node:sqlite (owner-approved exception to the
// no-database rule, 2026-10-16). WAL + synchronous=FULL; every call is synchronous, so a check and the write after it
// cannot interleave with another request. No IP, session or hash of either is ever stored.
import { DatabaseSync } from 'node:sqlite';
import { closeSync, fsyncSync, mkdirSync, openSync, readdirSync, renameSync, rmSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';

/** Schema migrations, applied in order; `schema_version` records each one. Never edit a released entry. */
const MIGRATIONS = [
  `CREATE TABLE items (
     id INTEGER PRIMARY KEY AUTOINCREMENT, -- AUTOINCREMENT: a deleted id is never handed out again
     category TEXT NOT NULL CHECK (category IN ('bug', 'gameplay', 'ui', 'other')),
     title TEXT NOT NULL,
     body TEXT NOT NULL,
     author TEXT NOT NULL DEFAULT '',
     client TEXT NOT NULL DEFAULT '',
     status TEXT NOT NULL DEFAULT 'unassigned' CHECK (status IN ('unassigned', 'unplanned', 'planned', 'updated')),
     reply TEXT NOT NULL DEFAULT '',
     reply_at INTEGER,
     hidden INTEGER NOT NULL DEFAULT 0 CHECK (hidden IN (0, 1)),
     created_at INTEGER NOT NULL,
     updated_at INTEGER NOT NULL
   ) STRICT;
   CREATE INDEX items_status ON items (status, id);
   CREATE INDEX items_category ON items (category, id);
   CREATE INDEX items_created ON items (created_at);`,
];

export const BACKUP_RE = /^feedback-\d{4}-\d{2}-\d{2}\.sqlite$/;

/** The public JSON of a row; the admin view adds `hidden`. */
export function itemView(row, admin = false) {
  const item = {
    id: row.id, category: row.category, title: row.title, body: row.body, author: row.author, client: row.client,
    status: row.status, reply: row.reply, replyAt: row.reply_at ?? null, createdAt: row.created_at, updatedAt: row.updated_at,
  };
  if (admin) item.hidden = row.hidden === 1;
  return item;
}

// Each term must appear (ASCII case-insensitively, SQLite's default LIKE) in the title, body, reply or author.
const TERM_SQL = "(title LIKE ? ESCAPE '\\' OR body LIKE ? ESCAPE '\\' OR reply LIKE ? ESCAPE '\\' OR author LIKE ? ESCAPE '\\')";
const likePattern = (term) => `%${term.replace(/[\\%_]/g, '\\$&')}%`;

function filters({ admin = false, status = null, category = null, terms = [], before = null }) {
  const where = [], params = [];
  if (!admin) where.push('hidden = 0');
  if (status) { where.push('status = ?'); params.push(status); }
  if (category) { where.push('category = ?'); params.push(category); }
  if (before) { where.push('id < ?'); params.push(before); }
  for (const term of terms) {
    const pattern = likePattern(term);
    where.push(TERM_SQL);
    params.push(pattern, pattern, pattern, pattern);
  }
  return { sql: where.length ? ` WHERE ${where.join(' AND ')}` : '', params };
}

/**
 * @param {string} file the database path (its directory is created) or ':memory:'
 * @param {{ now?: () => number }} [opts]
 */
export function openStore(file, { now = Date.now } = {}) {
  if (file !== ':memory:') mkdirSync(dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  try {
    db.exec('PRAGMA busy_timeout = 5000');
    if (file !== ':memory:' && db.prepare('PRAGMA journal_mode = WAL').get().journal_mode !== 'wal') throw new Error('feedback database: WAL unavailable');
    db.exec('PRAGMA synchronous = FULL');
    // a read-only container root has no writable /tmp
    db.exec('PRAGMA temp_store = MEMORY');
    db.exec('CREATE TABLE IF NOT EXISTS schema_version (version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL) STRICT');
    const current = db.prepare('SELECT COALESCE(MAX(version), 0) AS v FROM schema_version').get().v;
    if (current > MIGRATIONS.length) throw new Error(`feedback database schema ${current} is newer than this service`);
    for (let version = current + 1; version <= MIGRATIONS.length; version++) {
      db.exec('BEGIN IMMEDIATE');
      try {
        db.exec(MIGRATIONS[version - 1]);
        db.prepare('INSERT INTO schema_version (version, applied_at) VALUES (?, ?)').run(version, now());
        db.exec('COMMIT');
      } catch (e) { db.exec('ROLLBACK'); throw e; }
    }
  } catch (e) { db.close(); throw e; }

  const cache = new Map();
  const prepare = (sql) => {
    let stmt = cache.get(sql);
    if (!stmt) cache.set(sql, stmt = db.prepare(sql));
    return stmt;
  };
  const row = (id) => prepare('SELECT * FROM items WHERE id = ?').get(id) ?? null;

  return {
    /** @returns {any} the row of an id, hidden or not; null when there is none */
    get: row,
    /** Newest first; `next` is the `before` of the following page, null on the last one. */
    list({ admin, status, category, terms, before, limit }) {
      const { sql, params } = filters({ admin, status, category, terms, before });
      const rows = prepare(`SELECT * FROM items${sql} ORDER BY id DESC LIMIT ?`).all(...params, limit + 1);
      const more = rows.length > limit;
      if (more) rows.length = limit;
      return { rows, next: more ? rows[rows.length - 1].id : null };
    },
    /** Per status, under the category and search filters (not the status filter). */
    counts({ admin, category, terms }) {
      const { sql, params } = filters({ admin, category, terms });
      const counts = { all: 0, unassigned: 0, unplanned: 0, planned: 0, updated: 0 };
      for (const { status, n } of prepare(`SELECT status, COUNT(*) AS n FROM items${sql} GROUP BY status`).all(...params)) {
        counts[status] = n;
        counts.all += n;
      }
      return counts;
    },
    visibleCount: () => prepare('SELECT COUNT(*) AS n FROM items WHERE hidden = 0').get().n,
    /** The newest item with exactly this title and body created after `since` (hidden ones included), or null. */
    duplicateOf(title, body, since) {
      return prepare('SELECT id FROM items WHERE created_at > ? AND title = ? AND body = ? ORDER BY id DESC LIMIT 1')
        .get(since, title, body)?.id ?? null;
    },
    create({ category, title, body, author, client }, at) {
      const { lastInsertRowid } = prepare('INSERT INTO items (category, title, body, author, client, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(category, title, body, author, client, at, at);
      return row(Number(lastInsertRowid));
    },
    /** Applies the owner's patch; updated_at moves only on an actual change, reply_at when the reply becomes a new non-empty text. */
    update(id, { status, reply, hidden }, at) {
      const old = row(id);
      if (!old) return null;
      const next = { status: old.status, reply: old.reply, replyAt: old.reply_at, hidden: old.hidden };
      if (status !== undefined) next.status = status;
      if (reply !== undefined && reply !== old.reply) { next.reply = reply; next.replyAt = reply ? at : null; }
      if (hidden !== undefined) next.hidden = hidden ? 1 : 0;
      if (next.status === old.status && next.reply === old.reply && next.hidden === old.hidden) return old;
      prepare('UPDATE items SET status = ?, reply = ?, reply_at = ?, hidden = ?, updated_at = ? WHERE id = ?')
        .run(next.status, next.reply, next.replyAt, next.hidden, at, id);
      return row(id);
    },
    remove: (id) => prepare('DELETE FROM items WHERE id = ?').run(id).changes > 0,
    /**
     * Today's (UTC) `feedback-YYYY-MM-DD.sqlite` in `dir` via VACUUM INTO, unless it exists; then only the newest `keep`
     * dated files stay. A partial file is written under a dot name, synced and renamed into place.
     */
    backup(dir, at, keep = 14) {
      mkdirSync(dir, { recursive: true });
      const name = `feedback-${new Date(at).toISOString().slice(0, 10)}.sqlite`;
      const target = join(dir, name);
      let created = false;
      try { statSync(target); } catch (e) {
        if (e?.code !== 'ENOENT') throw e;
        const partial = join(dir, `.${name}.partial`);
        rmSync(partial, { force: true });
        db.prepare('VACUUM INTO ?').run(partial);
        const fd = openSync(partial, 'r');
        try { fsyncSync(fd); } finally { closeSync(fd); }
        renameSync(partial, target);
        created = true;
      }
      const dated = readdirSync(dir).filter((f) => BACKUP_RE.test(f)).sort().reverse();
      for (const old of dated.slice(keep)) rmSync(join(dir, old), { force: true });
      return { name, created, removed: Math.max(0, dated.length - keep) };
    },
    close() { cache.clear(); if (db.isOpen) db.close(); },
  };
}
