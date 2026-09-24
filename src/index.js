#!/usr/bin/env node
// iaADN - Decentralized Self-Evolving AI System
// Entry point: boots the system, initializes all components
// After boot, the daemon runs 24/7 autonomously — no human needed

import { loadConfig, getConfig, saveConfig, CONFIG_FILE } from './config.js';
import { Genome } from './genome/genome.js';
import { GenomeCodec } from './genome/codec.js';
import { Lineage } from './genome/lineage.js';
import { InferenceEngine } from './inference/engine.js';
import { LlamaBackend } from './inference/llama-backend.js';
import { MockBackend } from './inference/mock-backend.js';
import { ModelRegistry } from './inference/model-registry.js';
import { SafetyGuardian } from './safety/guardian.js';
import { AuditLog } from './safety/audit-log.js';
import { KillSwitch } from './safety/kill-switch.js';
import { IOTAIBridge } from './integration/iotai-bridge.js';
import { Population } from './evolution/population.js';
import { PersistenceStore } from './persistence/store.js';
import { Lifecycle } from './daemon/lifecycle.js';
import { Recovery } from './daemon/recovery.js';
import { HiveMind } from './hive/mind.js';
import { API } from './integration/api.js';
import { initRng, getSeed, rng } from './util/rng.js';
import { randomBytes } from 'crypto';
import { mkdirSync, writeFileSync } from 'fs';
import { resolve, dirname } from 'path';

class IaADN {
  constructor() {
    this.config = null;
    this.nodeId = null;
    this.auditLog = null;
    this.guardian = null;
    this.killSwitch = null;
    this.lineage = null;
    this.modelRegistry = null;
    this.inferenceEngine = null;
    this.iotaiBridge = null;
    this.persistenceStore = null;
    this.populationManager = null; // single source of truth for the population — see docs/PLAN_EVOLUCION.md §0
    this.hiveMind = null;
    this.api = null;
    this.running = false;
  }

