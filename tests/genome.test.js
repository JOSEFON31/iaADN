// iaADN - Genome Tests
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Gene, GENE_TYPES } from '../src/genome/gene.js';
import { Chromosome, CHROMOSOME_TYPES } from '../src/genome/chromosome.js';
import { Genome } from '../src/genome/genome.js';
import { GenomeCodec } from '../src/genome/codec.js';
import { Lineage } from '../src/genome/lineage.js';

describe('Gene', () => {
  it('should create a gene with default values', () => {
    const gene = new Gene({
      type: GENE_TYPES.CONFIG,
      name: 'temperature',
      value: 0.7,
    });
    assert.ok(gene.id);
    assert.equal(gene.type, 'config');
    assert.equal(gene.name, 'temperature');
    assert.equal(gene.value, 0.7);
    assert.equal(gene.essential, false);
  });

  it('should clone a gene with new id', () => {
    const gene = new Gene({
      type: GENE_TYPES.PROMPT,
      name: 'systemPrompt',
      value: 'Hello world',
      essential: true,
    });
    const clone = gene.clone();
    assert.notEqual(clone.id, gene.id);
    assert.equal(clone.type, gene.type);
    assert.equal(clone.name, gene.name);
    assert.equal(clone.value, gene.value);
    assert.equal(clone.essential, gene.essential);
  });

  it('should serialize and deserialize', () => {
    const gene = new Gene({
      type: GENE_TYPES.ROUTING,
      name: 'specialization',
      value: { code: 0.8, creative: 0.3 },
    });
    const json = gene.toJSON();
    const restored = Gene.fromJSON(json);
    assert.equal(restored.name, gene.name);
    assert.deepEqual(restored.value, gene.value);
  });

  it('should create default genes', () => {
    const defaults = Gene.createDefaults();
    assert.ok(defaults.length >= 8);
    const modelGene = defaults.find(g => g.type === GENE_TYPES.MODEL);
    assert.ok(modelGene);
    assert.equal(modelGene.essential, true);
  });
});

describe('Chromosome', () => {
  it('should add and retrieve genes', () => {
    const chrom = new Chromosome({
      name: 'TestChrom',
      type: CHROMOSOME_TYPES.INFERENCE,
    });
    const gene = new Gene({
      type: GENE_TYPES.CONFIG,
      name: 'temperature',
      value: 0.7,
    });
    chrom.addGene(gene);
    assert.equal(chrom.size, 1);
    assert.equal(chrom.getGene('temperature').value, 0.7);
  });

  it('should not remove essential genes', () => {
    const chrom = new Chromosome({
      name: 'TestChrom',
      type: CHROMOSOME_TYPES.INFERENCE,
    });
    const gene = new Gene({
      type: GENE_TYPES.MODEL,
      name: 'baseModel',
      value: 'test',
      essential: true,
    });
    chrom.addGene(gene);
    const removed = chrom.removeGene(gene.id);
    assert.equal(removed, false);
    assert.equal(chrom.size, 1);
  });

  it('should create default chromosomes', () => {
    const defaults = Chromosome.createDefaults();
    assert.ok(defaults.inference);
    assert.ok(defaults.personality);
    assert.ok(defaults.specialization);
    assert.ok(defaults.meta);
    assert.ok(defaults.inference.size > 0);
    assert.ok(defaults.meta.getGene('mutationRate'));
  });

  it('should clone with new gene ids', () => {
    const defaults = Chromosome.createDefaults();
    const clone = defaults.inference.clone();
    assert.equal(clone.size, defaults.inference.size);
    // Gene ids should differ
    const origIds = defaults.inference.genes.map(g => g.id);
    const cloneIds = clone.genes.map(g => g.id);
    for (const id of cloneIds) {
      assert.ok(!origIds.includes(id));
    }
  });
});

