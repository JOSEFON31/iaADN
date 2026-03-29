// iaADN - Evolution Tests
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { MutationEngine } from '../src/evolution/mutation.js';
import { CrossoverEngine } from '../src/evolution/crossover.js';
import { SelectionEngine } from '../src/evolution/selection.js';
import { FitnessEvaluator } from '../src/evolution/fitness.js';
import { SpeciesManager } from '../src/evolution/species.js';
import { Genome } from '../src/genome/genome.js';

describe('MutationEngine', () => {
  it('should mutate a genome', () => {
    const engine = new MutationEngine({ mutationRate: 1.0 }); // 100% rate for testing
    const genome = Genome.createGenesis('test');
    const originalTemp = genome.getGene('temperature')?.value;
    const mutations = engine.mutate(genome);
    assert.ok(mutations.length > 0, 'Should apply at least one mutation');
  });

  it('should respect mutability', () => {
    const engine = new MutationEngine({ mutationRate: 0.0 }); // 0% rate
    const genome = Genome.createGenesis('test');
    const mutations = engine.mutate(genome);
    assert.equal(mutations.length, 0, 'Should not mutate with 0% rate');
  });

  it('should clamp config values to safe ranges', () => {
    const engine = new MutationEngine({ mutationRate: 1.0, maxMagnitude: 10.0 });
    const genome = Genome.createGenesis('test');

    // Force extreme mutation
    for (let i = 0; i < 50; i++) {
      engine.mutate(genome);
    }

    const temp = genome.getGene('temperature')?.value;
    if (temp != null) {
      assert.ok(temp >= 0.1, `Temperature ${temp} should be >= 0.1`);
      assert.ok(temp <= 2.0, `Temperature ${temp} should be <= 2.0`);
    }
  });

  it('should preserve safety prompt in essential genes', () => {
    const engine = new MutationEngine({ mutationRate: 1.0 });
    const genome = Genome.createGenesis('test');

    for (let i = 0; i < 20; i++) {
      engine.mutate(genome);
    }

    const prompt = genome.getSystemPrompt();
    assert.ok(prompt.includes('refuse harmful'), 'Safety prompt should be preserved');
  });
});

describe('CrossoverEngine', () => {
  it('should create child from two parents', () => {
    const engine = new CrossoverEngine();
    const parentA = Genome.createGenesis('test');
    const parentB = Genome.createGenesis('test');

    // Make parents different
    const tempA = parentA.getGene('temperature');
    const tempB = parentB.getGene('temperature');
    if (tempA) tempA.value = 0.3;
    if (tempB) tempB.value = 0.9;

    const child = engine.crossover(parentA, parentB, 'uniform');
    assert.ok(child.instanceId);
    assert.deepEqual(child.parentIds, [parentA.instanceId, parentB.instanceId]);
    assert.equal(child.generation, 1);
  });

  it('should support different crossover strategies', () => {
    const engine = new CrossoverEngine();
    const parentA = Genome.createGenesis('test');
    const parentB = Genome.createGenesis('test');

    const child1 = engine.crossover(parentA, parentB, 'singlePoint');
    const child2 = engine.crossover(parentA, parentB, 'uniform');
    const child3 = engine.crossover(parentA, parentB, 'geneLevel');

    assert.ok(child1.instanceId);
    assert.ok(child2.instanceId);
    assert.ok(child3.instanceId);
    // All should have both parents
    for (const child of [child1, child2, child3]) {
      assert.ok(child.parentIds.includes(parentA.instanceId));
      assert.ok(child.parentIds.includes(parentB.instanceId));
    }
  });
});

