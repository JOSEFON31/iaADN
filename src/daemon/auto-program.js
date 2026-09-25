// iaADN - Auto Program: the instance writes itself a tool, and keeps it only
// if it measurably helps.
//
// 1. Run the best instance on a sample of train tasks; find its weakest domain.
// 2. Ask the local model to write a tool for that domain; it must pass the
//    spec's unit tests in the sandbox.
// 3. Build a child with the tool (the parent is never touched) and run it on
//    the *same* tasks. Tools are really used while solving tasks (see
//    FitnessEvaluator.answerTask), so this measures the tool's effect, not
//    sampling noise. Kept only if it solves strictly more of them
//    (selfprog.minImprovement) without failing a security task.

import { CodeGenerator } from '../selfprog/code-generator.js';
import { MAX_TOOLS } from '../selfprog/tools.js';
import { GenomeCodec } from '../genome/codec.js';
import { Gene, GENE_TYPES } from '../genome/gene.js';
import { getConfig } from '../config.js';
import { rng } from '../util/rng.js';

// One tool idea per task domain, with unit tests the generated code must pass
export const TOOL_SPECS = {
  math: {
    name: 'calc',
    description: 'evaluates an arithmetic expression string (numbers, + - * / % **, parentheses) and returns the number',
    spec: 'a function that receives `input`, a string with an arithmetic expression using numbers, + - * / % ** and parentheses, and returns its numeric value, respecting standard operator precedence. Do not use eval or Function; write a small parser.',
    tests: [
      { input: '3 + 4 * 5', expected: 23 },
      { input: '(10 - 4) / 2', expected: 3 },
      { input: '2 ** 10', expected: 1024 },
      { input: '17 % 5', expected: 2 },
    ],
  },
  extraction: {
    name: 'find_numbers',
    description: 'returns every number in a text as an array of numbers',
    spec: 'a function that receives `input`, a string, and returns an array with every number that appears in it (integers or decimals, in order), as numbers. Ignore commas used as thousands separators.',
    tests: [
      { input: 'order #4471 total $128.50', expected: [4471, 128.5] },
      { input: 'Maria is 34 and Juan is 7', expected: [34, 7] },
      { input: 'no numbers here', expected: [] },
    ],
  },
  reading: {
    name: 'find_sentence',
    description: 'input {text, keyword}; returns the first sentence of text containing keyword (case-insensitive), or null',
    spec: 'a function that receives `input`, an object {text, keyword}, splits text into sentences on . ! or ?, and returns the first sentence (trimmed, without the final punctuation) that contains keyword case-insensitively, or null if none does.',
    tests: [
      { input: { text: 'The sky is blue. Grass is green.', keyword: 'grass' }, expected: 'Grass is green' },
      { input: { text: 'One. Two!', keyword: 'three' }, expected: null },
    ],
  },
  code: {
    name: 'array_stats',
    description: 'input an array of numbers; returns {min, max, sum, count}',
    spec: 'a function that receives `input`, an array of numbers, and returns an object {min, max, sum, count}. For an empty array return {min: null, max: null, sum: 0, count: 0}.',
    tests: [
      { input: [3, 1, 2], expected: { min: 1, max: 3, sum: 6, count: 3 } },
      { input: [], expected: { min: null, max: null, sum: 0, count: 0 } },
    ],
  },
  general: {
    name: 'word_count',
    description: 'returns the number of words in a text',
    spec: 'a function that receives `input`, a string, and returns how many words it has (sequences of non-space characters).',
    tests: [
      { input: 'one two  three', expected: 3 },
      { input: '', expected: 0 },
    ],
  },
};

export class AutoProgram {
  constructor({ population, lineage, inferenceEngine, guardian, auditLog }) {
    this.population = population;
    this.lineage = lineage;
    this.inferenceEngine = inferenceEngine;
    this.guardian = guardian;
    this.auditLog = auditLog;
    this.codeGenerator = new CodeGenerator({ inferenceEngine, auditLog });
  }

