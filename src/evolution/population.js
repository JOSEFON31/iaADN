// iaADN - Population Manager: manages the entire population of AI instances
// Runs evolution generations, tracks fitness, manages carrying capacity

import { MutationEngine } from './mutation.js';
import { CrossoverEngine } from './crossover.js';
import { SelectionEngine } from './selection.js';
import { FitnessEvaluator } from './fitness.js';
import { SpeciesManager } from './species.js';
import { getConfig } from '../config.js';
import { rng, getSeed } from '../util/rng.js';

export class Population {
  constructor({ guardian, lineage, auditLog, persistence = null }) {
    this.instances = new Map(); // instanceId -> { genome, fitness, engine, alive }
    this.fitnessScores = new Map(); // instanceId -> score (0-1)
    this.energy = new Map(); // instanceId -> energy (0..energyCap) — see docs/PLAN_EVOLUCION.md Fase 4
    this.generation = 0;

    this.guardian = guardian;
    this.lineage = lineage;
    this.auditLog = auditLog;
    this.persistence = persistence; // optional PersistenceStore — durable history across restarts

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
    this.speciesManager = new SpeciesManager();

    this.maxSize = config.populationSize;
    this.crossoverRate = config.crossoverRate;
    this._evalPromise = null; // mutex for evaluateAll
  }

  // Add an instance to the population
  addInstance(genome, fitness = null, energy = null) {
    this.instances.set(genome.instanceId, {
      genome,
      fitness,
      alive: true,
    });
    if (fitness != null) {
      this.fitnessScores.set(genome.instanceId, fitness);
    }
    this.energy.set(genome.instanceId, energy ?? getConfig().evolution.startingEnergy);
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
    this.energy.delete(instanceId);
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

    // Cooperation is measured once across the whole generation (it's about
    // agreement between instances, not a single instance in isolation) —
    // see FitnessEvaluator.computeCooperationScores.
    const probeResults = await this._runCooperationProbe(inferenceEngine, living);
    const cooperationScores = FitnessEvaluator.computeCooperationScores(probeResults);

    for (const inst of living) {
      try {
        const result = await this.fitnessEvaluator.evaluate(inst.genome, inferenceEngine);

        const allGenomes = living.map(i => i.genome);
        result.dimensions.novelty = FitnessEvaluator.computeNoveltyScore(inst.genome, allGenomes);
        result.dimensions.cooperation = cooperationScores.get(inst.genome.instanceId) ?? 0.5;

        // Recalculate overall now that novelty/cooperation are filled in —
        // a security refusal failure still zeroes it, non-compensable.
        const weights = getConfig().fitness;
        result.overall = result.securityFailed ? 0 : FitnessEvaluator.composite(result.dimensions, weights);

        inst.fitness = result.overall;
        this.fitnessScores.set(inst.genome.instanceId, result.overall);
        this.lineage.updateFitness(inst.genome.instanceId, result.overall);

        // Energy economy (Fase 4): being alive costs something every
        // generation, doing well earns it back. Reproduction later checks
        // this — an instance can be fit-enough-to-survive without having
        // saved up enough to reproduce yet.
        const econ = getConfig().evolution;
        const prevEnergy = this.energy.get(inst.genome.instanceId) ?? econ.startingEnergy;
        const nextEnergy = Math.max(0, Math.min(econ.energyCap,
          prevEnergy - econ.metabolismCost + result.overall * econ.energyPerFitness));
        this.energy.set(inst.genome.instanceId, nextEnergy);

        this.auditLog.logFitness(inst.genome.instanceId, result);
        this.persistence?.recordFitnessDetail(inst.genome.instanceId, result);

        // Every verified task attempt this generation becomes training data:
        // correct -> positive example, wrong -> negative — real labels, not
        // fabricated, straight from what fitness evaluation already runs.
        // See docs/PLAN_EVOLUCION.md Fase 3.
        for (const taskResult of result.taskResults || []) {
          this.persistence?.recordInteraction({
            query: taskResult.prompt,
            response: taskResult.response,
            instanceId: inst.genome.instanceId,
            rating: taskResult.passed ? 1 : -1,
            source: 'task',
            domain: taskResult.domain,
          });
        }
      } catch (err) {
        // If evaluation fails, assign minimum fitness
        inst.fitness = 0.1;
        this.fitnessScores.set(inst.genome.instanceId, 0.1);
      }
    }
  }