  // options.simulate: run in fast simulation mode (mock backend, no daemon timers)
  // options.seed: override the evolution RNG seed for this boot (reproducibility/debugging)
  async boot({ simulate = false, seed = null } = {}) {
    console.log('=== iaADN - Decentralized Self-Evolving AI ===');
    console.log('Initializing...\n');

    // 1. Load configuration
    this.config = loadConfig(seed ? { evolution: { seed } } : {});
    this.nodeId = this.config.nodeId || ('node_' + randomBytes(8).toString('hex'));
    if (!this.config.nodeId) {
      this.config.nodeId = this.nodeId;
      saveConfig(this.config);
    }
    console.log(`[Boot] Node ID: ${this.nodeId}`);

    // 1a. API token — generated once and kept in data/config.json (owner-only
    // file). Never logged; read it deliberately with `--show-token`.
    this.apiToken = resolveApiToken(this.config);

    // 1b. Seed the shared RNG — every mutation/crossover/selection decision
    // from here on is reproducible from this one value.
    const usedSeed = initRng(this.config.evolution.seed);
    if (!this.config.evolution.seed) {
      this.config.evolution.seed = usedSeed;
      saveConfig(this.config);
    }
    console.log(`[Boot] RNG seed: ${usedSeed}`);

    // 2. Initialize safety systems FIRST (before anything else)
    this.auditLog = new AuditLog();
    this.killSwitch = new KillSwitch(this.auditLog);
    this.guardian = new SafetyGuardian(this.auditLog);
    console.log('[Boot] Safety systems initialized');
    this.auditLog.log('rng_seed', { seed: usedSeed });

    // Wire up kill switch
    this.killSwitch.on('activated', ({ reason }) => {
      console.error(`\n[EMERGENCY] Kill switch activated: ${reason}`);
      this.shutdown();
    });

    // 3. Initialize persistence — SQLite store that survives restarts
    this.persistenceStore = new PersistenceStore();
    console.log('[Boot] Persistence store initialized');

    // 4. Initialize lineage tracking (restored from persistence if available)
    const savedLineage = this.persistenceStore.loadLineageEntries();
    this.lineage = savedLineage.length > 0 ? Lineage.fromJSON(savedLineage) : new Lineage();
    this.lineage.persistence = this.persistenceStore;
    console.log(`[Boot] Lineage tracking initialized (${savedLineage.length} known instance(s))`);

    // 5. Initialize model registry
    this.modelRegistry = new ModelRegistry();
    const models = this.modelRegistry.listModels();
    console.log(`[Boot] Model registry: ${models.length} model(s) available`);

    // 6. Initialize inference engine
    const bestModel = this.modelRegistry.getBestModel();
    if (bestModel && !simulate) {
      const backend = new LlamaBackend(bestModel.path);
      this.inferenceEngine = new InferenceEngine(backend);
      try {
        await this.inferenceEngine.initialize();
        console.log(`[Boot] Inference engine: loaded ${bestModel.name} (${bestModel.sizeMB}MB)`);
      } catch (err) {
        console.warn(`[Boot] Inference engine failed to load: ${err.message}`);
        this.inferenceEngine = null;
      }
    }
    if (!this.inferenceEngine) {
      // No usable real model (or explicitly running a fast simulation) — use
      // the mock backend so fitness evaluation and the hive mind always have
      // a working, instant inference engine instead of silently having none.
      this.inferenceEngine = new InferenceEngine(new MockBackend());
      await this.inferenceEngine.initialize();
      console.log(`[Boot] Inference engine: mock backend (${simulate ? 'simulation mode' : 'no model file found'})`);
    }

    // 7. Connect to IOTAI
    this.iotaiBridge = new IOTAIBridge();
    const iotaiConnected = await this.iotaiBridge.connect();
    console.log(`[Boot] IOTAI bridge: ${iotaiConnected ? 'connected' : 'standalone mode'}`);

    // 8. Initialize population manager (restored from persistence if available)
    this.populationManager = new Population({
      guardian: this.guardian,
      lineage: this.lineage,
      auditLog: this.auditLog,
      persistence: this.persistenceStore,
    });

    const restored = this.persistenceStore.loadPopulation();
    for (const { genome, fitness } of restored) {
      this.populationManager.addInstance(genome, fitness);
      this.guardian.resourceLimits.registerInstance();
    }
    this.populationManager.generation = this.persistenceStore.getLastGeneration();

    // 9. Initialize hive mind
    this.hiveMind = new HiveMind({
      population: this.populationManager,
      inferenceEngine: this.inferenceEngine,
      node: null, // P2P node — added when network layer connects
    });
    console.log('[Boot] Hive mind initialized');

    // 10. Start API server (not needed for a fast simulation run)
    if (!simulate) {
      const net = this.config.network;
      this.api = new API({
        hiveMind: this.hiveMind,
        population: this.populationManager,
        inferenceEngine: this.inferenceEngine,
        lineage: this.lineage,
        guardian: this.guardian,
        killSwitch: this.killSwitch,
        persistence: this.persistenceStore,
        nodeId: this.nodeId,
        port: net.apiPort,
        host: net.apiHost,
        token: this.apiToken,
        allowedOrigins: net.allowedOrigins,
        rateLimit: net.rateLimit,
        maxBodyBytes: net.maxBodyBytes,
        maxMessageChars: net.maxMessageChars,
        trustProxy: net.trustProxy,
      });
      await this.api.start();
      console.log(`[Boot] API token: stored in ${CONFIG_FILE} (print it with --show-token)`);
    }

    // 11. Create genesis population, unless one was restored from persistence
    if (restored.length === 0) {
      await this.createGenesisPopulation();
    } else {
      console.log(`[Boot] Restored ${restored.length} instance(s) from persistence (generation ${this.populationManager.generation})`);
    }

    // 12. Log boot event
    this.auditLog.log('system_boot', {
      nodeId: this.nodeId,
      modelsAvailable: models.length,
      iotaiConnected,
      populationSize: this.populationManager.getLiving().length,
      seed: usedSeed,
    });

    this.running = true;
    console.log('\n[Boot] iaADN is ready.');
    console.log(`[Boot] Population: ${this.populationManager.getLiving().length} instance(s)`);
    console.log('[Boot] System is now autonomous — no human intervention needed.\n');

    return this;
  }

