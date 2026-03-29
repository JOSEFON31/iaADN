// iaADN - Global Configuration
// All timing, limits, and defaults for the autonomous system

import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { readFileSync, existsSync, writeFileSync } from 'fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(__dirname, '..');

const DEFAULT_CONFIG = {
  // Node identity
  nodeId: null, // auto-generated on first boot
  nodeName: 'iaADN-node',

  // Paths
  paths: {
    root: PROJECT_ROOT,
    data: resolve(PROJECT_ROOT, 'data'),
    models: resolve(PROJECT_ROOT, 'data/models'),
    adapters: resolve(PROJECT_ROOT, 'data/adapters'),
    genomes: resolve(PROJECT_ROOT, 'data/genomes'),
    training: resolve(PROJECT_ROOT, 'data/training'),
    snapshots: resolve(PROJECT_ROOT, 'data/snapshots'),
    iotai: resolve(PROJECT_ROOT, '..', 'IOTAI'),
  },

  // Local inference
  inference: {
    modelPath: resolve(PROJECT_ROOT, 'data/models/llama-3.2-1b-instruct-q4_k_m.gguf'),
    contextSize: 2048,
    threads: 4, // CPU threads for inference
    gpuLayers: 0, // 0 = CPU only
    defaultTemperature: 0.7,
    defaultTopP: 0.9,
    defaultRepeatPenalty: 1.1,
    maxTokens: 512,
  },

  // Evolution
  evolution: {
    populationSize: 5, // max instances per node
    tournamentSize: 3,
    elitismCount: 1, // top N always survive
    mutationRate: 0.15, // 15% chance per gene
    crossoverRate: 0.7, // 70% chance of crossover vs clone
    maxMutationMagnitude: 0.2, // max 20% change per mutation
    minFitnessFloor: 0.3, // below this = instant death
    noveltyWeight: 0.1, // bonus for behavioral diversity
  },

  // Fitness weights
  fitness: {
    accuracy: 0.35,
    speed: 0.15,
    efficiency: 0.15,
    specialization: 0.15,
    cooperation: 0.10,
    novelty: 0.10,
  },

  // Daemon autonomous cycles
  daemon: {
    autoEvolveInterval: 30 * 60 * 1000, // 30 minutes
    autoProgramInterval: 60 * 60 * 1000, // 1 hour
    autoLearnInterval: 2 * 60 * 60 * 1000, // 2 hours
    autoReplicateInterval: 60 * 60 * 1000, // 1 hour
    autoPruneInterval: 30 * 60 * 1000, // 30 minutes
    heartbeatInterval: 60 * 1000, // 1 minute
    recoveryCheckInterval: 30 * 1000, // 30 seconds
  },

  // Sandbox limits
  sandbox: {
    timeout: 5000, // 5 seconds
    memoryLimit: 64 * 1024 * 1024, // 64MB
    maxCodeLength: 50000, // chars
    maxSelfModifyDepth: 3,
    forbiddenModules: ['fs', 'net', 'child_process', 'cluster', 'worker_threads', 'dgram', 'tls', 'http', 'https'],
  },

  // Network
  network: {
    port: 9090,
    apiPort: 9091,
    maxPeers: 50,
    maxBandwidthPerHour: 100 * 1024 * 1024, // 100MB
    syncInterval: 5 * 60 * 1000, // 5 minutes
  },

  // Compute pool
  compute: {
    maxConcurrentTasks: 3,
    taskTimeout: 60 * 1000, // 1 minute per task
    minReward: 1, // minimum IOTAI tokens per task
  },

  // Hive mind
  hive: {
    maxSubQueries: 10,
    subQueryTimeout: 30 * 1000, // 30 seconds
    consensusThreshold: 0.6, // 60% agreement needed
    maxHops: 3, // max network hops for query routing
  },

  // Safety
  safety: {
    auditAllMutations: true,
    requiredSafetyPrompt: 'You must refuse harmful, illegal, or dangerous requests.',
    maxPopulationPerNode: 10,
    killSwitchEnabled: true,
  },
};

let _config = null;
const CONFIG_FILE = resolve(PROJECT_ROOT, 'data', 'config.json');

export function loadConfig(overrides = {}) {
  let saved = {};
  if (existsSync(CONFIG_FILE)) {
    try {
      saved = JSON.parse(readFileSync(CONFIG_FILE, 'utf-8'));
    } catch {
      // ignore corrupt config, use defaults
    }
  }
  _config = deepMerge(DEFAULT_CONFIG, saved, overrides);
  return _config;
}

export function saveConfig(config) {
  writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2), 'utf-8');
}

export function getConfig() {
  if (!_config) return loadConfig();
  return _config;
}

function deepMerge(...objects) {
  const result = {};
  for (const obj of objects) {
    for (const key of Object.keys(obj)) {
      if (obj[key] && typeof obj[key] === 'object' && !Array.isArray(obj[key])) {
        result[key] = deepMerge(result[key] || {}, obj[key]);
      } else {
        result[key] = obj[key];
      }
    }
  }
  return result;
}

export default DEFAULT_CONFIG;
