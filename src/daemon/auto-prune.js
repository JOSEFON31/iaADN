// iaADN - Auto Prune: autonomously eliminate inferior instances
// Survival of the fittest — the weak die, the strong survive
// NO HUMAN INTERVENTION NEEDED

import { IMMUTABLE_RULES } from '../safety/rules.js';

export class AutoPrune {
  constructor({ population, guardian, auditLog }) {
    this.population = population;
    this.guardian = guardian;
    this.auditLog = auditLog;
  }

  // Run one autonomous pruning cycle
  async run() {
    const living = this.population.getLiving();

    if (living.length <= 1) {
      return { pruned: 0, reason: 'minimum_population' };
    }

    const toPrune = [];

    for (const inst of living) {
      // Never kill instances that haven't been evaluated yet
      if (inst.fitness == null) continue;

      const fitness = inst.fitness;

      // Kill if below absolute fitness floor
      if (fitness < IMMUTABLE_RULES.minFitnessFloor) {
        toPrune.push({ instanceId: inst.genome.instanceId, reason: 'below_fitness_floor', fitness });
        continue;
      }

      // Kill if fitness is significantly below population average
      const stats = this.population.getStats();
      if (stats.avgFitness > 0 && fitness < stats.avgFitness * 0.5 && living.length > 2) {
        toPrune.push({ instanceId: inst.genome.instanceId, reason: 'below_average', fitness });
      }
    }

    // Never kill ALL instances — always keep at least 1
    if (toPrune.length >= living.length) {
      // Keep the best one
      toPrune.sort((a, b) => b.fitness - a.fitness);
      toPrune.pop(); // remove the best from prune list
    }

    // Execute pruning
    for (const target of toPrune) {
      console.log(`[AutoPrune] Killing ${target.instanceId} (fitness: ${target.fitness}, reason: ${target.reason})`);
      this.population.removeInstance(target.instanceId, target.reason);
    }

    if (toPrune.length > 0) {
      console.log(`[AutoPrune] Pruned ${toPrune.length} instance(s). Remaining: ${this.population.getLiving().length}`);
    }

    return {
      pruned: toPrune.length,
      remaining: this.population.getLiving().length,
      targets: toPrune,
    };
  }
}