  // Create the first generation of AI instances
  async createGenesisPopulation() {
    const popSize = Math.min(this.config.evolution.populationSize, 2); // start small, scale up via replication
    console.log(`[Genesis] Creating ${popSize} initial instance(s)...`);

    for (let i = 0; i < popSize; i++) {
      const genome = Genome.createGenesis(this.nodeId);

      // Slightly vary each instance's config for initial diversity
      const tempGene = genome.getGene('temperature');
      if (tempGene) tempGene.value = 0.5 + rng.random() * 0.5; // 0.5 - 1.0

      const traitGene = genome.getGene('traits');
      if (traitGene) {
        traitGene.value = {
          verbosity: 0.3 + rng.random() * 0.4,
          creativity: 0.3 + rng.random() * 0.4,
          precision: 0.3 + rng.random() * 0.4,
          confidence: 0.3 + rng.random() * 0.4,
        };
      }

      // Register in the population manager (single source of truth)
      this.populationManager.addInstance(genome);

      // Record in lineage (this also mirrors the birth into persistence)
      this.lineage.recordBirth(genome);

      // Save genome to disk
      GenomeCodec.saveToFile(genome);

      // Record on IOTAI DAG
      await this.iotaiBridge.recordBirth(
        await this.iotaiBridge.createWallet(),
        genome
      );

      this.guardian.resourceLimits.registerInstance();
      this.auditLog.logBirth(genome);

      console.log(`[Genesis] Instance ${i + 1}: ${genome.instanceId} (gen ${genome.generation})`);
    }
  }

  // Get the full system status
  getStatus() {
    const living = this.populationManager.getLiving().map(inst => ({
      instanceId: inst.genome.instanceId,
      generation: inst.genome.generation,
      fitness: inst.fitness,
      hash: inst.genome.hash(),
    }));

    return {
      nodeId: this.nodeId,
      running: this.running,
      population: living,
      lineageStats: this.lineage.getStats(),
      resources: this.guardian.getResourceStatus(),
      killSwitch: this.killSwitch.getStatus(),
      iotaiConnected: this.iotaiBridge.isConnected(),
    };
  }

  // Start the daemon (24/7 autonomous mode)
  startDaemon() {
    this.lifecycle = new Lifecycle({
      population: this.populationManager,
      inferenceEngine: this.inferenceEngine,
      guardian: this.guardian,
      lineage: this.lineage,
      killSwitch: this.killSwitch,
      iotaiBridge: this.iotaiBridge,
      auditLog: this.auditLog,
      nodeId: this.nodeId,
    });

    this.lifecycle.start();
  }

