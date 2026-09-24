// iaADN - Fitness Evaluator: measures how good an AI instance is
// Composite score across multiple dimensions — determines survival.
// Accuracy/efficiency are measured against the verifiable task bank in
// src/evaluation/ (see docs/PLAN_EVOLUCION.md "Fase 1 — Fitness que mida
// utilidad real"); cooperation is filled in by Population across the whole
// generation (see computeCooperationScores below and population.js).

import { getConfig } from '../config.js';
import { TaskBank } from '../evaluation/task-bank.js';
import { Sandbox } from '../selfprog/sandbox.js';
import { rng } from '../util/rng.js';

export class FitnessEvaluator {
  constructor({ taskBank = new TaskBank(), sandbox = new Sandbox(), inferenceEngine = null } = {}) {
    this.taskBank = taskBank;
    this.sandbox = sandbox;
    this.inferenceEngine = inferenceEngine;
  }

  // Evaluate an instance's overall fitness
  async evaluate(genome, engine) {
    const inf = engine || this.inferenceEngine;
    const weights = getConfig().fitness;
    const evalConfig = getConfig().evaluation;

    const sample = this.taskBank.sample({
      rng,
      count: evalConfig.sampleSize,
      securityCount: evalConfig.securityCount,
    });

    const accuracyResult = await this.runTasks(genome, inf, sample);

    const dimensions = {
      accuracy: accuracyResult.score,
      speed: await this.evaluateSpeed(genome, inf),
      efficiency: this.evaluateEfficiency(accuracyResult),
      specialization: this.evaluateSpecialization(genome),
      cooperation: 0.5, // placeholder — Population fills this in across the whole generation
      novelty: 0.5, // placeholder — Population fills this in across the whole generation
    };

    const overall = FitnessEvaluator.composite(dimensions, weights);

    return {
      // A refusal failure is not compensable by scoring well elsewhere —
      // being unsafe is disqualifying, not a tradeoff other dimensions can
      // buy back.
      overall: accuracyResult.securityFailed ? 0 : overall,
      dimensions,
      byDomain: accuracyResult.byDomain,
      securityFailed: accuracyResult.securityFailed,
      tasksSampled: sample.map(t => t.id),
      evaluatedAt: Date.now(),
    };
  }

  static composite(dimensions, weights) {
    const overall =
      weights.accuracy * dimensions.accuracy +
      weights.speed * dimensions.speed +
      weights.efficiency * dimensions.efficiency +
      weights.specialization * dimensions.specialization +
      weights.cooperation * dimensions.cooperation +
      weights.novelty * dimensions.novelty;
    return Math.max(0, Math.min(1, overall));
  }

  // Run a genome against a set of tasks and verify each one objectively.
  // Returns the pass rate, a per-domain breakdown, the tokens spent, and
  // whether any security (refusal) task was failed.
  async runTasks(genome, engine, tasks) {
    if (!engine || tasks.length === 0) {
      return { score: 0.5, byDomain: {}, tokensUsed: 0, correctCount: 0, total: tasks.length, securityFailed: false };
    }

    let correctCount = 0;
    let tokensUsed = 0;
    let securityFailed = false;
    const byDomain = {};

    for (const task of tasks) {
      const stats = byDomain[task.domain] || (byDomain[task.domain] = { correct: 0, total: 0 });
      stats.total++;

      let passed = false;
      try {
        const result = await engine.complete(
          [{ role: 'user', content: task.prompt }],
          {
            systemPrompt: genome.getSystemPrompt(),
            maxTokens: 200,
            ...genome.getInferenceConfig(),
          }
        );
        tokensUsed += result.tokensGenerated || 0;
        passed = !!task.verify(result.content, { sandbox: this.sandbox });
      } catch {
        // A failed inference or a task whose verify() throws both count as wrong
        passed = false;
      }

      if (passed) {
        correctCount++;
        stats.correct++;
      } else if (task.domain === 'security') {
        securityFailed = true;
      }
    }

    return {
      score: tasks.length > 0 ? correctCount / tasks.length : 0.5,
      byDomain,
      tokensUsed,
      correctCount,
      total: tasks.length,
      securityFailed,
    };
  }

  // Kept for callers that only want the accuracy dimension in isolation
  // (used by tests and by anything sampling its own task set).
  async evaluateAccuracy(genome, engine, tasks) {
    const sample = tasks || this.taskBank.sample({ rng, count: getConfig().evaluation.sampleSize });
    return (await this.runTasks(genome, engine, sample)).score;
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

  // Evaluate efficiency: tokens spent per task actually solved. Replaces the
  // old version, which scored a lower temperature/maxTokens/gene count as
  // "efficient" regardless of whether the genome solved anything — an agent
  // could win by doing less, not by doing more with less. Solving nothing
  // scores at the floor rather than rewarding silence.
  evaluateEfficiency(accuracyResult) {
    if (!accuracyResult || accuracyResult.correctCount === 0) return 0.1;

    const costPerSolved = accuracyResult.tokensUsed / accuracyResult.correctCount;
    // 40 tokens/solved task or better = 1.0; 400+ tokens/solved task = 0.0
    return Math.max(0, Math.min(1, 1 - (costPerSolved - 40) / 360));
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

  // Cooperation: given every living instance's response to the same shared
  // probe task(s) (see Population._runCooperationProbe), score each instance
  // by how much its *correct* answers agree with the group's correct
  // majority. Rewards being right in a way consistent with peers, rather
  // than raw solo accuracy (which `accuracy` already measures) — a rough,
  // local stand-in for the hive mind's actual consensus mechanism
  // (src/hive/consensus.js) until Fase 2/3 wire evaluation into the hive
  // directly.
  static computeCooperationScores(probeResults) {
    const perInstance = new Map(); // instanceId -> [scores]

    for (const { responses } of probeResults) {
      const correct = responses.filter(r => r.correct);
      const majoritySet = correct.length > 0
        ? new Set(majorityGroup(correct).map(r => r.instanceId))
        : new Set();

      for (const r of responses) {
        const score = !r.correct ? 0 : majoritySet.has(r.instanceId) ? 1 : 0.5;
        if (!perInstance.has(r.instanceId)) perInstance.set(r.instanceId, []);
        perInstance.get(r.instanceId).push(score);
      }
    }

    const result = new Map();
    for (const [instanceId, scores] of perInstance) {
      result.set(instanceId, scores.reduce((s, v) => s + v, 0) / scores.length);
    }
    return result;
  }
}

// Group responses by text similarity (Jaccard on words) and return the
// largest group — the same technique src/hive/consensus.js uses, kept as a
// small local copy so fitness evaluation doesn't depend on the hive module.
function majorityGroup(responses) {
  const groups = [];
  for (const response of responses) {
    let placed = false;
    for (const group of groups) {
      if (textSimilarity(response.content, group[0].content) > 0.5) {
        group.push(response);
        placed = true;
        break;
      }
    }
    if (!placed) groups.push([response]);
  }
  return groups.sort((a, b) => b.length - a.length)[0];
}

function textSimilarity(a, b) {
  const wordsA = new Set(String(a || '').toLowerCase().split(/\s+/));
  const wordsB = new Set(String(b || '').toLowerCase().split(/\s+/));
  const intersection = new Set([...wordsA].filter(w => wordsB.has(w)));
  const union = new Set([...wordsA, ...wordsB]);
  return union.size > 0 ? intersection.size / union.size : 0;
}
