// iaADN - Energy economy tests (Fase 4): reproduction is gated on
// accumulated success, and existing costs something every generation.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { Population } from '../src/evolution/population.js';
import { Genome } from '../src/genome/genome.js';
import { Lineage } from '../src/genome/lineage.js';
import { SafetyGuardian } from '../src/safety/guardian.js';
import { AuditLog } from '../src/safety/audit-log.js';
import { getConfig } from '../src/config.js';

function withPopulation(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'iaadn-test-'));
  return (async () => {
    try {
      const auditLog = new AuditLog(join(dir, 'audit'));
      const guardian = new SafetyGuardian(auditLog);
      const lineage = new Lineage();
      const population = new Population({ guardian, lineage, auditLog });
      // Stub out the real task-based evaluator so fitness is exact and
      // controllable per test, instead of depending on the mock backend's
      // random task outcomes.
      return await fn(population);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  })();
}

// Population._doEvaluateAll recomputes `overall` from `dimensions` after
// filling in real novelty/cooperation — so every dimension is set to the
// target here (not just `overall`), which keeps the 80%-weighted majority
// of the composite at the target regardless of what novelty/cooperation
// end up being.
function stubFitness(population, fitnessByInstanceId) {
  population.fitnessEvaluator.evaluate = async (genome) => {
    const target = fitnessByInstanceId[genome.instanceId] ?? 0.5;
    return {
      overall: target,
      dimensions: { accuracy: target, speed: target, efficiency: target, specialization: target, cooperation: target, novelty: target },
      byDomain: {},
      securityFailed: false,
      taskResults: [],
      evaluatedAt: Date.now(),
    };
  };
}

describe('energy economy', () => {
  it('a new instance starts with the configured starting energy', () => withPopulation(async population => {
    const genome = Genome.createGenesis('test');
    population.addInstance(genome);
    assert.equal(population.energy.get(genome.instanceId), getConfig().evolution.startingEnergy);
  }));

  it('energy rises with high fitness and falls with low fitness after evaluation', () => withPopulation(async population => {
    const strong = Genome.createGenesis('test');
    const weak = Genome.createGenesis('test');
    population.addInstance(strong);
    population.addInstance(weak);
    stubFitness(population, { [strong.instanceId]: 1.0, [weak.instanceId]: 0.0 });

    const before = population.energy.get(strong.instanceId);
    await population.evaluateAll(null);

    assert.ok(population.energy.get(strong.instanceId) > before, 'high fitness should gain energy');
    assert.ok(
      population.energy.get(weak.instanceId) < population.energy.get(strong.instanceId),
      'zero-fitness instance should end up with less energy than the high-fitness one'
    );
  }));

  it('energy never goes negative or above the cap', () => withPopulation(async population => {
    const genome = Genome.createGenesis('test');
    const other = Genome.createGenesis('test'); // avoid the lone-genome novelty=1.0 special case
    population.addInstance(genome, null, 0.001); // near zero
    population.addInstance(other);
    stubFitness(population, { [genome.instanceId]: 0, [other.instanceId]: 0 });
    await population.evaluateAll(null);
    assert.equal(population.energy.get(genome.instanceId), 0, 'should clamp at the floor, never negative');

    population.energy.set(genome.instanceId, getConfig().evolution.energyCap);
    stubFitness(population, { [genome.instanceId]: 1, [other.instanceId]: 1 });
    await population.evaluateAll(null);
    assert.ok(population.energy.get(genome.instanceId) <= getConfig().evolution.energyCap, 'should clamp at the cap');
  }));

  it('an instance that runs out of energy is removed with reason "starved", even above the fitness floor', () => withPopulation(async population => {
    const config = getConfig().evolution;
    // Fitness here clears minFitnessFloor (0.3) comfortably, but sits below
    // the metabolism/energyPerFitness breakeven (0.5) — merely surviving the
    // floor isn't the same as sustaining yourself. Starting energy is low
    // enough that this generation's net loss takes it to zero.
    const genome = Genome.createGenesis('test');
    const other = Genome.createGenesis('test'); // keeps population >= 2 so runGeneration proceeds
    population.addInstance(genome, null, 0.05);
    population.addInstance(other, null, 2);
    population.lineage.recordBirth(genome);
    population.lineage.recordBirth(other);
    stubFitness(population, { [genome.instanceId]: 0.35, [other.instanceId]: 0.9 });
    assert.ok(0.35 > config.minFitnessFloor, 'sanity: fitness must clear the survival floor for this to test starvation specifically');

    await population.runGeneration(null);

    assert.equal(population.instances.has(genome.instanceId), false);
    const entry = population.lineage.tree.get(genome.instanceId);
    assert.equal(entry.deathReason, 'starved');
  }));

  it('reproduction is skipped when no parent has enough energy, and costs energy when it happens', () => withPopulation(async population => {
    const config = getConfig().evolution;
    const a = Genome.createGenesis('test');
    const b = Genome.createGenesis('test');
    population.addInstance(a, 0.8, config.reproductionEnergyCost - 0.01); // just short
    population.addInstance(b, 0.8, config.reproductionEnergyCost - 0.01);
    population.fitnessScores.set(a.instanceId, 0.8);
    population.fitnessScores.set(b.instanceId, 0.8);

    const offspringPoor = population._produceOffspring(population.getLiving());
    assert.equal(offspringPoor.length, 0, 'neither parent has enough energy to reproduce');

    population.energy.set(a.instanceId, 1.0);
    population.energy.set(b.instanceId, 1.0);
    const before = population.energy.get(a.instanceId);
    const offspringRich = population._produceOffspring(population.getLiving());

    assert.ok(offspringRich.length > 0, 'well-fed parents should reproduce');
    for (const { startingEnergy } of offspringRich) {
      // Clone: cost * share. Crossover: cost * share * 2 (both parents
      // contributed) — which can equal, but never exceed, the cost itself.
      assert.ok(startingEnergy > 0 && startingEnergy <= config.reproductionEnergyCost);
    }
    const spentSomewhere = population.energy.get(a.instanceId) < before || population.energy.get(b.instanceId) < before;
    assert.ok(spentSomewhere, 'reproducing should cost the parent(s) energy');
  }));
});
