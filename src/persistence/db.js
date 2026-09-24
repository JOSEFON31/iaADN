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
  created_at      INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS meta (
  key             TEXT PRIMARY KEY,
  value           TEXT
);

CREATE INDEX IF NOT EXISTS idx_fitness_history_instance ON fitness_history(instance_id);
CREATE INDEX IF NOT EXISTS idx_instances_alive ON instances(alive);
`;

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
  return db;
}