describe('Genome', () => {
  it('should create a genesis genome', () => {
    const genome = Genome.createGenesis('test-node');
    assert.ok(genome.instanceId.startsWith('iaADN_'));
    assert.deepEqual(genome.parentIds, []);
    assert.equal(genome.generation, 0);
    assert.equal(genome.birthNode, 'test-node');
    assert.ok(genome.chromosomes.inference);
    assert.ok(genome.chromosomes.personality);
    assert.ok(genome.chromosomes.specialization);
    assert.ok(genome.chromosomes.meta);
  });

  it('should replicate with new id and incremented generation', () => {
    const parent = Genome.createGenesis('test-node');
    const child = parent.replicate();
    assert.notEqual(child.instanceId, parent.instanceId);
    assert.deepEqual(child.parentIds, [parent.instanceId]);
    assert.equal(child.generation, 1);
  });

  it('should get inference config from genes', () => {
    const genome = Genome.createGenesis('test-node');
    const config = genome.getInferenceConfig();
    assert.ok('temperature' in config);
    assert.ok('topP' in config);
    assert.ok('model' in config);
  });

  it('should get system prompt', () => {
    const genome = Genome.createGenesis('test-node');
    const prompt = genome.getSystemPrompt();
    assert.ok(prompt.includes('refuse harmful'));
  });

  it('should compute hash', () => {
    const genome = Genome.createGenesis('test-node');
    const hash = genome.hash();
    assert.equal(hash.length, 16);
    // Same genome should produce same hash
    assert.equal(genome.hash(), hash);
  });

  it('should compute distance between genomes', () => {
    const a = Genome.createGenesis('test-node');
    const b = Genome.createGenesis('test-node');

    // Same defaults should have distance ~0
    const distSame = a.distanceTo(a);
    assert.equal(distSame, 0);

    // Different instances with same defaults should have small distance
    const distSimilar = a.distanceTo(b);
    assert.ok(distSimilar >= 0);

    // Modify b to be different
    const tempGene = b.getGene('temperature');
    if (tempGene) tempGene.value = 2.0;
    const distDifferent = a.distanceTo(b);
    assert.ok(distDifferent > 0);
  });

  it('should serialize and deserialize', () => {
    const genome = Genome.createGenesis('test-node');
    const json = genome.toJSON();
    const restored = Genome.fromJSON(json);
    assert.equal(restored.instanceId, genome.instanceId);
    assert.equal(restored.generation, genome.generation);
    assert.equal(restored.geneCount, genome.geneCount);
    assert.equal(restored.getSystemPrompt(), genome.getSystemPrompt());
  });
});

describe('GenomeCodec', () => {
  it('should encode and decode DAG metadata', () => {
    const genome = Genome.createGenesis('test-node');
    const metadata = GenomeCodec.toDAGMetadata(genome);
    assert.equal(metadata._iaADN, 'genome');
    assert.equal(metadata.instanceId, genome.instanceId);

    const decoded = GenomeCodec.fromDAGMetadata(metadata);
    assert.equal(decoded.instanceId, genome.instanceId);
    assert.equal(decoded.geneCount, genome.geneCount);
  });

  it('should create birth record', () => {
    const genome = Genome.createGenesis('test-node');
    const record = GenomeCodec.createBirthRecord(genome, 0.75);
    assert.equal(record._iaADN, 'birth');
    assert.equal(record.fitnessScore, 0.75);
  });

  it('should create death record', () => {
    const record = GenomeCodec.createDeathRecord('instance_123', 'low_fitness', 0.1);
    assert.equal(record._iaADN, 'death');
    assert.equal(record.instanceId, 'instance_123');
    assert.equal(record.reason, 'low_fitness');
  });

  it('should create evolution record', () => {
    const record = GenomeCodec.createEvolutionRecord(5, {
      populationSize: 10,
      avgFitness: 0.65,
      bestFitness: 0.92,
      births: 3,
      deaths: 2,
      speciesCount: 2,
    });
    assert.equal(record._iaADN, 'evolution');
    assert.equal(record.generation, 5);
  });
});

describe('Lineage', () => {
  it('should track births', () => {
    const lineage = new Lineage();
    const genome = Genome.createGenesis('test-node');
    lineage.recordBirth(genome);
    assert.equal(lineage.getLiving().length, 1);
  });

  it('should track deaths', () => {
    const lineage = new Lineage();
    const genome = Genome.createGenesis('test-node');
    lineage.recordBirth(genome);
    lineage.recordDeath(genome.instanceId, 'low_fitness');
    assert.equal(lineage.getLiving().length, 0);
  });

  it('should track parent-child relationships', () => {
    const lineage = new Lineage();
    const parent = Genome.createGenesis('test-node');
    lineage.recordBirth(parent);

    const child = parent.replicate();
    lineage.recordBirth(child);

    const descendants = lineage.getDescendants(parent.instanceId);
    assert.equal(descendants.length, 1);
    assert.equal(descendants[0].instanceId, child.instanceId);
  });

  it('should compute stats', () => {
    const lineage = new Lineage();
    const g1 = Genome.createGenesis('test-node');
    const g2 = Genome.createGenesis('test-node');
    lineage.recordBirth(g1);
    lineage.recordBirth(g2);
    lineage.updateFitness(g1.instanceId, 0.8);
    lineage.updateFitness(g2.instanceId, 0.6);

    const stats = lineage.getStats();
    assert.equal(stats.living, 2);
    assert.equal(stats.dead, 0);
    assert.equal(stats.avgFitness, 0.7);
    assert.equal(stats.bestFitness, 0.8);
  });

  it('should find ancestors', () => {
    const lineage = new Lineage();
    const grandparent = Genome.createGenesis('test-node');
    lineage.recordBirth(grandparent);

    const parent = grandparent.replicate();
    lineage.recordBirth(parent);

    const child = parent.replicate();
    lineage.recordBirth(child);

    const ancestors = lineage.getAncestors(child.instanceId);
    assert.equal(ancestors.length, 2);
  });

  it('should serialize and deserialize', () => {
    const lineage = new Lineage();
    const g = Genome.createGenesis('test-node');
    lineage.recordBirth(g);

    const json = lineage.toJSON();
    const restored = Lineage.fromJSON(json);
    assert.equal(restored.getLiving().length, 1);
  });
});