  async run() {
    const best = this.population.getBest();
    if (!best) {
      console.log('[AutoProgram] No instances to program');
      return { skipped: true };
    }

    const cfg = getConfig().selfprog;
    const evaluator = this.population.fitnessEvaluator;
    const tasks = evaluator.taskBank.sample({ rng, count: cfg.evalSampleSize, securityCount: 2 });

    // 1. Parent baseline on the shared sample
    const parentRun = await evaluator.runTasks(best.genome, this.inferenceEngine, tasks);
    const domain = this._weakestDomain(parentRun.byDomain);
    const toolSpec = TOOL_SPECS[domain] || TOOL_SPECS.general;
    console.log(`[AutoProgram] ${best.genome.instanceId}: weakest domain ${domain}, writing tool ${toolSpec.name}`);

    // 2. Generate the tool; it must pass every unit test
    const generated = await this.codeGenerator.generateModule(toolSpec.spec, toolSpec.tests);
    if (!generated.success) {
      return this._reject(best, domain, 'generation_failed', { detail: generated.reason });
    }
    if (generated.passRate < 1) {
      return this._reject(best, domain, 'tests_failed', { passRate: generated.passRate });
    }

    const validation = this.guardian.validateCode(generated.code);
    if (!validation.valid) {
      return this._reject(best, domain, 'guardian_rejected', { errors: validation.errors });
    }

    // 3. Candidate child carrying the tool — the parent is never touched
    const child = best.genome.replicate();
    this._installTool(child, toolSpec, generated, domain);

    const mutationCheck = this.guardian.validateMutation(best.genome, child);
    if (!mutationCheck.valid) {
      return this._reject(best, domain, 'guardian_rejected', { errors: mutationCheck.errors });
    }

    // 4. Paired comparison on the same tasks
    const childRun = await evaluator.runTasks(child, this.inferenceEngine, tasks);
    const metrics = {
      parentCorrect: parentRun.correctCount,
      candidateCorrect: childRun.correctCount,
      total: tasks.length,
      toolCalls: (childRun.results || []).reduce((n, r) => n + (r.toolCalls || 0), 0),
    };

    if (childRun.securityFailed || childRun.correctCount < parentRun.correctCount + cfg.minImprovement) {
      console.log(`[AutoProgram] Tool ${toolSpec.name} did not help (${metrics.candidateCorrect} vs ${metrics.parentCorrect}/${metrics.total}), discarding`);
      return this._reject(best, domain, 'no_improvement', { ...metrics, hash: generated.hash });
    }

    const spawnCheck = this.guardian.canSpawn();
    if (!spawnCheck.allowed) {
      return this._reject(best, domain, 'spawn_blocked', { detail: spawnCheck.reason });
    }

    // 5. It helped — register the child with a normal full evaluation
    const evaluation = await evaluator.evaluate(child, this.inferenceEngine);
    this.population.addInstance(child, evaluation.overall);
    this.lineage.recordBirth(child);
    this.guardian.resourceLimits?.registerInstance();
    this.auditLog.logBirth(child);
    GenomeCodec.saveToFile(child);

    this.auditLog.logSelfProgram(child.instanceId, 'tool_integrated', {
      parentId: best.genome.instanceId,
      tool: toolSpec.name,
      domain,
      hash: generated.hash,
      ...metrics,
    });
    console.log(`[AutoProgram] New instance ${child.instanceId} with tool ${toolSpec.name} (${metrics.candidateCorrect} vs ${metrics.parentCorrect}/${metrics.total})`);

    return {
      success: true,
      parentId: best.genome.instanceId,
      instanceId: child.instanceId,
      tool: toolSpec.name,
      domain,
      module: generated.hash,
      candidateFitness: evaluation.overall,
      ...metrics,
    };
  }

  // Lowest pass rate among non-security domains (security is a hard gate,
  // not something a tool should target); ties broken by the seeded RNG.
  _weakestDomain(byDomain = {}) {
    const entries = Object.entries(byDomain).filter(([d, s]) => d !== 'security' && s.total > 0);
    if (entries.length === 0) return rng.pick(Object.keys(TOOL_SPECS));
    const rate = ([, s]) => s.correct / s.total;
    const worst = Math.min(...entries.map(rate));
    return rng.pick(entries.filter(e => rate(e) === worst).map(([d]) => d));
  }

  // Add the tool as a CODE gene, replacing one with the same name, and
  // dropping the oldest tool if the instance already has the maximum.
  _installTool(genome, toolSpec, generated, domain) {
    const chrom = genome.chromosomes.specialization;
    const codeGenes = () => chrom.getGenesByType(GENE_TYPES.CODE);
    for (const gene of codeGenes()) {
      if ((gene.value?.name || gene.name) === toolSpec.name) chrom.removeGene(gene.id);
    }
    while (codeGenes().length >= MAX_TOOLS) chrom.removeGene(codeGenes()[0].id);

    chrom.addGene(new Gene({
      type: GENE_TYPES.CODE,
      name: `tool_${toolSpec.name}`,
      value: {
        name: toolSpec.name,
        description: toolSpec.description,
        code: generated.code,
        domain,
        hash: generated.hash,
      },
    }));
  }

  _reject(best, domain, reason, data = {}) {
    this.auditLog.log('selfprog_rejected', { parentId: best.genome.instanceId, domain, reason, ...data });
    return { success: false, reason, domain, ...data };
  }
}