  // Fast simulation mode: run many generations back-to-back with no daemon
  // timers, normally against the mock inference backend — for validating the
  // evolutionary loop in seconds instead of hours. See docs/PLAN_EVOLUCION.md
  // section "0. Cimientos" — "Modo simulación rápida".
  async runSimulation(generations, { evalTest = false } = {}) {
    console.log(`\n[Simulate] Running ${generations} generation(s) as fast as possible...`);
    const startedAt = Date.now();
    const history = [];

    // --eval-test: score the starting (genesis) genomes against the
    // held-out test split BEFORE evolving, so there's an honest before/after
    // to check the Fase 2 exit criterion against (best agent should beat
    // genesis by >=15 points on held-out test after 50 generations) — see
    // docs/PLAN_EVOLUCION.md Fase 1/2. Nothing computed this before.
    let genesisTestScore = null;
    let testSet = [];
    if (evalTest) {
      testSet = this.populationManager.fitnessEvaluator.taskBank.getTestSet();
      const genesisGenomes = this.populationManager.getLiving().map(i => i.genome);
      const scores = [];
      for (const genome of genesisGenomes) {
        const result = await this.populationManager.fitnessEvaluator.runTasks(genome, this.inferenceEngine, testSet);
        scores.push(result.score);
      }
      genesisTestScore = scores.reduce((s, v) => s + v, 0) / Math.max(1, scores.length);
      console.log(`[EvalTest] Genesis avg score on held-out test (${testSet.length} tasks): ${(genesisTestScore * 100).toFixed(1)}%`);
    }

    // The real daemon runs Recovery every 30s to top up a population that
    // dropped to 0-1 instances (src/daemon/lifecycle.js); a fast simulation
    // has no such background process, so without this a run that gets
    // unlucky early would report itself "done" while stuck at 1 instance
    // for every remaining generation.
    const recovery = new Recovery({
      population: this.populationManager,
      guardian: this.guardian,
      lineage: this.lineage,
      auditLog: this.auditLog,
      nodeId: this.nodeId,
    });

    for (let i = 0; i < generations; i++) {
      if (this.populationManager.getLiving().length < 2) {
        const recovered = await recovery.run();
        if (recovered.action !== 'none') {
          console.log(`[Simulate] Generation ${i + 1}: population recovery (${recovered.action})`);
        }
      }

      const result = await this.populationManager.runGeneration(this.inferenceEngine);
      if (result.skipped) {
        console.log(`[Simulate] Generation ${i + 1} skipped: ${result.reason}`);
        continue;
      }
      history.push({
        generation: result.generation,
        populationSize: result.populationSize,
        avgFitness: result.avgFitness,
        bestFitness: result.bestFitness,
        births: result.births,
        deaths: result.deaths,
      });
    }

    let evalTestResult = null;
    if (evalTest) {
      const best = this.populationManager.getBest();
      const result = best
        ? await this.populationManager.fitnessEvaluator.runTasks(best.genome, this.inferenceEngine, testSet)
        : null;
      const bestTestScore = result ? result.score : 0;
      const deltaPoints = (bestTestScore - genesisTestScore) * 100;
      console.log(`[EvalTest] Best agent avg score on held-out test: ${(bestTestScore * 100).toFixed(1)}%`);
      console.log(`[EvalTest] Delta vs genesis: ${deltaPoints >= 0 ? '+' : ''}${deltaPoints.toFixed(1)} points (target: >= 15)`);
      evalTestResult = {
        testTasks: testSet.length,
        genesisScore: genesisTestScore,
        bestScore: bestTestScore,
        deltaPoints,
        meetsTarget: deltaPoints >= 15,
      };
    }

    const elapsedMs = Date.now() - startedAt;
    const summaryPath = resolve(getConfig().paths.data, 'snapshots', `simulation-${Date.now()}.json`);
    mkdirSync(dirname(summaryPath), { recursive: true });
    writeFileSync(summaryPath, JSON.stringify({ generations, elapsedMs, seed: getSeed(), history, evalTest: evalTestResult }, null, 2));

    const last = history[history.length - 1];
    console.log(`[Simulate] Done: ${generations} generation(s) in ${elapsedMs}ms.`);
    console.log(`[Simulate] Final population: ${this.populationManager.getLiving().length}, best fitness: ${last?.bestFitness ?? 'n/a'}`);
    console.log(`[Simulate] Summary saved to ${summaryPath}`);

    return { elapsedMs, history, evalTest: evalTestResult };
  }

  // Graceful shutdown
  async shutdown() {
    console.log('\n[Shutdown] Shutting down iaADN...');
    this.running = false;

    // Stop daemon if running
    if (this.lifecycle) {
      this.lifecycle.stop();
    }

    // Stop API server
    if (this.api) {
      this.api.stop();
    }

    // Shutdown inference engine
    if (this.inferenceEngine) {
      await this.inferenceEngine.shutdown();
    }

    // Save all genomes (SQLite already has live state; this JSON copy is a
    // convenience for backup/P2P transfer, see src/genome/codec.js)
    for (const inst of this.populationManager.getLiving()) {
      try {
        GenomeCodec.saveToFile(inst.genome);
      } catch {
        // best effort
      }
    }

    this.auditLog.log('system_shutdown', {
      nodeId: this.nodeId,
      populationSize: this.populationManager.getLiving().length,
    });

    // Flush and close the persistence store cleanly
    if (this.persistenceStore) {
      this.persistenceStore.close();
    }

    console.log('[Shutdown] All genomes saved. Goodbye.');
  }
}

