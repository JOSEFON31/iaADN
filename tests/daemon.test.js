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

describe('AutoProgram (propose-and-test, never edits the live instance)', () => {
  it('discards a candidate that scores worse than the parent, leaving the parent untouched', async () => {
    const { best, guardian, auditLog, population, lineage, addedInstances } = makeHarness(0.6);
    const originalGeneCount = best.genome.geneCount;

    const autoProgram = new AutoProgram({ population, lineage, inferenceEngine: null, guardian, auditLog });
    autoProgram.codeGenerator = {
      generateModule: async () => ({
        success: true,
        gene: new Gene({ type: GENE_TYPES.CODE, name: 'test_module', value: 'return 1;' }),
        code: 'return 1;',
        hash: 'abc123',
        passRate: 1,
      }),
    };
    population.fitnessEvaluator.evaluate = async () => ({ overall: 0.3, dimensions: {} }); // worse than 0.6

    const result = await autoProgram.run();

    assert.equal(result.success, false);
    assert.equal(result.reason, 'no_improvement');
    assert.equal(addedInstances.length, 0, 'no new instance should be registered');
    assert.equal(best.genome.geneCount, originalGeneCount, 'the parent genome must be untouched');
  });

  it('registers the candidate as a new instance when it does not regress', async () => {
    const { best, guardian, auditLog, population, lineage, addedInstances } = makeHarness(0.4);

    const autoProgram = new AutoProgram({ population, lineage, inferenceEngine: null, guardian, auditLog });
    autoProgram.codeGenerator = {
      generateModule: async () => ({
        success: true,
        gene: new Gene({ type: GENE_TYPES.CODE, name: 'test_module', value: 'return 1;' }),
        code: 'return 1;',
        hash: 'abc123',
        passRate: 1,
      }),
    };
    population.fitnessEvaluator.evaluate = async () => ({ overall: 0.55, dimensions: {} }); // better than 0.4

    const result = await autoProgram.run();

    assert.equal(result.success, true);
    assert.equal(addedInstances.length, 1);
    assert.equal(addedInstances[0].fitness, 0.55);
    assert.notEqual(addedInstances[0].genome.instanceId, best.genome.instanceId, 'a new child, not the parent');
  });

  it('rejects the candidate via the guardian without registering it', async () => {
    const { auditLog, population, lineage, addedInstances } = makeHarness(0.4);
    const guardian = {
      validateCode: () => ({ valid: true, errors: [] }),
      validateMutation: () => ({ valid: false, errors: ['safety prompt removed'] }),
      canSpawn: () => ({ allowed: true }),
    };

    const autoProgram = new AutoProgram({ population, lineage, inferenceEngine: null, guardian, auditLog });
    autoProgram.codeGenerator = {
      generateModule: async () => ({
        success: true,
        gene: new Gene({ type: GENE_TYPES.CODE, name: 'test_module', value: 'return 1;' }),
        code: 'return 1;',
        hash: 'abc123',
        passRate: 1,
      }),
    };
    population.fitnessEvaluator.evaluate = async () => ({ overall: 0.9, dimensions: {} });

    const result = await autoProgram.run();
    assert.equal(result.success, false);
    assert.equal(result.reason, 'guardian_rejected');
    assert.equal(addedInstances.length, 0);
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
