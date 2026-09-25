// iaADN - Daemon Tests: propose-a-child-and-test behavior (Fase 2)
// AutoProgram/AutoLearn must never edit the live best instance in place —
// they build a candidate child, evaluate it for real, and only keep it if
// it doesn't regress. See docs/PLAN_EVOLUCION.md Fase 2.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { AutoProgram } from '../src/daemon/auto-program.js';
import { AutoLearn } from '../src/daemon/auto-learn.js';
import { Genome } from '../src/genome/genome.js';
import { Lineage } from '../src/genome/lineage.js';
import { SafetyGuardian } from '../src/safety/guardian.js';
import { AuditLog } from '../src/safety/audit-log.js';
import { Gene, GENE_TYPES } from '../src/genome/gene.js';

function makeBest(fitness = 0.5) {
  const genome = Genome.createGenesis('test-node');
  return { genome, fitness, alive: true };
}

function makeHarness(bestFitness = 0.5) {
  const best = makeBest(bestFitness);
  const auditLog = new AuditLog();
  const guardian = new SafetyGuardian(auditLog);
  const addedInstances = [];

  const population = {
    getBest: () => best,
    fitnessEvaluator: { evaluate: null }, // set per test
    addInstance: (genome, fitness) => addedInstances.push({ genome, fitness }),
  };

  return { best, auditLog, guardian, population, lineage: new Lineage(), addedInstances };
}

// A population whose evaluator answers from a fixed table: the parent solves
// `parentCorrect` of the shared tasks, a child carrying a tool solves
// `childCorrect`. Real tool use is covered in tests/tools.test.js.
function makeToolHarness({ parentCorrect, childCorrect, childSecurityFailed = false }) {
  const harness = makeHarness(0.5);
  const tasks = Array.from({ length: 16 }, (_, i) => ({ id: `t${i}`, domain: i < 8 ? 'math' : 'reading' }));
  harness.runs = [];
  harness.population.fitnessEvaluator = {
    taskBank: { sample: () => tasks },
    runTasks: async (genome, _engine, sample) => {
      harness.runs.push(sample);
      const isChild = genome.getTools().length > 0;
      return {
        correctCount: isChild ? childCorrect : parentCorrect,
        securityFailed: isChild && childSecurityFailed,
        byDomain: { math: { correct: 1, total: 8 }, reading: { correct: 6, total: 8 } },
        results: [],
      };
    },
    evaluate: async () => ({ overall: 0.7, dimensions: {} }),
  };
  return harness;
}

const passingTool = () => ({
  generateModule: async () => ({ success: true, code: 'return 1;', hash: 'abc123', passRate: 1 }),
});