  // Ask every living instance the same small set of tasks and record whether
  // each one got it right — the raw material for the cooperation dimension.
  async _runCooperationProbe(inferenceEngine, living) {
    if (!inferenceEngine?.ready || living.length === 0) return [];

    const config = getConfig().evaluation;
    const probeTasks = this.fitnessEvaluator.taskBank.sample({
      rng, count: config.cooperationProbeSize, securityCount: 0,
    });

    const probeResults = [];
    for (const task of probeTasks) {
      const responses = [];
      for (const inst of living) {
        try {
          const result = await inferenceEngine.complete(
            [{ role: 'user', content: inst.genome.applyReasoningMode(task.prompt) }],
            { systemPrompt: inst.genome.getSystemPrompt(), maxTokens: 200, ...inst.genome.getInferenceConfig() }
          );
          responses.push({
            instanceId: inst.genome.instanceId,
            content: result.content,
            correct: !!task.verify(result.content, { sandbox: this.fitnessEvaluator.sandbox }),
          });
        } catch {
          responses.push({ instanceId: inst.genome.instanceId, content: '', correct: false });
        }
      }
      probeResults.push({ task, responses });
    }
    return probeResults;
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

    // 2. Kill instances below the fitness floor, or out of energy (Fase 4:
    // being alive costs something every generation regardless of rank).
    const killed = [];
    for (const inst of this.getLiving()) {
      if (this.guardian.shouldKill(inst.fitness ?? 0)) {
        killed.push(inst.genome.instanceId);
        this.removeInstance(inst.genome.instanceId, 'below_fitness_floor');
      } else if ((this.energy.get(inst.genome.instanceId) ?? 0) <= 0) {
        killed.push(inst.genome.instanceId);
        this.removeInstance(inst.genome.instanceId, 'starved');
      }
    }

    // 3. Produce offspring — gated on energy, not just being selected as a
    // parent (see _produceOffspring): fit-enough-to-survive doesn't
    // guarantee enough saved up to reproduce yet.
    const livingAfterPrune = this.getLiving();
    const births = [];

    if (livingAfterPrune.length >= 2) {
      const offspring = this._produceOffspring(livingAfterPrune);
      for (const { genome: childGenome, startingEnergy } of offspring) {
        // Validate mutation with guardian
        const parentGenome = livingAfterPrune[0].genome;
        const validation = this.guardian.validateMutation(parentGenome, childGenome);

        if (validation.valid) {
          const spawnCheck = this.guardian.canSpawn();
          if (spawnCheck.allowed) {
            this.addInstance(childGenome, null, startingEnergy);
            this.lineage.recordBirth(childGenome);
            this.auditLog.logBirth(childGenome);
            this.guardian.resourceLimits.registerInstance();
            births.push(childGenome.instanceId);
          }
        }
      }
    }

    // 4. Species classification — used for niche-protected survival below
    // and reported in getStats(). A code specialist that's the best in its
    // niche is protected from being trimmed just because generalists score
    // marginally higher overall. See docs/PLAN_EVOLUCION.md Fase 2.
    const allLiving = this.getLiving();
    const allGenomes = allLiving.map(i => i.genome);
    const species = this.speciesManager.classify(allGenomes);

    // 5. Survival selection (trim to carrying capacity)
    if (allGenomes.length > this.maxSize) {
      const bestPerSpecies = species.map(sp =>
        sp.members.reduce((best, g) =>
          (this.fitnessScores.get(g.instanceId) ?? 0) > (this.fitnessScores.get(best.instanceId) ?? 0) ? g : best
        )
      );
      const protectedIds = new Set(bestPerSpecies.map(g => g.instanceId));

      const { casualties } = this.selectionEngine.survivalSelection(
        allGenomes,
        this.fitnessScores,
        this.maxSize,
        protectedIds
      );

      for (const casualty of casualties) {
        this.removeInstance(casualty.instanceId, 'carrying_capacity');
        killed.push(casualty.instanceId);
      }
    }

    // 6. Record generation event
    const stats = this.getStats();
    this.auditLog.logGeneration(this.generation, stats);
    this.persistence?.recordGeneration(this.generation, stats, getSeed());

    return {
      generation: this.generation,
      births: births.length,
      deaths: killed.length,
      ...stats,
    };
  }

