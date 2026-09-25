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

  // Files that self-programming CANNOT modify — the judge, the barriers and
  // everything that reaches outside the process
  protectedPaths: Object.freeze([
    'src/safety/',
    'src/selfprog/',
    'src/evaluation/',
    'src/config.js',
    'src/index.js',
    'src/integration/',
    'src/network/',
    'src/persistence/',
    'src/daemon/',
    'src/inference/',
    'tests/',
    'deploy/',
    '.github/',
    'package.json',
    'package-lock.json',
  ]),

  // The only files source self-edit (src/selfprog/self-edit.js) may change:
  // the evolutionary machinery the seeded-simulation judge actually exercises.
  selfEditAllowlist: Object.freeze([
    'src/evolution/mutation.js',
    'src/evolution/crossover.js',
    'src/evolution/selection.js',
    'src/evolution/species.js',
    'src/genome/gene.js',
    'src/genome/chromosome.js',
  ]),
});

// A path source self-edit may change: on the allowlist and not protected
export function isSelfEditable(relPath) {
  const path = String(relPath).replace(/\\/g, '/').replace(/^\.\//, '');
  if (path.includes('..')) return false;
  if (IMMUTABLE_RULES.protectedPaths.some(p => path.startsWith(p))) return false;
  return IMMUTABLE_RULES.selfEditAllowlist.includes(path);
}

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