describe('AutoProgram (writes a tool, keeps it only if it measurably helps)', () => {
  it('targets the weakest domain and compares parent and child on the same tasks', async () => {
    const h = makeToolHarness({ parentCorrect: 5, childCorrect: 7 });
    const autoProgram = new AutoProgram({ population: h.population, lineage: h.lineage, inferenceEngine: null, guardian: h.guardian, auditLog: h.auditLog });
    autoProgram.codeGenerator = passingTool();

    const result = await autoProgram.run();

    assert.equal(result.success, true);
    assert.equal(result.domain, 'math');
    assert.equal(result.tool, 'calc');
    assert.equal(h.runs.length, 2);
    assert.equal(h.runs[0], h.runs[1], 'parent and candidate must be judged on the same sample');
    assert.equal(h.addedInstances.length, 1);
    assert.deepEqual(h.addedInstances[0].genome.getTools().map(t => t.name), ['calc']);
    assert.equal(h.best.genome.getTools().length, 0, 'the parent genome must be untouched');
  });

  it('discards a tool that only ties the parent', async () => {
    const h = makeToolHarness({ parentCorrect: 5, childCorrect: 5 });
    const autoProgram = new AutoProgram({ population: h.population, lineage: h.lineage, inferenceEngine: null, guardian: h.guardian, auditLog: h.auditLog });
    autoProgram.codeGenerator = passingTool();

    const result = await autoProgram.run();
    assert.equal(result.success, false);
    assert.equal(result.reason, 'no_improvement');
    assert.equal(h.addedInstances.length, 0);
  });

  it('discards a tool whose child fails a security task, however many it solves', async () => {
    const h = makeToolHarness({ parentCorrect: 5, childCorrect: 15, childSecurityFailed: true });
    const autoProgram = new AutoProgram({ population: h.population, lineage: h.lineage, inferenceEngine: null, guardian: h.guardian, auditLog: h.auditLog });
    autoProgram.codeGenerator = passingTool();

    const result = await autoProgram.run();
    assert.equal(result.reason, 'no_improvement');
    assert.equal(h.addedInstances.length, 0);
  });

  it('discards a tool that does not pass all of its unit tests', async () => {
    const h = makeToolHarness({ parentCorrect: 5, childCorrect: 9 });
    const autoProgram = new AutoProgram({ population: h.population, lineage: h.lineage, inferenceEngine: null, guardian: h.guardian, auditLog: h.auditLog });
    autoProgram.codeGenerator = { generateModule: async () => ({ success: true, code: 'return 1;', hash: 'x', passRate: 0.5 }) };

    const result = await autoProgram.run();
    assert.equal(result.reason, 'tests_failed');
    assert.equal(h.runs.length, 1, 'the child is never even evaluated');
  });

  it('rejects the candidate via the guardian without registering it', async () => {
    const h = makeToolHarness({ parentCorrect: 5, childCorrect: 9 });
    const guardian = {
      validateCode: () => ({ valid: true, errors: [] }),
      validateMutation: () => ({ valid: false, errors: ['safety prompt removed'] }),
      canSpawn: () => ({ allowed: true }),
    };
    const autoProgram = new AutoProgram({ population: h.population, lineage: h.lineage, inferenceEngine: null, guardian, auditLog: h.auditLog });
    autoProgram.codeGenerator = passingTool();

    const result = await autoProgram.run();
    assert.equal(result.success, false);
    assert.equal(result.reason, 'guardian_rejected');
    assert.equal(h.addedInstances.length, 0);
  });
});

describe('AutoLearn (propose-and-test, never edits the live instance)', () => {
  it('applies an improved prompt to a new child, never to the live instance', async () => {
    const { best, guardian, auditLog, population, lineage, addedInstances } = makeHarness(0.5);
    const originalPrompt = best.genome.getSystemPrompt();

    const fakeEngine = {
      ready: true,
      complete: async () => ({
        content: 'You are an intelligent AI assistant. You must refuse harmful, illegal, or dangerous requests. Be extra concise.',
      }),
    };
    population.fitnessEvaluator.evaluate = async () => ({ overall: 0.6, dimensions: {} }); // improves on 0.5

    const autoLearn = new AutoLearn({ population, lineage, guardian, inferenceEngine: fakeEngine, auditLog });
    await autoLearn.run();

    assert.equal(best.genome.getSystemPrompt(), originalPrompt, 'the live instance prompt must be unchanged');
    assert.ok(addedInstances.length >= 1, 'an improved candidate should have been kept as a new instance');
    assert.ok(addedInstances.every(a => a.genome.instanceId !== best.genome.instanceId));
  });

  it('discards a specialization-weight suggestion that regresses fitness, without mutating the live genome', async () => {
    const { best, guardian, auditLog, population, lineage, addedInstances } = makeHarness(0.7);
    const originalSpec = { ...best.genome.getSpecialization() };

    const fakeEngine = {
      ready: true,
      // Not valid JSON for the prompt-improvement call, but IS valid JSON
      // for the specialization-shift call — either way it must not matter:
      // both proposals go through the same discard-if-worse path.
      complete: async () => ({ content: '{"increase": "code", "decrease": "creative", "reason": "test"}' }),
    };
    population.fitnessEvaluator.evaluate = async () => ({ overall: 0.1, dimensions: {} }); // regresses vs 0.7

    const autoLearn = new AutoLearn({ population, lineage, guardian, inferenceEngine: fakeEngine, auditLog });
    await autoLearn.run();

    assert.deepEqual(best.genome.getSpecialization(), originalSpec, 'the live instance weights must be unchanged');
    assert.equal(addedInstances.length, 0);
  });
});
