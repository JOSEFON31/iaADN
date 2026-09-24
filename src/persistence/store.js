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
      INSERT INTO interactions (query, response, instance_id, rating, created_at)
      VALUES (@query, @response, @instanceId, @rating, @createdAt)
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

  // --- Chat/hive interactions (used from Fase 5 onward) ---

  recordInteraction({ query, response, instanceId = null, rating = null }) {
    this._insertInteraction.run({ query, response, instanceId, rating, createdAt: Date.now() });
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
