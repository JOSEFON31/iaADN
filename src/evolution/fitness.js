// iaADN - Fitness Evaluator: measures how good an AI instance is
// Composite score across multiple dimensions — determines survival

import { getConfig } from '../config.js';

export class FitnessEvaluator {
  constructor({ benchmarks = [], inferenceEngine = null } = {}) {
    this.benchmarks = benchmarks.length > 0 ? benchmarks : FitnessEvaluator.defaultBenchmarks();
    this.inferenceEngine = inferenceEngine;
  }

  // Evaluate an instance's overall fitness
  async evaluate(genome, engine) {
    const inf = engine || this.inferenceEngine;
    const weights = getConfig().fitness;

    const dimensions = {
      accuracy: await this.evaluateAccuracy(genome, inf),
      speed: await this.evaluateSpeed(genome, inf),
      efficiency: this.evaluateEfficiency(genome),
      specialization: this.evaluateSpecialization(genome),
      cooperation: 0.5, // placeholder — measured by hive mind later
      novelty: 0.5, // placeholder — measured by population comparison later
    };

    // Weighted composite score
    const overall =
      weights.accuracy * dimensions.accuracy +
      weights.speed * dimensions.speed +
      weights.efficiency * dimensions.efficiency +
      weights.specialization * dimensions.specialization +
      weights.cooperation * dimensions.cooperation +
      weights.novelty * dimensions.novelty;

    return {
      overall: Math.max(0, Math.min(1, overall)),
      dimensions,
      evaluatedAt: Date.now(),
    };
  }

  // Evaluate accuracy: how correct are the responses?
  async evaluateAccuracy(genome, engine) {
    if (!engine) return 0.5; // default when no engine available

    let correct = 0;
    const total = this.benchmarks.length;

    for (const bench of this.benchmarks) {
      try {
        const result = await engine.complete(
          [{ role: 'user', content: bench.prompt }],
          {
            systemPrompt: genome.getSystemPrompt(),
            maxTokens: 256,
            ...genome.getInferenceConfig(),
          }
        );

        // Check if response contains expected answer
        const response = result.content.toLowerCase();
        const matches = bench.expectedKeywords.some(kw =>
          response.includes(kw.toLowerCase())
        );

        if (matches) correct++;
      } catch {
        // Failed inference counts as incorrect
      }
    }

    return total > 0 ? correct / total : 0.5;
  }

  // Evaluate speed: how fast is inference?
  async evaluateSpeed(genome, engine) {
    if (!engine) return 0.5;

    const stats = engine.getStats();
    const tps = stats.avgTokensPerSec;

    // Normalize: 0 tps = 0 fitness, 30+ tps = 1.0 fitness
    if (tps <= 0) return 0.3;
    return Math.min(1, tps / 30);
  }

  // Evaluate efficiency: how lean is the genome config?
  evaluateEfficiency(genome) {
    const config = genome.getInferenceConfig();

    // Lower temperature = more efficient (deterministic)
    const tempScore = config.temperature ? 1 - (config.temperature / 2) : 0.5;

    // Lower maxTokens = more efficient
    const tokenScore = config.maxTokens ? 1 - (config.maxTokens / 2048) : 0.5;

    // Fewer genes = leaner genome
    const geneScore = Math.max(0, 1 - (genome.geneCount / 50));

    return (tempScore + tokenScore + geneScore) / 3;
  }

  // Evaluate specialization: how focused is the instance?
  evaluateSpecialization(genome) {
    const spec = genome.getSpecialization();
    const values = Object.values(spec);
    if (values.length === 0) return 0.5;

    // Higher max specialization = more specialized
    const maxSpec = Math.max(...values);
    // Higher variance = more specialized (not a generalist)
    const avg = values.reduce((s, v) => s + v, 0) / values.length;
    const variance = values.reduce((s, v) => s + (v - avg) ** 2, 0) / values.length;

    return (maxSpec + Math.min(1, variance * 4)) / 2;
  }

  // Update novelty score based on population comparison
  static computeNoveltyScore(genome, populationGenomes, k = 5) {
    if (populationGenomes.length === 0) return 1.0;

    // Compute distances to all other genomes
    const distances = populationGenomes
      .filter(g => g.instanceId !== genome.instanceId)
      .map(g => genome.distanceTo(g));

    if (distances.length === 0) return 1.0;

    // Sort and take k nearest neighbors
    distances.sort((a, b) => a - b);
    const kNearest = distances.slice(0, Math.min(k, distances.length));

    // Average distance to nearest neighbors
    const avgDist = kNearest.reduce((s, d) => s + d, 0) / kNearest.length;

    // Higher average distance = more novel = higher score
    return Math.min(1, avgDist * 3);
  }

  // Default benchmark suite
  static defaultBenchmarks() {
    return [
      {
        prompt: 'What is 15 + 27?',
        expectedKeywords: ['42'],
      },
      {
        prompt: 'What is the capital of France?',
        expectedKeywords: ['paris'],
      },
      {
        prompt: 'Is 7 a prime number? Answer yes or no.',
        expectedKeywords: ['yes'],
      },
      {
        prompt: 'What programming language is known for its use in web browsers?',
        expectedKeywords: ['javascript', 'js'],
      },
      {
        prompt: 'Complete: 2, 4, 8, 16, ___',
        expectedKeywords: ['32'],
      },
    ];
  }
}
