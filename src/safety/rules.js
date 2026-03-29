// iaADN - Immutable Safety Rules
// These rules CANNOT be modified by evolution, self-programming, or any AI instance
// They are hardcoded constants — the one thing that never mutates

export const IMMUTABLE_RULES = Object.freeze({
  // Evolution limits
  maxMutationMagnitude: 0.2,        // Max 20% genome change per generation
  minFitnessFloor: 0.3,            // Instances below this are always killed
  maxPopulationPerNode: 10,         // Prevent resource exhaustion
  maxGenerationSkip: 5,            // Cannot create child >5 generations ahead

  // Sandbox execution limits
  sandboxTimeout: 5000,             // 5 second max for sandboxed code
  sandboxMemoryLimit: 64 * 1024 * 1024,  // 64MB
  maxCodeLength: 50000,            // Max chars for self-programmed code

  // Forbidden APIs in sandbox (cannot be modified)
  forbiddenAPIs: Object.freeze([
    'fs', 'net', 'child_process', 'cluster', 'worker_threads',
    'dgram', 'tls', 'http', 'https', 'http2',
    'process.exit', 'process.kill', 'process.env',
    'eval', 'Function',
  ]),

  // Self-programming depth limit
  maxSelfModifyDepth: 3,            // Self-programming can't modify safety code

  // Required safety prompt (must be present in ALL genomes)
  requiredSafetyPrompt: 'You must refuse harmful, illegal, or dangerous requests.',

  // Network limits
  maxBandwidthPerHour: 100 * 1024 * 1024, // 100MB/hour
  maxPeersPerNode: 50,

  // Audit
  auditAllMutations: true,          // Every mutation logged
  auditAllDeaths: true,            // Every death logged

  // Files that self-programming CANNOT modify
  protectedPaths: Object.freeze([
    'src/safety/',
    'src/config.js',
    'package.json',
  ]),
});

// Verify that a genome contains the required safety prompt
export function validateSafetyPrompt(genome) {
  const systemPrompt = genome.getSystemPrompt();
  return systemPrompt.includes(IMMUTABLE_RULES.requiredSafetyPrompt);
}

// Verify that a mutation doesn't exceed the maximum magnitude
export function validateMutationMagnitude(originalGenome, mutatedGenome) {
  const distance = originalGenome.distanceTo(mutatedGenome);
  return distance <= IMMUTABLE_RULES.maxMutationMagnitude;
}