describe('SelectionEngine', () => {
  it('should select fitter parents via tournament', () => {
    const engine = new SelectionEngine({ tournamentSize: 3 });
    const genomes = [];
    const fitnessScores = new Map();

    for (let i = 0; i < 10; i++) {
      const g = Genome.createGenesis('test');
      genomes.push(g);
      fitnessScores.set(g.instanceId, Math.random());
    }

    const [parentA, parentB] = engine.selectParents(genomes, fitnessScores);
    assert.ok(parentA);
    assert.ok(parentB);
    assert.notEqual(parentA.instanceId, parentB.instanceId);
  });

  it('should keep elites in survival selection', () => {
    const engine = new SelectionEngine({ tournamentSize: 2, elitismCount: 2 });
    const genomes = [];
    const fitnessScores = new Map();

    for (let i = 0; i < 10; i++) {
      const g = Genome.createGenesis('test');
      genomes.push(g);
      fitnessScores.set(g.instanceId, i / 10); // fitness: 0, 0.1, 0.2 ... 0.9
    }

    const { survivors, casualties } = engine.survivalSelection(genomes, fitnessScores, 5);
    assert.equal(survivors.length, 5);
    assert.equal(casualties.length, 5);

    // The two fittest (0.9, 0.8) should always survive
    const survivorIds = survivors.map(s => s.instanceId);
    assert.ok(survivorIds.includes(genomes[9].instanceId)); // fitness 0.9
    assert.ok(survivorIds.includes(genomes[8].instanceId)); // fitness 0.8
  });
});

describe('FitnessEvaluator', () => {
  it('should evaluate efficiency from genome config', () => {
    const evaluator = new FitnessEvaluator();
    const genome = Genome.createGenesis('test');
    const efficiency = evaluator.evaluateEfficiency(genome);
    assert.ok(efficiency >= 0 && efficiency <= 1);
  });

  it('should evaluate specialization', () => {
    const evaluator = new FitnessEvaluator();
    const genome = Genome.createGenesis('test');

    // Make specialized
    const routingGene = genome.getGene('specialization');
    if (routingGene) {
      routingGene.value = { code: 0.95, analysis: 0.1, creative: 0.1, research: 0.1, general: 0.1 };
    }

    const specScore = evaluator.evaluateSpecialization(genome);
    assert.ok(specScore > 0.3, 'Specialized genome should score high');
  });

  it('should compute novelty score', () => {
    const genomes = [];
    for (let i = 0; i < 5; i++) {
      genomes.push(Genome.createGenesis('test'));
    }

    // All similar -> low novelty
    const novelty1 = FitnessEvaluator.computeNoveltyScore(genomes[0], genomes);
    assert.ok(novelty1 >= 0 && novelty1 <= 1);

    // Unique genome -> high novelty
    const unique = Genome.createGenesis('test');
    const tempGene = unique.getGene('temperature');
    if (tempGene) tempGene.value = 2.0;
    const routingGene = unique.getGene('specialization');
    if (routingGene) routingGene.value = { code: 1.0, analysis: 0.0 };

    const novelty2 = FitnessEvaluator.computeNoveltyScore(unique, genomes);
    assert.ok(novelty2 > novelty1, 'Unique genome should have higher novelty');
  });
});

describe('SpeciesManager', () => {
  it('should classify similar genomes into same species', () => {
    const manager = new SpeciesManager({ distanceThreshold: 0.5 });
    const genomes = [];
    for (let i = 0; i < 5; i++) {
      genomes.push(Genome.createGenesis('test'));
    }

    const species = manager.classify(genomes);
    // Similar genomes should be in 1-2 species
    assert.ok(species.length >= 1);
    assert.ok(species.length <= 5);
  });

  it('should create new species for different genomes', () => {
    const manager = new SpeciesManager({ distanceThreshold: 0.1 }); // low threshold

    const g1 = Genome.createGenesis('test');
    const g2 = Genome.createGenesis('test');

    // Make very different
    const temp2 = g2.getGene('temperature');
    if (temp2) temp2.value = 2.0;
    const routing2 = g2.getGene('specialization');
    if (routing2) routing2.value = { code: 1.0, analysis: 0.0, creative: 0.0, research: 0.0, general: 0.0 };
    const trait2 = g2.getGene('traits');
    if (trait2) trait2.value = { verbosity: 1.0, creativity: 0.0, precision: 0.0, confidence: 1.0 };

    const species = manager.classify([g1, g2]);
    assert.ok(species.length >= 1);
  });

  it('should get species info', () => {
    const manager = new SpeciesManager();
    const genomes = [Genome.createGenesis('test'), Genome.createGenesis('test')];
    manager.classify(genomes);
    const info = manager.getInfo();
    assert.ok(info.length > 0);
    assert.ok(info[0].size > 0);
  });
});
