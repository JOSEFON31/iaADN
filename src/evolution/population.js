// iaADN - Population Manager: manages the entire population of AI instances
// Runs evolution generations, tracks fitness, manages carrying capacity

import { MutationEngine } from './mutation.js';
import { CrossoverEngine } from './crossover.js';
import { SelectionEngine } from './selection.js';
import { FitnessEvaluator } from './fitness.js';
import { getConfig } from '../config.js';

export class Population {
  constructor({ guardian, lineage, auditLog }) {
    this.instances = new Map(); // instanceId -> { genome, fitness, engine, alive }
    this.fitnessScores = new Map(); // instanceId -> score (0-1)
    this.generation = 0;

    this.guardian = guardian;
    this.lineage = lineage;
    this.auditLog = auditLog;

    const config = getConfig().evolution;
    this.mutationEngine = new MutationEngine({
      mutationRate: config.mutationRate,
      maxMagnitude: config.maxMutationMagnitude,
    });
    this.crossoverEngine = new CrossoverEngine();
    this.selectionEngine = new SelectionEngine({
      tournamentSize: config.tournamentSize,
      elitismCount: config.elitismCount,
    });
    this.fitnessEvaluator = new FitnessEvaluator();

    this.maxSize = config.populationSize;
    this.crossoverRate = config.crossoverRate;
    this._evalPromise = null; // mutex for evaluateAll
  }

  // Add an instance to the population
  addInstance(genome, fitness = null) {
    this.instances.set(genome.instanceId, {
      genome,
      fitness,
      alive: true,
    });
    if (fitness != null) {
      this.fitnessScores.set(genome.instanceId, fitness);
    }
  }

  // Remove an instance (death)
  removeInstance(instanceId, reason = 'selection') {
    const inst = this.instances.get(instanceId);
    if (!inst) return;

    inst.alive = false;
    this.lineage.recordDeath(instanceId, reason);
    this.auditLog.logDeath(instanceId, reason, this.fitnessScores.get(instanceId));
    this.instances.delete(instanceId);
    this.fitnessScores.delete(instanceId);
    this.guardian.resourceLimits.unregisterInstance();
  }

  // Evaluate fitness for all living instances (with mutex to prevent concurrent runs)
  async evaluateAll(inferenceEngine) {
    if (this._evalPromise) return this._evalPromise;
    this._evalPromise = this._doEvaluateAll(inferenceEngine);
    try {
      await this._evalPromise;
    } finally {
      this._evalPromise = null;
    }
  }

  async _doEvaluateAll(inferenceEngine) {
    const living = this.getLiving();

    for (const inst of living) {
      try {
        const result = await this.fitnessEvaluator.evaluate(inst.genome, inferenceEngine);

        // Compute novelty score
        const allGenomes = living.map(i => i.genome);
        result.dimensions.novelty = FitnessEvaluator.computeNoveltyScore(inst.genome, allGenomes);

        // Recalculate overall with novelty
        const weights = getConfig().fitness;
        result.overall =
          weights.accuracy * result.dimensions.accuracy +
          weights.speed * result.dimensions.speed +
          weights.efficiency * result.dimensions.efficiency +
          weights.specialization * result.dimensions.specialization +
          weights.cooperation * result.dimensions.cooperation +
          weights.novelty * result.dimensions.novelty;

        result.overall = Math.max(0, Math.min(1, result.overall));

        inst.fitness = result.overall;
        this.fitnessScores.set(inst.genome.instanceId, result.overall);
        this.lineage.updateFitness(inst.genome.instanceId, result.overall);
        this.auditLog.logFitness(inst.genome.instanceId, result);
      } catch (err) {
        // If evaluation fails, assign minimum fitness
        inst.fitness = 0.1;
        this.fitnessScores.set(inst.genome.instanceId, 0.1);
      }
    }
  }