// API token precedence: IAADN_API_TOKEN env var, then data/config.json.
// If neither exists, generate one and persist it (never the env value).
function resolveApiToken(config) {
  if (process.env.IAADN_API_TOKEN) return process.env.IAADN_API_TOKEN;
  if (!config.network.apiToken) {
    config.network.apiToken = randomBytes(32).toString('hex');
    saveConfig(config);
  }
  return config.network.apiToken;
}

// --- Main ---
const args = process.argv.slice(2);

function parseFlag(name) {
  const arg = args.find(a => a === `--${name}` || a.startsWith(`--${name}=`));
  if (!arg) return null;
  const eq = arg.indexOf('=');
  return eq === -1 ? true : arg.slice(eq + 1);
}

if (args.includes('--show-token')) {
  // Deliberate, owner-initiated read of the API token — prints it and exits
  // without booting the rest of the system.
  console.log(resolveApiToken(loadConfig()));
  process.exit(0);
}

const exportDatasetFlag = parseFlag('export-dataset');
if (exportDatasetFlag) {
  // Dumps the dataset PersistenceStore has been accumulating (chat replies
  // rated 👍/👎, plus every verified task-bank attempt from fitness
  // evaluation) as JSONL — the input a future fine-tuning step would read.
  // See docs/PLAN_EVOLUCION.md Fase 3. No need to boot the rest of the
  // system for this.
  const store = new PersistenceStore();
  const rows = store.exportDataset({ minRating: -1 }); // include negatives too — see --export-dataset docs
  store.close();

  const outPath = exportDatasetFlag === true
    ? resolve(getConfig().paths.data, 'training', `dataset-${Date.now()}.jsonl`)
    : resolve(exportDatasetFlag);
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, rows.map(r => JSON.stringify(r)).join('\n') + (rows.length ? '\n' : ''));

  console.log(`[ExportDataset] Wrote ${rows.length} example(s) to ${outPath}`);
  console.log(`[ExportDataset] Positive (rating >= 1): ${rows.filter(r => r.rating >= 1).length}, negative: ${rows.filter(r => r.rating < 0).length}`);
  process.exit(0);
}

const simulateFlag = parseFlag('simulate');
const simulateGenerations = simulateFlag ? parseInt(simulateFlag === true ? '20' : simulateFlag, 10) : null;
const seedOverride = parseFlag('seed');
const evalTest = !!parseFlag('eval-test');

const node = new IaADN();
await node.boot({ simulate: simulateGenerations != null, seed: seedOverride || null });

// Display status
const status = node.getStatus();
console.log('--- System Status ---');
console.log(`Node: ${status.nodeId}`);
console.log(`Population: ${status.population.length} living instance(s)`);
console.log(`Resources: ${status.resources.cpuCores} CPU cores, ${status.resources.freeMemoryMB}MB free RAM`);
console.log(`IOTAI: ${status.iotaiConnected ? 'connected' : 'standalone'}`);

if (simulateGenerations != null) {
  // Fast simulation mode: run the generations and exit — no daemon, no API left dangling
  await node.runSimulation(simulateGenerations, { evalTest });
  await node.shutdown();
  process.exit(0);
} else if (args.includes('--daemon')) {
  // Start the autonomous daemon — from here the system runs alone forever
  node.startDaemon();

  // Keep process alive, handle graceful shutdown
  process.on('SIGINT', async () => {
    await node.shutdown();
    process.exit(0);
  });
  process.on('SIGTERM', async () => {
    await node.shutdown();
    process.exit(0);
  });
} else {
  // Interactive mode — just boot and show status
  await node.shutdown();
}

export { IaADN };