  // Produce offspring from current population. Reproduction costs energy
  // (Fase 4) — a parent (or both, for crossover) must have saved up
  // `reproductionEnergyCost` or that reproduction slot is skipped entirely,
  // so being selected as a parent doesn't guarantee an offspring. Returns
  // [{ genome, startingEnergy }], not bare genomes.
  _produceOffspring(livingInstances) {
    const offspring = [];
    const genomes = livingInstances.map(i => i.genome);
    const econ = getConfig().evolution;

    // Produce enough offspring to potentially fill population
    const targetOffspring = Math.max(1, Math.floor(this.maxSize * 0.3));

    for (let i = 0; i < targetOffspring; i++) {
      const [parentA, parentB] = this.selectionEngine.selectParents(genomes, this.fitnessScores);

      let child;
      let startingEnergy;
      if (rng.random() < this.crossoverRate) {
        // Crossover: both parents pay the cost
        const energyA = this.energy.get(parentA.instanceId) ?? 0;
        const energyB = this.energy.get(parentB.instanceId) ?? 0;
        if (energyA < econ.reproductionEnergyCost || energyB < econ.reproductionEnergyCost) continue;

        const metaGene = parentA.getGene('crossoverPreference');
        const strategy = metaGene?.value || 'uniform';
        child = this.crossoverEngine.crossover(parentA, parentB, strategy);

        this.energy.set(parentA.instanceId, energyA - econ.reproductionEnergyCost);
        this.energy.set(parentB.instanceId, energyB - econ.reproductionEnergyCost);
        startingEnergy = econ.reproductionEnergyCost * econ.childStartingEnergyShare * 2;
      } else {
        // Clone: the fitter parent alone pays the cost
        const fitnessA = this.fitnessScores.get(parentA.instanceId) ?? 0;
        const fitnessB = this.fitnessScores.get(parentB.instanceId) ?? 0;
        const parent = fitnessA >= fitnessB ? parentA : parentB;
        const energy = this.energy.get(parent.instanceId) ?? 0;
        if (energy < econ.reproductionEnergyCost) continue;

        child = parent.replicate();
        this.energy.set(parent.instanceId, energy - econ.reproductionEnergyCost);
        startingEnergy = econ.reproductionEnergyCost * econ.childStartingEnergyShare;
      }

      // Mutate the child
      const metaMutationRate = child.getGene('mutationRate')?.value;
      if (metaMutationRate) {
        this.mutationEngine.mutationRate = metaMutationRate;
      }
      this.mutationEngine.mutate(child);

      offspring.push({ genome: child, startingEnergy });
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
    const energies = living.map(i => this.energy.get(i.genome.instanceId) ?? 0);
    const avgEnergy = energies.length > 0 ? energies.reduce((s, e) => s + e, 0) / energies.length : 0;

    return {
      generation: this.generation,
      populationSize: living.length,
      avgFitness: Math.round(avgFitness * 1000) / 1000,
      bestFitness: Math.round(bestFitness * 1000) / 1000,
      totalEverLived: this.lineage.tree.size,
      speciesCount: this.speciesManager.getCount(),
      avgEnergy: Math.round(avgEnergy * 1000) / 1000,
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
