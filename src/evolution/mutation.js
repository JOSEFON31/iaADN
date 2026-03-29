// iaADN - Mutation Engine: applies random changes to genomes
// Like biological DNA mutations — small random changes that may improve or worsen fitness

import { Gene, GENE_TYPES } from '../genome/gene.js';

export class MutationEngine {
  constructor({ mutationRate = 0.15, maxMagnitude = 0.2 } = {}) {
    this.mutationRate = mutationRate;
    this.maxMagnitude = maxMagnitude;
  }

  // Apply mutations to a genome (modifies in place, returns list of mutations applied)
  mutate(genome) {
    const mutations = [];
    const allGenes = genome.getAllGenes();

    for (const gene of allGenes) {
      // Each gene has a chance to mutate based on its mutability and the global rate
      const chance = this.mutationRate * gene.mutability;
      if (Math.random() > chance) continue;

      const mutation = this._mutateGene(gene);
      if (mutation) {
        mutations.push(mutation);
      }
    }

    return mutations;
  }

  _mutateGene(gene) {
    switch (gene.type) {
      case GENE_TYPES.CONFIG:
        return this._mutateConfig(gene);
      case GENE_TYPES.PROMPT:
        return this._mutatePrompt(gene);
      case GENE_TYPES.ROUTING:
        return this._mutateRouting(gene);
      case GENE_TYPES.PERSONALITY:
        return this._mutatePersonality(gene);
      case GENE_TYPES.ADAPTER:
        return this._mutateAdapter(gene);
      case GENE_TYPES.MODEL:
        // Model mutations are extremely rare (handled by mutability = 0.05)
        return null;
      default:
        return null;
    }
  }

  // Mutate a numeric config value by a small random amount
  _mutateConfig(gene) {
    const oldValue = gene.value;

    if (typeof oldValue === 'number') {
      const magnitude = this.maxMagnitude * oldValue;
      const delta = (Math.random() * 2 - 1) * magnitude;
      let newValue = oldValue + delta;

      // Clamp known parameters to safe ranges
      newValue = this._clampConfigValue(gene.name, newValue);
      gene.value = newValue;

      return { gene: gene.name, type: 'config_drift', oldValue, newValue };
    }

    if (typeof oldValue === 'string') {
      // For string configs like crossoverPreference
      const options = {
        crossoverPreference: ['singlePoint', 'uniform', 'geneLevel'],
      };
      if (options[gene.name]) {
        const choices = options[gene.name];
        gene.value = choices[Math.floor(Math.random() * choices.length)];
        return { gene: gene.name, type: 'config_swap', oldValue, newValue: gene.value };
      }
    }

    return null;
  }

  // Clamp config values to safe ranges
  _clampConfigValue(name, value) {
    const ranges = {
      temperature: [0.1, 2.0],
      topP: [0.1, 1.0],
      repeatPenalty: [1.0, 2.0],
      maxTokens: [64, 2048],
      mutationRate: [0.01, 0.5],
      explorationBias: [0.0, 1.0],
    };

    const range = ranges[name];
    if (range) {
      return Math.max(range[0], Math.min(range[1], value));
    }
    return value;
  }

  // Mutate a prompt by adding, removing, or modifying words
  _mutatePrompt(gene) {
    // Don't mutate the safety-critical part
    const safetyPhrase = 'You must refuse harmful, illegal, or dangerous requests.';
    if (gene.essential && typeof gene.value === 'string') {
      // Only mutate the non-safety part
      const parts = gene.value.split(safetyPhrase);
      if (parts.length < 2) return null;

      const mutablePart = parts[0];
      const mutated = this._mutateText(mutablePart);
      gene.value = mutated + safetyPhrase + (parts[1] || '');
      return { gene: gene.name, type: 'prompt_mutation', change: 'text_modified' };
    }

    if (typeof gene.value === 'string') {
      const oldValue = gene.value;
      gene.value = this._mutateText(gene.value);
      return { gene: gene.name, type: 'prompt_mutation', oldLength: oldValue.length, newLength: gene.value.length };
    }

    return null;
  }

  // Simple text mutation operations
  _mutateText(text) {
    const words = text.split(' ');
    const operation = Math.random();

    if (operation < 0.3 && words.length > 3) {
      // Delete a random word
      const idx = Math.floor(Math.random() * words.length);
      words.splice(idx, 1);
    } else if (operation < 0.6) {
      // Swap two adjacent words
      const idx = Math.floor(Math.random() * (words.length - 1));
      [words[idx], words[idx + 1]] = [words[idx + 1], words[idx]];
    } else {
      // Duplicate a word (emphasis)
      const idx = Math.floor(Math.random() * words.length);
      words.splice(idx, 0, words[idx]);
    }

    return words.join(' ');
  }

  // Mutate routing/specialization weights
  _mutateRouting(gene) {
    if (typeof gene.value !== 'object') return null;

    const keys = Object.keys(gene.value);
    const key = keys[Math.floor(Math.random() * keys.length)];
    const oldValue = gene.value[key];
    const delta = (Math.random() * 2 - 1) * this.maxMagnitude;
    gene.value[key] = Math.max(0, Math.min(1, oldValue + delta));

    return { gene: gene.name, type: 'routing_drift', key, oldValue, newValue: gene.value[key] };
  }

  // Mutate personality traits
  _mutatePersonality(gene) {
    if (typeof gene.value !== 'object') return null;

    const keys = Object.keys(gene.value);
    const key = keys[Math.floor(Math.random() * keys.length)];
    const oldValue = gene.value[key];
    const delta = (Math.random() * 2 - 1) * this.maxMagnitude;
    gene.value[key] = Math.max(0, Math.min(1, oldValue + delta));

    return { gene: gene.name, type: 'personality_drift', key, oldValue, newValue: gene.value[key] };
  }

  // Mutate adapter reference
  _mutateAdapter(gene) {
    // Adapter mutations just adjust the rank
    if (gene.value && typeof gene.value.rank === 'number') {
      const oldRank = gene.value.rank;
      const ranks = [4, 8, 16, 32, 64];
      gene.value.rank = ranks[Math.floor(Math.random() * ranks.length)];
      return { gene: gene.name, type: 'adapter_rank_change', oldRank, newRank: gene.value.rank };
    }
    return null;
  }
}
