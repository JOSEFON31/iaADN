// iaADN - Auto Program: autonomous self-programming cycle
// The AI analyzes its own weaknesses and writes code to improve
// NO HUMAN INTERVENTION NEEDED

import { CodeGenerator } from '../selfprog/code-generator.js';
import { RollbackManager } from '../selfprog/rollback.js';

export class AutoProgram {
  constructor({ population, inferenceEngine, guardian, auditLog }) {
    this.population = population;
    this.inferenceEngine = inferenceEngine;
    this.guardian = guardian;
    this.auditLog = auditLog;
    this.codeGenerator = new CodeGenerator({ inferenceEngine, auditLog });
    this.rollbackManager = new RollbackManager();
  }

  // Run one autonomous self-programming cycle
  async run() {
    const best = this.population.getBest();
    if (!best) {
      console.log('[AutoProgram] No instances to program');
      return { skipped: true };
    }

    console.log(`[AutoProgram] Analyzing instance ${best.genome.instanceId}...`);

    // 1. Identify weakest fitness dimension
    const weakness = this._identifyWeakness(best);
    if (!weakness) {
      console.log('[AutoProgram] No clear weakness found, skipping');
      return { skipped: true, reason: 'no_weakness' };
    }

    console.log(`[AutoProgram] Weakness identified: ${weakness.dimension} (${weakness.score})`);

    // 2. Create snapshot before modification
    const snapshotId = this.rollbackManager.createSnapshot(best.genome.instanceId, best.genome);

    // 3. Generate improvement code
    const spec = this._generateSpec(weakness);
    const testCases = this._generateTestCases(weakness);

    const result = await this.codeGenerator.generateModule(spec, testCases);

    if (!result.success) {
      console.log(`[AutoProgram] Code generation failed: ${result.reason}`);
      return { success: false, reason: result.reason };
    }

    // 4. Validate code with guardian
    const validation = this.guardian.validateCode(result.code);
    if (!validation.valid) {
      console.log(`[AutoProgram] Code rejected by guardian: ${validation.errors.join(', ')}`);
      return { success: false, reason: 'guardian_rejected', errors: validation.errors };
    }

    // 5. Add code gene to genome
    best.genome.chromosomes.specialization.addGene(result.gene);

    console.log(`[AutoProgram] New module integrated: ${result.hash} (pass rate: ${result.passRate})`);

    this.auditLog.logSelfProgram(best.genome.instanceId, 'module_integrated', {
      hash: result.hash,
      weakness: weakness.dimension,
      snapshotId,
    });

    // 6. Prune old snapshots
    this.rollbackManager.prune(best.genome.instanceId, 10);

    return {
      success: true,
      instanceId: best.genome.instanceId,
      module: result.hash,
      weakness: weakness.dimension,
      snapshotId,
    };
  }

  // Identify the weakest fitness dimension
  _identifyWeakness(instance) {
    if (!instance.fitness) return null;

    // Use last known fitness evaluation from audit log
    const recent = this.auditLog.getRecent(20);
    const fitnessEntry = recent
      .filter(e => e.event === 'fitness' && e.data.instanceId === instance.genome.instanceId)
      .pop();

    if (!fitnessEntry?.data?.dimensions) {
      // No detailed fitness data, target a random dimension
      const dims = ['accuracy', 'speed', 'efficiency', 'specialization'];
      return { dimension: dims[Math.floor(Math.random() * dims.length)], score: 0.5 };
    }

    const dims = fitnessEntry.data.dimensions;
    let worstDim = null;
    let worstScore = Infinity;

    for (const [dim, score] of Object.entries(dims)) {
      if (score < worstScore) {
        worstScore = score;
        worstDim = dim;
      }
    }

    return { dimension: worstDim, score: worstScore };
  }

  // Generate a specification for code to improve the weakness
  _generateSpec(weakness) {
    const specs = {
      accuracy: 'a text processing function that extracts key facts from a text. It should receive text as input and return an array of key facts as strings.',
      speed: 'a caching function that stores computed results. It should receive a key and an optional value. If value is provided, store it. If not, return the cached value or null.',
      efficiency: 'a function that compresses a JSON object by removing null/undefined values and shortening keys. Input is an object, output is the compressed version.',
      specialization: 'a pattern matching function that categorizes text into domains (code, math, science, creative, general). Input is text, output is the category string.',
      cooperation: 'a task scoring function that rates how well a task matches specialization weights. Input is {task, weights}, output is a score 0-1.',
    };

    return specs[weakness.dimension] || specs.accuracy;
  }

  // Generate test cases for the improvement
  _generateTestCases(weakness) {
    const tests = {
      accuracy: [
        { input: 'The capital of France is Paris. It has a population of 2 million.', expected: ['capital of France is Paris', 'population of 2 million'] },
      ],
      speed: [
        { input: { key: 'test', value: 42 }, expected: undefined },
      ],
      efficiency: [
        { input: { a: 1, b: null, c: 'hello', d: undefined }, expected: { a: 1, c: 'hello' } },
      ],
      specialization: [
        { input: 'function fibonacci(n) { return n <= 1 ? n : fibonacci(n-1) + fibonacci(n-2); }', expected: 'code' },
      ],
      cooperation: [
        { input: { task: 'code', weights: { code: 0.9, creative: 0.1 } }, expected: 0.9 },
      ],
    };

    return tests[weakness.dimension] || [];
  }
}
