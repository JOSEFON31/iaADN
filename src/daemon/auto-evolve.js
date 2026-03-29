// iaADN - Auto Evolve: autonomous evolution cycle
// Runs every 30 minutes — evaluates, selects, crosses, mutates, prunes
// NO HUMAN INTERVENTION NEEDED

export class AutoEvolve {
  constructor({ population, inferenceEngine, auditLog }) {
    this.population = population;
    this.inferenceEngine = inferenceEngine;
    this.auditLog = auditLog;
  }

  // Run one autonomous evolution cycle
  async run() {
    const living = this.population.getLiving();

    if (living.length < 2) {
      console.log('[AutoEvolve] Population too small, skipping generation');
      return { skipped: true, reason: 'population_too_small', size: living.length };
    }

    console.log(`[AutoEvolve] Starting generation ${this.population.generation + 1}...`);
    console.log(`[AutoEvolve] Population: ${living.length} instances`);

    const result = await this.population.runGeneration(this.inferenceEngine);

    console.log(`[AutoEvolve] Generation ${result.generation} complete:`);
    console.log(`  Births: ${result.births}, Deaths: ${result.deaths}`);
    console.log(`  Population: ${result.populationSize}`);
    console.log(`  Avg Fitness: ${result.avgFitness}, Best: ${result.bestFitness}`);

    return result;
  }
}
