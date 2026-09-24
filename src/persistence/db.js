// iaADN - Database: SQLite-backed durable storage
// Single source of truth for population, lineage and fitness history across
// restarts. See docs/PLAN_EVOLUCION.md section "0. Cimientos".

import Database from 'better-sqlite3';
import { existsSync, mkdirSync } from 'fs';
import { dirname, resolve } from 'path';
import { getConfig } from '../config.js';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS instances (
  instance_id     TEXT PRIMARY KEY,
  parent_ids      TEXT NOT NULL,
  generation      INTEGER NOT NULL,
  genome_json     TEXT NOT NULL,
  genome_hash     TEXT,
  birth_node      TEXT,
  alive           INTEGER NOT NULL DEFAULT 1,
  fitness         REAL,
  birth_time      INTEGER NOT NULL,
  death_time      INTEGER,
  death_reason    TEXT
);

CREATE TABLE IF NOT EXISTS fitness_history (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  instance_id     TEXT NOT NULL,
  overall         REAL NOT NULL,
  dimensions_json TEXT,
  evaluated_at    INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS generations (
  generation      INTEGER PRIMARY KEY,
  stats_json      TEXT NOT NULL,
  seed            TEXT,
  recorded_at     INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS interactions (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  query           TEXT NOT NULL,
  response        TEXT,
  instance_id     TEXT,
  rating          INTEGER,
  source          TEXT NOT NULL DEFAULT 'chat', -- 'chat' | 'task' — see Fase 3
  domain          TEXT,                          -- task domain, when source = 'task'
  created_at      INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS meta (
  key             TEXT PRIMARY KEY,
  value           TEXT
);

CREATE INDEX IF NOT EXISTS idx_fitness_history_instance ON fitness_history(instance_id);
CREATE INDEX IF NOT EXISTS idx_instances_alive ON instances(alive);
CREATE INDEX IF NOT EXISTS idx_interactions_rating ON interactions(rating);

-- Keyword search over well-rated exchanges — a stand-in for real semantic
-- memory (that needs embeddings from a real model, which this project
-- doesn't have loaded). See PersistenceStore.searchMemory / Fase 3.
CREATE VIRTUAL TABLE IF NOT EXISTS interactions_fts USING fts5(query, response, interaction_id UNINDEXED);
`;

// Add a column to an existing table if it isn't already there — SQLite has
// no "ADD COLUMN IF NOT EXISTS", and CREATE TABLE IF NOT EXISTS above only
// helps for a database created fresh with the current schema. Needed so a
// database from an earlier version of this branch (before `source`/`domain`
// existed) still opens cleanly instead of erroring on first write.
function ensureColumn(db, table, column, ddl) {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all();
  if (!columns.some(c => c.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
  }
}

// Open (creating if needed) the iaADN SQLite database and ensure the schema
// exists. `filePath` is mainly for tests — production code always uses the
// configured data directory.
export function openDatabase(filePath) {
  const targetPath = filePath || resolve(getConfig().paths.data, 'iaadn.db');
  const dir = dirname(targetPath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  const db = new Database(targetPath);
  db.pragma('journal_mode = WAL');
  db.exec(SCHEMA);
  ensureColumn(db, 'interactions', 'source', `source TEXT NOT NULL DEFAULT 'chat'`);
  ensureColumn(db, 'interactions', 'domain', 'domain TEXT');
  return db;
}
