// iaADN - Persistence Tests
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { PersistenceStore } from '../src/persistence/store.js';
import { Lineage } from '../src/genome/lineage.js';
import { Genome } from '../src/genome/genome.js';

function withTempStore(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'iaadn-test-'));
  const dbPath = join(dir, 'test.db');
  const store = new PersistenceStore(dbPath);
  try {
    return fn(store, dbPath);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('PersistenceStore', () => {
  it('records births, deaths and fitness, and restores the living population', () => {
    withTempStore(store => {
      const genomeA = Genome.createGenesis('test-node');
      const genomeB = Genome.createGenesis('test-node');

      store.recordBirth(genomeA);
      store.recordBirth(genomeB);
      store.updateFitness(genomeA.instanceId, 0.72);
      store.recordFitnessDetail(genomeA.instanceId, {
        overall: 0.72,
        dimensions: { accuracy: 0.8 },
        evaluatedAt: Date.now(),
      });
      store.recordDeath(genomeB.instanceId, 'below_fitness_floor');
      store.recordGeneration(1, { populationSize: 1, avgFitness: 0.72, bestFitness: 0.72 }, 'seed123');

      const living = store.loadPopulation();
      assert.equal(living.length, 1);
      assert.equal(living[0].genome.instanceId, genomeA.instanceId);
      assert.equal(living[0].fitness, 0.72);

      const lineageEntries = store.loadLineageEntries();
      assert.equal(lineageEntries.length, 2);
      const deadEntry = lineageEntries.find(e => e.instanceId === genomeB.instanceId);
      assert.equal(deadEntry.alive, false);
      assert.equal(deadEntry.deathReason, 'below_fitness_floor');

      assert.equal(store.getLastGeneration(), 1);
    });
  });

  it('lists recorded generations oldest-first, honoring the limit', () => {
    withTempStore(store => {
      for (let g = 1; g <= 5; g++) {
        store.recordGeneration(g, { populationSize: g, avgFitness: g / 10, bestFitness: g / 5 }, 'seedX');
      }

      const all = store.listGenerations(100);
      assert.deepEqual(all.map(g => g.generation), [1, 2, 3, 4, 5]);
      assert.equal(all[0].avgFitness, 0.1);

      const limited = store.listGenerations(2);
      assert.deepEqual(limited.map(g => g.generation), [4, 5], 'the most recent N, still oldest-first');
    });
  });

  it('reopening an existing database file keeps previously recorded data', () => {
    const dir = mkdtempSync(join(tmpdir(), 'iaadn-test-'));
    const dbPath = join(dir, 'test.db');

    let store = new PersistenceStore(dbPath);
    const genome = Genome.createGenesis('test-node');
    store.recordBirth(genome);
    store.close();

    store = new PersistenceStore(dbPath);
    const living = store.loadPopulation();
    assert.equal(living.length, 1);
    assert.equal(living[0].genome.instanceId, genome.instanceId);
    store.close();

    rmSync(dir, { recursive: true, force: true });
  });

  it('rebuilds parent/child links across generations', () => {
    withTempStore(store => {
      const parent = Genome.createGenesis('test-node');
      const child = parent.replicate();

      store.recordBirth(parent);
      store.recordBirth(child);

      const entries = store.loadLineageEntries();
      const parentEntry = entries.find(e => e.instanceId === parent.instanceId);
      assert.deepEqual(parentEntry.childIds, [child.instanceId]);
    });
  });

  it('supports arbitrary metadata key/value storage', () => {
    withTempStore(store => {
      assert.equal(store.getMeta('rngSeed'), null);
      store.setMeta('rngSeed', 'abc123');
      assert.equal(store.getMeta('rngSeed'), 'abc123');
      store.setMeta('rngSeed', 'def456');
      assert.equal(store.getMeta('rngSeed'), 'def456');
    });
  });
});

describe('PersistenceStore interactions/memory/dataset (Fase 3)', () => {
  it('records an interaction and returns its id', () => {
    withTempStore(store => {
      const id = store.recordInteraction({ query: 'hi', response: 'hello', source: 'chat' });
      assert.equal(typeof id, 'number');
      assert.ok(id > 0);
    });
  });

  it('rateInteraction updates the rating and reports whether the row existed', () => {
    withTempStore(store => {
      const id = store.recordInteraction({ query: 'q', response: 'a' });
      assert.equal(store.rateInteraction(id, 1), true);
      assert.equal(store.rateInteraction(999999, 1), false);
    });
  });

  it('searchMemory only surfaces interactions rated 1 or higher', () => {
    withTempStore(store => {
      store.recordInteraction({ query: 'capital of France', response: 'Paris', rating: 1 });
      store.recordInteraction({ query: 'capital of Germany', response: 'Berlin' }); // unrated
      store.recordInteraction({ query: 'capital of Spain', response: 'wrong', rating: -1 });

      const results = store.searchMemory('capital');
      assert.equal(results.length, 1);
      assert.equal(results[0].response, 'Paris');
    });
  });

  it('a later negative rating removes an interaction from memory', () => {
    withTempStore(store => {
      const id = store.recordInteraction({ query: 'capital of France', response: 'Paris', rating: 1 });
      assert.equal(store.searchMemory('capital').length, 1);
      store.rateInteraction(id, -1);
      assert.equal(store.searchMemory('capital').length, 0);
    });
  });

  it('searchMemory tolerates queries with no usable words or no matches', () => {
    withTempStore(store => {
      store.recordInteraction({ query: 'capital of France', response: 'Paris', rating: 1 });
      assert.deepEqual(store.searchMemory('###'), []);
      assert.deepEqual(store.searchMemory(''), []);
      assert.deepEqual(store.searchMemory('quantum entanglement'), []);
    });
  });

  it('exportDataset filters by minRating and source', () => {
    withTempStore(store => {
      store.recordInteraction({ query: 'q1', response: 'a1', rating: 1, source: 'chat' });
      store.recordInteraction({ query: 'q2', response: 'a2', rating: -1, source: 'task', domain: 'math' });
      store.recordInteraction({ query: 'q3', response: 'a3', source: 'chat' }); // unrated, null

      const positive = store.exportDataset({ minRating: 1 });
      assert.deepEqual(positive.map(r => r.prompt), ['q1']);

      const all = store.exportDataset({ minRating: -1 });
      assert.equal(all.length, 2, 'unrated (null) rows are excluded, both rated ones included');

      const tasksOnly = store.exportDataset({ minRating: -1, source: 'task' });
      assert.deepEqual(tasksOnly.map(r => r.prompt), ['q2']);
      assert.equal(tasksOnly[0].domain, 'math');
    });
  });

  it('opening a database created before source/domain existed still works (migration)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'iaadn-test-'));
    const dbPath = join(dir, 'test.db');

    // Simulate an old database: create the table without the new columns.
    const OldDatabase = (await import('better-sqlite3')).default;
    const oldDb = new OldDatabase(dbPath);
    oldDb.exec(`
      CREATE TABLE interactions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        query TEXT NOT NULL,
        response TEXT,
        instance_id TEXT,
        rating INTEGER,
        created_at INTEGER NOT NULL
      );
    `);
    oldDb.close();

    const store = new PersistenceStore(dbPath);
    const id = store.recordInteraction({ query: 'q', response: 'a', rating: 1, source: 'chat', domain: null });
    assert.ok(id > 0);
    assert.equal(store.exportDataset({ minRating: 1 })[0].source, 'chat');
    store.close();

    rmSync(dir, { recursive: true, force: true });
  });
});

describe('Lineage + PersistenceStore integration', () => {
  it('mirrors births, deaths and fitness updates automatically', () => {
    withTempStore(store => {
      const lineage = new Lineage({ persistence: store });
      const genome = Genome.createGenesis('test-node');

      lineage.recordBirth(genome);
      lineage.updateFitness(genome.instanceId, 0.55);
      lineage.recordDeath(genome.instanceId, 'carrying_capacity');

      const living = store.loadPopulation();
      assert.equal(living.length, 0, 'instance should no longer be alive in the store');

      const entries = store.loadLineageEntries();
      assert.equal(entries.length, 1);
      assert.equal(entries[0].fitness, 0.55);
      assert.equal(entries[0].deathReason, 'carrying_capacity');
    });
  });
});
