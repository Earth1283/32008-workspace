import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS docs (
  coll TEXT NOT NULL,
  id TEXT NOT NULL,
  data TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  updated_by TEXT,
  PRIMARY KEY (coll, id)
);
CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  username TEXT NOT NULL UNIQUE COLLATE NOCASE,
  pass TEXT NOT NULL,
  access TEXT NOT NULL,
  must_change INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL
);
`;

export function openDb(path) {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
  db.exec(SCHEMA);
  return db;
}

const depth = new WeakMap();

/** Run fn inside a write transaction. fn must be synchronous. Nested calls join the outer one. */
export function tx(db, fn) {
  if (depth.get(db)) return fn();
  db.exec("BEGIN IMMEDIATE");
  depth.set(db, 1);
  try {
    const r = fn();
    db.exec("COMMIT");
    return r;
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  } finally {
    depth.set(db, 0);
  }
}

const ORDER = {
  practice: (a, b) => a.date.localeCompare(b.date),
  meetings: (a, b) => b.date.localeCompare(a.date),
  milestones: (a, b) => a.date.localeCompare(b.date),
  phases: (a, b) => a.start.localeCompare(b.start),
};

export function makeStore(db) {
  const q = {
    list: db.prepare("SELECT id, data FROM docs WHERE coll = ? ORDER BY rowid"),
    get: db.prepare("SELECT data FROM docs WHERE coll = ? AND id = ?"),
    put: db.prepare(`INSERT INTO docs (coll, id, data, updated_at, updated_by) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(coll, id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at, updated_by = excluded.updated_by`),
    del: db.prepare("DELETE FROM docs WHERE coll = ? AND id = ?"),
    metaGet: db.prepare("SELECT value FROM meta WHERE key = ?"),
    metaPut: db.prepare("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value"),
  };
  const withId = (coll, id, data) => ({ ...JSON.parse(data), id: coll === "issues" ? Number(id) : id });

  return {
    list(coll) {
      const rows = q.list.all(coll).map((r) => withId(coll, r.id, r.data));
      return ORDER[coll] ? rows.sort(ORDER[coll]) : rows;
    },
    get(coll, id) {
      const r = q.get.get(coll, String(id));
      return r ? withId(coll, id, r.data) : null;
    },
    put(coll, id, doc, by) {
      const { id: _drop, ...rest } = doc;
      q.put.run(coll, String(id), JSON.stringify(rest), Date.now(), by ?? null);
    },
    del(coll, id) {
      return q.del.run(coll, String(id)).changes > 0;
    },
    meta(key, fallback = null) {
      const r = q.metaGet.get(key);
      return r ? JSON.parse(r.value) : fallback;
    },
    setMeta(key, value) {
      q.metaPut.run(key, JSON.stringify(value));
    },
    /** Next issue number, never reused. Call inside a transaction. */
    nextIssueId() {
      const n = this.meta("nextIssue", 1);
      this.setMeta("nextIssue", n + 1);
      return n;
    },
  };
}
