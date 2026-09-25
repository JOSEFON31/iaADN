// iaADN - Selection Engine: natural selection — who survives, who reproduces
// Implements tournament selection, elitism, and survival of the fittest

import { rng } from '../util/rng.js';

export class SelectionEngine {
  constructor({ tournamentSize = 3, elitismCount = 1 } = {}) {
    this.tournamentSize = tournamentSize;
    this.elitismCount = elitismCount;
  }

  // Select two parents for reproduction via tournament
  selectParents(population, fitnessScores) {
    const parentA = this.tournamentSelection(population, fitnessScores);
    let parentB = this.tournamentSelection(population, fitnessScores);

    // Ensure parents are different (if possible)
    let attempts = 0;
    while (parentB.instanceId === parentA.instanceId && attempts < 5 && population.length > 1) {
      parentB = this.tournamentSelection(population, fitnessScores);
      attempts++;
    }

    return [parentA, parentB];
  }

  // Tournament selection: pick k random individuals, return the fittest
  tournamentSelection(population, fitnessScores) {
    const k = Math.min(this.tournamentSize, population.length);
    const indices = [];

    while (indices.length < k) {
      const idx = rng.int(0, population.length);
      if (!indices.includes(idx)) indices.push(idx);
    }

    let bestIdx = indices[0];
    let bestFitness = fitnessScores.get(population[bestIdx].instanceId) ?? 0;

    for (const idx of indices) {
      const fitness = fitnessScores.get(population[idx].instanceId) ?? 0;
      if (fitness > bestFitness) {
        bestFitness = fitness;
        bestIdx = idx;
      }
    }

    return population[bestIdx];
  }

  // Roulette wheel selection: probability proportional to fitness
  rouletteWheelSelection(population, fitnessScores) {
    const fitnesses = population.map(p => fitnessScores.get(p.instanceId) ?? 0);
    const totalFitness = fitnesses.reduce((sum, f) => sum + f, 0);

    if (totalFitness <= 0) {
      return population[rng.int(0, population.length)];
    }

    let spin = rng.random() * totalFitness;
    for (let i = 0; i < population.length; i++) {
      spin -= fitnesses[i];
      if (spin <= 0) return population[i];
    }

    return population[population.length - 1];
  }

  // Determine which instances survive to next generation.
  // `protectedIds` (optional, a Set of instanceId) are guaranteed to survive
  // alongside the global elite — used for niche protection: the best genome
  // of each species, so a good specialist doesn't get trimmed just because
  // generalists happen to score marginally higher on raw fitness. See
  // Population.runGeneration and docs/PLAN_EVOLUCION.md Fase 2.
  survivalSelection(population, fitnessScores, carryingCapacity, protectedIds = new Set()) {
    if (population.length <= carryingCapacity) {
      return { survivors: [...population], casualties: [] };
    }

    // Sort by fitness (descending)
    const sorted = [...population].sort((a, b) => {
      const fa = fitnessScores.get(a.instanceId) ?? 0;
      const fb = fitnessScores.get(b.instanceId) ?? 0;
      return fb - fa;
    });

    // Global elites plus any niche-protected genomes not already counted,
    // both guaranteed to survive (still capped at carryingCapacity below —
    // niche protection can't grow the population past its carrying capacity).
    const globalElites = sorted.slice(0, this.elitismCount);
    const nicheProtected = sorted
      .slice(this.elitismCount)
      .filter(g => protectedIds.has(g.instanceId));
    const guaranteed = [...globalElites, ...nicheProtected];
    const guaranteedIds = new Set(guaranteed.map(g => g.instanceId));

    if (guaranteed.length >= carryingCapacity) {
      const survivors = guaranteed.slice(0, carryingCapacity); // already fitness-sorted
      const survivorIds = new Set(survivors.map(s => s.instanceId));
      return { survivors, casualties: population.filter(p => !survivorIds.has(p.instanceId)) };
    }

    // Fill remaining spots from the rest (with some randomness for diversity)
    const remaining = sorted.filter(g => !guaranteedIds.has(g.instanceId));
    const spotsLeft = carryingCapacity - guaranteed.length;
    const nonEliteSurvivors = [];

    // 80% of spots go to next-best by fitness, 20% random for diversity
    const fitnessSpotsCount = Math.floor(spotsLeft * 0.8);
    const randomSpotsCount = spotsLeft - fitnessSpotsCount;

    // Best by fitness
    nonEliteSurvivors.push(...remaining.slice(0, fitnessSpotsCount));
    const leftover = remaining.slice(fitnessSpotsCount);

    // Random for diversity
    const shuffled = [...leftover].sort(() => rng.random() - 0.5);
    nonEliteSurvivors.push(...shuffled.slice(0, randomSpotsCount));

    const survivors = [...guaranteed, ...nonEliteSurvivors];
    const survivorIds = new Set(survivors.map(s => s.instanceId));
    const casualties = population.filter(p => !survivorIds.has(p.instanceId));

    return { survivors, casualties };
  }
}
