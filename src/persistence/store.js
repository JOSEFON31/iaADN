// iaADN - Persistence Store: durable population/lineage state across restarts
// Mirrors the in-memory Lineage/Population bookkeeping into SQLite so the
// daemon can be killed and restarted without losing evolutionary history.
// Wired in via Lineage({ persistence }) and Population({ persistence }) —
// see src/index.js boot().

import { openDatabase } from './db.js';
import { Genome } from '../genome/genome.js';

export class PersistenceStore {
  constructor(filePath) {
    this.db = openDatabase(filePath);

    this._insertInstance = this.db.prepare(`
      INSERT INTO instances (instance_id, parent_ids, generation, genome_json, genome_hash, birth_node, alive, fitness, birth_time)
      VALUES (@instanceId, @parentIds, @generation, @genomeJson, @genomeHash, @birthNode, 1, NULL, @birthTime)
      ON CONFLICT(instance_id) DO NOTHING
    `);
    this._markDead = this.db.prepare(`
      UPDATE instances SET alive = 0, death_time = @deathTime, death_reason = @reason WHERE instance_id = @instanceId
    `);
    this._updateFitness = this.db.prepare(`
      UPDATE instances SET fitness = @fitness WHERE instance_id = @instanceId
    `);
    this._insertFitnessHistory = this.db.prepare(`
      INSERT INTO fitness_history (instance_id, overall, dimensions_json, evaluated_at)
      VALUES (@instanceId, @overall, @dimensionsJson, @evaluatedAt)
    `);
    this._upsertGeneration = this.db.prepare(`
      INSERT INTO generations (generation, stats_json, seed, recorded_at)
      VALUES (@generation, @statsJson, @seed, @recordedAt)
      ON CONFLICT(generation) DO UPDATE SET stats_json = excluded.stats_json, seed = excluded.seed, recorded_at = excluded.recorded_at
    `);
    this._insertInteraction = this.db.prepare(`
      INSERT INTO interactions (query, response, instance_id, rating, source, domain, created_at)
      VALUES (@query, @response, @instanceId, @rating, @source, @domain, @createdAt)
    `);
    this._updateRating = this.db.prepare(`UPDATE interactions SET rating = @rating WHERE id = @id`);
    this._selectInteraction = this.db.prepare(`SELECT * FROM interactions WHERE id = ?`);
    this._insertMemory = this.db.prepare(`
      INSERT INTO interactions_fts (query, response, interaction_id) VALUES (@query, @response, @id)
    `);
    this._deleteMemory = this.db.prepare(`DELETE FROM interactions_fts WHERE interaction_id = ?`);
    this._searchMemory = this.db.prepare(`
      SELECT interaction_id, query, response FROM interactions_fts WHERE interactions_fts MATCH @query
      ORDER BY rank LIMIT @limit
    `);
    this._selectAlive = this.db.prepare(`SELECT * FROM instances WHERE alive = 1`);
    this._selectAll = this.db.prepare(`SELECT * FROM instances`);
    this._selectMaxGeneration = this.db.prepare(`SELECT MAX(generation) AS maxGen FROM generations`);
    this._selectRecentGenerations = this.db.prepare(`
      SELECT generation, stats_json, seed, recorded_at FROM generations ORDER BY generation DESC LIMIT ?
    `);
    this._selectMeta = this.db.prepare(`SELECT value FROM meta WHERE key = ?`);
    this._upsertMeta = this.db.prepare(`
      INSERT INTO meta (key, value) VALUES (@key, @value)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `);
  }

  // --- Lineage mirror (called from Lineage.recordBirth/recordDeath/updateFitness) ---

  recordBirth(genome) {
    this._insertInstance.run({
      instanceId: genome.instanceId,
      parentIds: JSON.stringify(genome.parentIds),
      generation: genome.generation,
      genomeJson: JSON.stringify(genome.toJSON()),
      genomeHash: genome.hash(),
      birthNode: genome.birthNode,
      birthTime: genome.createdAt || Date.now(),
    });
  }

  recordDeath(instanceId, reason) {
    this._markDead.run({ instanceId, deathTime: Date.now(), reason: reason || null });
  }

  updateFitness(instanceId, fitness) {
    this._updateFitness.run({ instanceId, fitness });
  }

  // --- Fitness detail history (called from Population._doEvaluateAll) ---

  recordFitnessDetail(instanceId, fitnessResult) {
    this._insertFitnessHistory.run({
      instanceId,
      overall: fitnessResult.overall,
      dimensionsJson: JSON.stringify(fitnessResult.dimensions || {}),
      evaluatedAt: fitnessResult.evaluatedAt || Date.now(),
    });
  }

  // --- Generation stats (called from Population.runGeneration) ---

  recordGeneration(generation, stats, seed = null) {
    this._upsertGeneration.run({
      generation,
      statsJson: JSON.stringify(stats),
      seed,
      recordedAt: Date.now(),
    });
  }

  // --- Chat/hive interactions and the dataset/memory built from them (Fase 3) ---

