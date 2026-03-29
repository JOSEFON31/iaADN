// iaADN - Genome: the complete DNA of an AI instance
// Contains all chromosomes, tracks lineage, provides serialization

import { randomBytes, createHash } from 'crypto';
import { Chromosome } from './chromosome.js';
import { GENE_TYPES } from './gene.js';

export class Genome {
  constructor({
    instanceId,
    parentIds = [],
    generation = 0,
    chromosomes = {},
    createdAt = Date.now(),
    birthNode = null,
  }) {
    this.instanceId = instanceId || Genome.generateInstanceId();
    this.parentIds = parentIds;
    this.generation = generation;
    this.chromosomes = chromosomes;
    this.createdAt = createdAt;
    this.birthNode = birthNode;
  }

  static generateInstanceId() {
    return 'iaADN_' + randomBytes(12).toString('hex');
  }

  // Create a brand new genome with default genes
  static createGenesis(nodeId) {
    const chroms = Chromosome.createDefaults();
    return new Genome({
      parentIds: [],
      generation: 0,
      chromosomes: chroms,
      birthNode: nodeId,
    });
  }

  // Deep clone with new instanceId (for replication)
  replicate() {
    const cloned = new Genome({
      instanceId: Genome.generateInstanceId(),
      parentIds: [this.instanceId],
      generation: this.generation + 1,
      chromosomes: {},
      birthNode: this.birthNode,
    });

    for (const [key, chrom] of Object.entries(this.chromosomes)) {
      cloned.chromosomes[key] = chrom.clone();
    }

    return cloned;
  }

  // Get all genes across all chromosomes
  getAllGenes() {
    const genes = [];
    for (const chrom of Object.values(this.chromosomes)) {
      genes.push(...chrom.genes);
    }
    return genes;
  }

  // Get genes of a specific type across all chromosomes
  getGenesByType(type) {
    const genes = [];
    for (const chrom of Object.values(this.chromosomes)) {
      genes.push(...chrom.getGenesByType(type));
    }
    return genes;
  }

  // Get a specific gene by name (searches all chromosomes)
  getGene(name) {
    for (const chrom of Object.values(this.chromosomes)) {
      const gene = chrom.getGene(name);
      if (gene) return gene;
    }
    return null;
  }

  // Get inference configuration from genes
  getInferenceConfig() {
    const config = {};
    const inferenceChrom = this.chromosomes.inference;
    if (!inferenceChrom) return config;

    for (const gene of inferenceChrom.genes) {
      if (gene.type === GENE_TYPES.CONFIG) {
        config[gene.name] = gene.value;
      } else if (gene.type === GENE_TYPES.MODEL) {
        config.model = gene.value;
      }
    }
    return config;
  }

  // Get the system prompt assembled from all prompt genes
  getSystemPrompt() {
    const promptGenes = this.getGenesByType(GENE_TYPES.PROMPT);
    return promptGenes.map(g => g.value).join('\n\n');
  }

  // Get specialization weights
  getSpecialization() {
    const routingGene = this.getGene('specialization');
    return routingGene ? routingGene.value : { general: 1.0 };
  }

  // Compute a fingerprint hash of the entire genome
  hash() {
    const data = JSON.stringify(this._hashData());
    return createHash('sha256').update(data).digest('hex').slice(0, 16);
  }

  // Internal data for hashing (avoids toJSON recursion)
  _hashData() {
    const chroms = {};
    for (const [key, chrom] of Object.entries(this.chromosomes)) {
      chroms[key] = chrom.toJSON();
    }
    return {
      instanceId: this.instanceId,
      parentIds: this.parentIds,
      generation: this.generation,
      chromosomes: chroms,
      createdAt: this.createdAt,
    };
  }

  // Count total genes
  get geneCount() {
    return this.getAllGenes().length;
  }

  // Compute genetic distance to another genome (0 = identical, 1 = completely different)
  distanceTo(other) {
    const myGenes = this.getAllGenes();
    const otherGenes = other.getAllGenes();

    let totalDiff = 0;
    let comparisons = 0;

    // Compare genes with matching names
    for (const myGene of myGenes) {
      const otherGene = other.getGene(myGene.name);
      if (!otherGene) {
        totalDiff += 1;
        comparisons++;
        continue;
      }

      totalDiff += geneDistance(myGene, otherGene);
      comparisons++;
    }

    // Count genes in other that we don't have
    for (const otherGene of otherGenes) {
      if (!this.getGene(otherGene.name)) {
        totalDiff += 1;
        comparisons++;
      }
    }

    return comparisons > 0 ? totalDiff / comparisons : 0;
  }

  toJSON() {
    const chroms = {};
    for (const [key, chrom] of Object.entries(this.chromosomes)) {
      chroms[key] = chrom.toJSON();
    }
    return {
      instanceId: this.instanceId,
      parentIds: this.parentIds,
      generation: this.generation,
      chromosomes: chroms,
      createdAt: this.createdAt,
      birthNode: this.birthNode,
      hash: this.hash(),
    };
  }

  static fromJSON(json) {
    const chroms = {};
    for (const [key, chromData] of Object.entries(json.chromosomes)) {
      chroms[key] = Chromosome.fromJSON(chromData);
    }
    return new Genome({
      instanceId: json.instanceId,
      parentIds: json.parentIds,
      generation: json.generation,
      chromosomes: chroms,
      createdAt: json.createdAt,
      birthNode: json.birthNode,
    });
  }
}

// Compute distance between two individual genes
function geneDistance(geneA, geneB) {
  if (geneA.type !== geneB.type) return 1;

  const a = geneA.value;
  const b = geneB.value;

  if (typeof a === 'number' && typeof b === 'number') {
    // Normalized numeric distance
    const max = Math.max(Math.abs(a), Math.abs(b), 1);
    return Math.abs(a - b) / max;
  }

  if (typeof a === 'string' && typeof b === 'string') {
    // Simple string similarity (Jaccard on words)
    const wordsA = new Set(a.toLowerCase().split(/\s+/));
    const wordsB = new Set(b.toLowerCase().split(/\s+/));
    const intersection = new Set([...wordsA].filter(w => wordsB.has(w)));
    const union = new Set([...wordsA, ...wordsB]);
    return union.size > 0 ? 1 - (intersection.size / union.size) : 0;
  }

  if (typeof a === 'object' && typeof b === 'object') {
    // Average distance across object keys
    const allKeys = new Set([...Object.keys(a), ...Object.keys(b)]);
    let sum = 0;
    for (const key of allKeys) {
      if (!(key in a) || !(key in b)) {
        sum += 1;
      } else if (typeof a[key] === 'number' && typeof b[key] === 'number') {
        const max = Math.max(Math.abs(a[key]), Math.abs(b[key]), 1);
        sum += Math.abs(a[key] - b[key]) / max;
      } else if (a[key] !== b[key]) {
        sum += 1;
      }
    }
    return allKeys.size > 0 ? sum / allKeys.size : 0;
  }

  return a === b ? 0 : 1;
}
