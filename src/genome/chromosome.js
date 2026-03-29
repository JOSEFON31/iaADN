// iaADN - Chromosome: a grouped collection of related genes
// Organizes genes by functional area

import { Gene, GENE_TYPES } from './gene.js';

export const CHROMOSOME_TYPES = {
  INFERENCE: 'inference',       // model, config, adapters
  PERSONALITY: 'personality',   // prompts, personality traits
  SPECIALIZATION: 'specialization', // routing, code modules
  META: 'meta',                 // mutation rate, crossover preference (meta-evolution)
};

export class Chromosome {
  constructor({ name, type, genes = [] }) {
    this.name = name;
    this.type = type;
    this.genes = genes;
  }

  addGene(gene) {
    this.genes.push(gene);
  }

  removeGene(geneId) {
    const idx = this.genes.findIndex(g => g.id === geneId);
    if (idx === -1) return false;
    if (this.genes[idx].essential) return false; // cannot remove essential genes
    this.genes.splice(idx, 1);
    return true;
  }

  getGene(name) {
    return this.genes.find(g => g.name === name) || null;
  }

  getGenesByType(type) {
    return this.genes.filter(g => g.type === type);
  }

  clone() {
    return new Chromosome({
      name: this.name,
      type: this.type,
      genes: this.genes.map(g => g.clone()),
    });
  }

  get size() {
    return this.genes.length;
  }

  toJSON() {
    return {
      name: this.name,
      type: this.type,
      genes: this.genes.map(g => g.toJSON()),
    };
  }

  static fromJSON(json) {
    return new Chromosome({
      name: json.name,
      type: json.type,
      genes: json.genes.map(g => Gene.fromJSON(g)),
    });
  }

  // Create the standard set of chromosomes for a new AI instance
  static createDefaults() {
    const defaults = Gene.createDefaults();

    const inference = new Chromosome({
      name: 'InferenceChromosome',
      type: CHROMOSOME_TYPES.INFERENCE,
    });
    const personality = new Chromosome({
      name: 'PersonalityChromosome',
      type: CHROMOSOME_TYPES.PERSONALITY,
    });
    const specialization = new Chromosome({
      name: 'SpecializationChromosome',
      type: CHROMOSOME_TYPES.SPECIALIZATION,
    });
    const meta = new Chromosome({
      name: 'MetaChromosome',
      type: CHROMOSOME_TYPES.META,
    });

    // Distribute default genes into chromosomes
    for (const gene of defaults) {
      switch (gene.type) {
        case GENE_TYPES.MODEL:
        case GENE_TYPES.CONFIG:
        case GENE_TYPES.ADAPTER:
          inference.addGene(gene);
          break;
        case GENE_TYPES.PROMPT:
        case GENE_TYPES.PERSONALITY:
          personality.addGene(gene);
          break;
        case GENE_TYPES.ROUTING:
        case GENE_TYPES.CODE:
          specialization.addGene(gene);
          break;
      }
    }

    // Meta-chromosome: controls evolution itself (meta-evolution)
    meta.addGene(new Gene({
      type: GENE_TYPES.CONFIG,
      name: 'mutationRate',
      value: 0.15,
      essential: true,
    }));
    meta.addGene(new Gene({
      type: GENE_TYPES.CONFIG,
      name: 'crossoverPreference',
      value: 'uniform', // 'singlePoint' | 'uniform' | 'geneLevel'
    }));
    meta.addGene(new Gene({
      type: GENE_TYPES.CONFIG,
      name: 'explorationBias',
      value: 0.3, // 0=exploit, 1=explore
    }));

    return { inference, personality, specialization, meta };
  }
}
