// iaADN - Crossover Engine: combines two parent genomes to create a child
// Like sexual reproduction — the child inherits traits from both parents

import { Genome } from '../genome/genome.js';

export class CrossoverEngine {
  constructor() {}

  // Combine two parent genomes into a child
  crossover(parentA, parentB, strategy = 'uniform') {
    switch (strategy) {
      case 'singlePoint':
        return this.singlePointCrossover(parentA, parentB);
      case 'uniform':
        return this.uniformCrossover(parentA, parentB);
      case 'geneLevel':
        return this.geneLevelCrossover(parentA, parentB);
      default:
        return this.uniformCrossover(parentA, parentB);
    }
  }

  // Single-point crossover: pick a split point, take left from A, right from B
  singlePointCrossover(parentA, parentB) {
    const child = new Genome({
      parentIds: [parentA.instanceId, parentB.instanceId],
      generation: Math.max(parentA.generation, parentB.generation) + 1,
      chromosomes: {},
      birthNode: parentA.birthNode,
    });

    const chromKeys = Object.keys(parentA.chromosomes);
    const splitIdx = Math.floor(Math.random() * chromKeys.length);

    for (let i = 0; i < chromKeys.length; i++) {
      const key = chromKeys[i];
      const source = i < splitIdx ? parentA : parentB;
      if (source.chromosomes[key]) {
        child.chromosomes[key] = source.chromosomes[key].clone();
      }
    }

    // Fill missing chromosomes from the other parent
    for (const key of Object.keys(parentB.chromosomes)) {
      if (!child.chromosomes[key]) {
        child.chromosomes[key] = parentB.chromosomes[key].clone();
      }
    }

    return child;
  }

  // Uniform crossover: for each gene, randomly pick from parent A or B
  uniformCrossover(parentA, parentB, swapProbability = 0.5) {
    const child = new Genome({
      parentIds: [parentA.instanceId, parentB.instanceId],
      generation: Math.max(parentA.generation, parentB.generation) + 1,
      chromosomes: {},
      birthNode: parentA.birthNode,
    });

    const allChromKeys = new Set([
      ...Object.keys(parentA.chromosomes),
      ...Object.keys(parentB.chromosomes),
    ]);

    for (const key of allChromKeys) {
      const chromA = parentA.chromosomes[key];
      const chromB = parentB.chromosomes[key];

      if (!chromA) {
        child.chromosomes[key] = chromB.clone();
        continue;
      }
      if (!chromB) {
        child.chromosomes[key] = chromA.clone();
        continue;
      }

      // Clone from A as base
      const childChrom = chromA.clone();

      // For each gene, possibly swap with B's version
      for (let i = 0; i < childChrom.genes.length; i++) {
        const geneName = childChrom.genes[i].name;
        const geneB = chromB.getGene(geneName);

        if (geneB && Math.random() < swapProbability) {
          childChrom.genes[i] = geneB.clone();
        }
      }

      // Add any genes from B that A doesn't have
      for (const geneB of chromB.genes) {
        if (!childChrom.getGene(geneB.name)) {
          childChrom.addGene(geneB.clone());
        }
      }

      child.chromosomes[key] = childChrom;
    }

    return child;
  }

  // Gene-level crossover: for each gene, pick the version from the fitter parent
  // (requires fitness info, falls back to random if not available)
  geneLevelCrossover(parentA, parentB, fitnessA = null, fitnessB = null) {
    const child = new Genome({
      parentIds: [parentA.instanceId, parentB.instanceId],
      generation: Math.max(parentA.generation, parentB.generation) + 1,
      chromosomes: {},
      birthNode: parentA.birthNode,
    });

    // If we have fitness scores, prefer genes from the fitter parent
    const preferA = fitnessA != null && fitnessB != null
      ? fitnessA / (fitnessA + fitnessB)
      : 0.5;

    const allChromKeys = new Set([
      ...Object.keys(parentA.chromosomes),
      ...Object.keys(parentB.chromosomes),
    ]);

    for (const key of allChromKeys) {
      const chromA = parentA.chromosomes[key];
      const chromB = parentB.chromosomes[key];

      if (!chromA) {
        child.chromosomes[key] = chromB.clone();
        continue;
      }
      if (!chromB) {
        child.chromosomes[key] = chromA.clone();
        continue;
      }

      const childChrom = chromA.clone();

      for (let i = 0; i < childChrom.genes.length; i++) {
        const geneName = childChrom.genes[i].name;
        const geneB = chromB.getGene(geneName);

        if (geneB && Math.random() > preferA) {
          childChrom.genes[i] = geneB.clone();
        }
      }

      child.chromosomes[key] = childChrom;
    }

    return child;
  }
}
