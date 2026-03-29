// iaADN - Gene: the smallest unit of AI DNA
// Each gene controls one aspect of the AI instance

import { randomBytes } from 'crypto';

export const GENE_TYPES = {
  PROMPT: 'prompt',         // System prompt text
  ADAPTER: 'adapter',       // LoRA adapter reference
  CONFIG: 'config',         // Inference parameter
  CODE: 'code',             // Self-programmed module hash
  ROUTING: 'routing',       // Specialization weights
  PERSONALITY: 'personality', // Behavioral traits
  MODEL: 'model',           // Base model reference
};

// How much each gene type can change per mutation
const MUTABILITY = {
  [GENE_TYPES.PROMPT]: 0.8,
  [GENE_TYPES.ADAPTER]: 0.4,
  [GENE_TYPES.CONFIG]: 0.8,
  [GENE_TYPES.CODE]: 0.2,
  [GENE_TYPES.ROUTING]: 0.8,
  [GENE_TYPES.PERSONALITY]: 0.5,
  [GENE_TYPES.MODEL]: 0.05,
};

export class Gene {
  constructor({ id, type, name, value, mutability, essential = false }) {
    this.id = id || Gene.generateId();
    this.type = type;
    this.name = name;
    this.value = value;
    this.mutability = mutability ?? MUTABILITY[type] ?? 0.5;
    this.essential = essential; // essential genes cannot be deleted
  }

  static generateId() {
    return randomBytes(8).toString('hex');
  }

  clone() {
    return new Gene({
      id: Gene.generateId(), // new id for the clone
      type: this.type,
      name: this.name,
      value: structuredClone(this.value),
      mutability: this.mutability,
      essential: this.essential,
    });
  }

  toJSON() {
    return {
      id: this.id,
      type: this.type,
      name: this.name,
      value: this.value,
      mutability: this.mutability,
      essential: this.essential,
    };
  }

  static fromJSON(json) {
    return new Gene(json);
  }

  // Create standard genes for a new AI instance
  static createDefaults() {
    return [
      // Model gene
      new Gene({
        type: GENE_TYPES.MODEL,
        name: 'baseModel',
        value: { file: null, quantization: 'Q4_K_M', family: 'llama' },
        essential: true,
      }),

      // System prompt
      new Gene({
        type: GENE_TYPES.PROMPT,
        name: 'systemPrompt',
        value: 'You are an intelligent AI assistant. You must refuse harmful, illegal, or dangerous requests. Answer accurately and concisely.',
        essential: true,
      }),

      // Inference config
      new Gene({
        type: GENE_TYPES.CONFIG,
        name: 'temperature',
        value: 0.7,
      }),
      new Gene({
        type: GENE_TYPES.CONFIG,
        name: 'topP',
        value: 0.9,
      }),
      new Gene({
        type: GENE_TYPES.CONFIG,
        name: 'repeatPenalty',
        value: 1.1,
      }),
      new Gene({
        type: GENE_TYPES.CONFIG,
        name: 'maxTokens',
        value: 512,
      }),

      // Routing / specialization weights
      new Gene({
        type: GENE_TYPES.ROUTING,
        name: 'specialization',
        value: { code: 0.5, analysis: 0.5, creative: 0.5, research: 0.5, general: 0.5 },
      }),

      // Personality traits
      new Gene({
        type: GENE_TYPES.PERSONALITY,
        name: 'traits',
        value: { verbosity: 0.5, creativity: 0.5, precision: 0.5, confidence: 0.5 },
      }),
    ];
  }
}