  // `source`: 'chat' (a real user exchange) or 'task' (a task-bank attempt
  // during fitness evaluation — see Population._doEvaluateAll). `domain` is
  // set for 'task' rows. Returns the new row's id, so a chat reply can be
  // rated later via rateInteraction(). A rating given at creation time (task
  // attempts always come in already labeled 1/-1) is indexed into the
  // keyword-memory table immediately if positive.
  recordInteraction({ query, response, instanceId = null, rating = null, source = 'chat', domain = null }) {
    const info = this._insertInteraction.run({ query, response, instanceId, rating, source, domain, createdAt: Date.now() });
    const id = info.lastInsertRowid;
    if (rating >= 1) this._insertMemory.run({ query, response, id });
    return id;
  }

  // Rate (or re-rate) an existing interaction — e.g. a 👍/👎 on a chat reply.
  // Keeps the keyword-memory index in sync: only rating >= 1 exchanges are
  // searchable, so downvoting one removes it and upvoting one adds it.
  rateInteraction(id, rating) {
    const row = this._selectInteraction.get(id);
    if (!row) return false;
    this._updateRating.run({ id, rating });
    this._deleteMemory.run(id);
    if (rating >= 1) this._insertMemory.run({ query: row.query, response: row.response, id });
    return true;
  }

  // Keyword search over well-rated exchanges — see the FTS5 table comment in
  // src/persistence/db.js for why this is search, not semantic memory.
  searchMemory(text, limit = 3) {
    const query = ftsQuery(text);
    if (!query) return [];
    try {
      return this._searchMemory.all({ query, limit }).map(row => ({
        interactionId: row.interaction_id,
        query: row.query,
        response: row.response,
      }));
    } catch {
      return []; // malformed FTS query (e.g. only punctuation) — no matches, not an error
    }
  }

  // The dataset a future fine-tuning step would consume — see
  // `node src/index.js --export-dataset`.
  exportDataset({ minRating = 1, source = null, limit = 10000 } = {}) {
    const clauses = ['rating >= @minRating'];
    const params = { minRating, limit };
    if (source) {
      clauses.push('source = @source');
      params.source = source;
    }
    const sql = `SELECT * FROM interactions WHERE ${clauses.join(' AND ')} ORDER BY id ASC LIMIT @limit`;
    return this.db.prepare(sql).all(params).map(row => ({
      prompt: row.query,
      response: row.response,
      rating: row.rating,
      source: row.source,
      domain: row.domain,
      timestamp: row.created_at,
    }));
  }

  // --- Misc key/value metadata ---

  setMeta(key, value) {
    this._upsertMeta.run({ key, value: String(value) });
  }

  getMeta(key) {
    const row = this._selectMeta.get(key);
    return row ? row.value : null;
  }

  // --- Restore on boot ---

  // Rehydrate the living population: [{ genome, fitness }]
  loadPopulation() {
    return this._selectAlive.all().map(row => ({
      genome: Genome.fromJSON(JSON.parse(row.genome_json)),
      fitness: row.fitness,
    }));
  }

  // Rehydrate the full lineage tree (living + dead), in the shape
  // Lineage.fromJSON() expects.
  loadLineageEntries() {
    const rows = this._selectAll.all().map(row => ({
      instanceId: row.instance_id,
      parentIds: JSON.parse(row.parent_ids),
      childIds: [],
      generation: row.generation,
      alive: !!row.alive,
      fitness: row.fitness,
      birthTime: row.birth_time,
      deathTime: row.death_time,
      deathReason: row.death_reason,
      birthNode: row.birth_node,
      genomeHash: row.genome_hash,
    }));

    // Rebuild each parent's childIds list from the flat rows.
    for (const entry of rows) {
      entry.childIds = rows
        .filter(e => e.parentIds.includes(entry.instanceId))
        .map(e => e.instanceId);
    }

    return rows;
  }

  getLastGeneration() {
    const row = this._selectMaxGeneration.get();
    return row?.maxGen || 0;
  }

  // Most recent generations (oldest first), for a fitness-over-time view —
  // see GET /api/generations in src/integration/api.js.
  listGenerations(limit = 100) {
    return this._selectRecentGenerations.all(limit)
      .reverse()
      .map(row => ({
        generation: row.generation,
        seed: row.seed,
        recordedAt: row.recorded_at,
        ...JSON.parse(row.stats_json),
      }));
  }

  close() {
    this.db.close();
  }
}

// Turn free text into a safe FTS5 MATCH query: word tokens only (strips out
// anything that could be parsed as an FTS5 operator, like `"`, `*`, `:`, `-`),
// quoted individually and OR'd together, capped to a handful of terms.
function ftsQuery(text) {
  const words = String(text || '').toLowerCase().match(/[a-z0-9]+/g);
  if (!words || words.length === 0) return null;
  const terms = [...new Set(words)].slice(0, 8);
  return terms.map(w => `"${w}"`).join(' OR ');
}