  // Run one complete generation cycle (autonomous — no human needed)
  async runGeneration(inferenceEngine) {
    this.generation++;
    const living = this.getLiving();

    if (living.length < 2) {
      // Not enough instances for evolution
      return { generation: this.generation, skipped: true, reason: 'insufficient_population' };
    }

    // 1. Evaluate fitness
    await this.evaluateAll(inferenceEngine);

    // 2. Kill instances below fitness floor
    const killed = [];
    for (const inst of this.getLiving()) {
      if (this.guardian.shouldKill(inst.fitness ?? 0)) {
        killed.push(inst.genome.instanceId);
        this.removeInstance(inst.genome.instanceId, 'below_fitness_floor');
      }
    }

    // 3. Produce offspring
    const livingAfterPrune = this.getLiving();
    const births = [];

    if (livingAfterPrune.length >= 2) {
      const offspring = this._produceOffspring(livingAfterPrune);
      for (const childGenome of offspring) {
        // Validate mutation with guardian
        const parentGenome = livingAfterPrune[0].genome;
        const validation = this.guardian.validateMutation(parentGenome, childGenome);

        if (validation.valid) {
          const spawnCheck = this.guardian.canSpawn();
          if (spawnCheck.allowed) {
            this.addInstance(childGenome);
            this.lineage.recordBirth(childGenome);
            this.auditLog.logBirth(childGenome);
            this.guardian.resourceLimits.registerInstance();
            births.push(childGenome.instanceId);
          }
        }
      }
    }

    // 4. Survival selection (trim to carrying capacity)
    const allLiving = this.getLiving();
    const allGenomes = allLiving.map(i => i.genome);

    if (allGenomes.length > this.maxSize) {
      const { casualties } = this.selectionEngine.survivalSelection(
        allGenomes,
        this.fitnessScores,
        this.maxSize
      );

      for (const casualty of casualties) {
        this.removeInstance(casualty.instanceId, 'carrying_capacity');
        killed.push(casualty.instanceId);
      }
    }

    // 5. Record generation event
    const stats = this.getStats();
    this.auditLog.logGeneration(this.generation, stats);

    return {
      generation: this.generation,
      births: births.length,
      deaths: killed.length,
      ...stats,
    };
  }

  // Produce offspring from current population
  _produceOffspring(livingInstances) {
    const offspring = [];
    const genomes = livingInstances.map(i => i.genome);

    // Produce enough offspring to potentially fill population
    const targetOffspring = Math.max(1, Math.floor(this.maxSize * 0.3));

    for (let i = 0; i < targetOffspring; i++) {
      const [parentA, parentB] = this.selectionEngine.selectParents(genomes, this.fitnessScores);

      let child;
      if (Math.random() < this.crossoverRate) {
        // Crossover: combine two parents
        const metaGene = parentA.getGene('crossoverPreference');
        const strategy = metaGene?.value || 'uniform';
        child = this.crossoverEngine.crossover(parentA, parentB, strategy);
      } else {
        // Clone: replicate the fitter parent
        const fitnessA = this.fitnessScores.get(parentA.instanceId) ?? 0;
        const fitnessB = this.fitnessScores.get(parentB.instanceId) ?? 0;
        child = (fitnessA >= fitnessB ? parentA : parentB).replicate();
      }

      // Mutate the child
      const metaMutationRate = child.getGene('mutationRate')?.value;
      if (metaMutationRate) {
        this.mutationEngine.mutationRate = metaMutationRate;
      }
      this.mutationEngine.mutate(child);

      offspring.push(child);
    }

    return offspring;
  }

  // Get all living instances
  getLiving() {
    const living = [];
    for (const inst of this.instances.values()) {
      if (inst.alive) living.push(inst);
    }
    return living;
  }

  // Get population statistics
  getStats() {
    const living = this.getLiving();
    const fitnesses = living.map(i => i.fitness ?? 0);
    const avgFitness = fitnesses.length > 0
      ? fitnesses.reduce((s, f) => s + f, 0) / fitnesses.length
      : 0;
    const bestFitness = fitnesses.length > 0 ? Math.max(...fitnesses) : 0;

    return {
      generation: this.generation,
      populationSize: living.length,
      avgFitness: Math.round(avgFitness * 1000) / 1000,
      bestFitness: Math.round(bestFitness * 1000) / 1000,
      totalEverLived: this.lineage.tree.size,
    };
  }

  // Get the fittest instance
  getBest() {
    let best = null;
    let bestFitness = -1;

    for (const inst of this.instances.values()) {
      if (inst.alive && (inst.fitness ?? 0) > bestFitness) {
        best = inst;
        bestFitness = inst.fitness ?? 0;
      }
    }

    return best;
  }
}
