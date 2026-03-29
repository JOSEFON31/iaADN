#!/usr/bin/env node
// iaADN - Decentralized Self-Evolving AI System
// Entry point: boots the system, initializes all components
// After boot, the daemon runs 24/7 autonomously — no human needed

import { loadConfig, getConfig, saveConfig } from './config.js';
import { Genome } from './genome/genome.js';
import { GenomeCodec } from './genome/codec.js';
import { Lineage } from './genome/lineage.js';
import { InferenceEngine } from './inference/engine.js';
import { LlamaBackend } from './inference/llama-backend.js';
import { ModelRegistry } from './inference/model-registry.js';
import { SafetyGuardian } from './safety/guardian.js';
import { AuditLog } from './safety/audit-log.js';
import { KillSwitch } from './safety/kill-switch.js';
import { IOTAIBridge } from './integration/iotai-bridge.js';
import { Population } from './evolution/population.js';
import { Lifecycle } from './daemon/lifecycle.js';
import { HiveMind } from './hive/mind.js';
import { API } from './integration/api.js';
import { randomBytes } from 'crypto';

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
    this.population = new Map(); // instanceId -> { genome, fitness, engine }
    this.hiveMind = null;
    this.api = null;
    this.running = false;
  }

  async boot() {
    console.log('=== iaADN - Decentralized Self-Evolving AI ===');
    console.log('Initializing...\n');

    // 1. Load configuration
    this.config = loadConfig();
    this.nodeId = this.config.nodeId || ('node_' + randomBytes(8).toString('hex'));
    if (!this.config.nodeId) {
      this.config.nodeId = this.nodeId;
      saveConfig(this.config);
    }
    console.log(`[Boot] Node ID: ${this.nodeId}`);

    // 2. Initialize safety systems FIRST (before anything else)
    this.auditLog = new AuditLog();
    this.killSwitch = new KillSwitch(this.auditLog);
    this.guardian = new SafetyGuardian(this.auditLog);
    console.log('[Boot] Safety systems initialized');

    // Wire up kill switch
    this.killSwitch.on('activated', ({ reason }) => {
      console.error(`\n[EMERGENCY] Kill switch activated: ${reason}`);
      this.shutdown();
    });

    // 3. Initialize lineage tracking
    this.lineage = new Lineage();
    console.log('[Boot] Lineage tracking initialized');

    // 4. Initialize model registry
    this.modelRegistry = new ModelRegistry();
    const models = this.modelRegistry.listModels();
    console.log(`[Boot] Model registry: ${models.length} model(s) available`);

    // 5. Initialize inference engine
    const bestModel = this.modelRegistry.getBestModel();
    if (bestModel) {
      const backend = new LlamaBackend(bestModel.path);
      this.inferenceEngine = new InferenceEngine(backend);
      try {
        await this.inferenceEngine.initialize();
        console.log(`[Boot] Inference engine: loaded ${bestModel.name} (${bestModel.sizeMB}MB)`);
      } catch (err) {
        console.warn(`[Boot] Inference engine failed to load: ${err.message}`);
        console.log('[Boot] Continuing in mock mode');
      }
    } else {
      console.log('[Boot] No models found — inference will use mock mode');
    }

    // 6. Connect to IOTAI
    this.iotaiBridge = new IOTAIBridge();
    const iotaiConnected = await this.iotaiBridge.connect();
    console.log(`[Boot] IOTAI bridge: ${iotaiConnected ? 'connected' : 'standalone mode'}`);

    // 7. Initialize population manager
    this.populationManager = new Population({
      guardian: this.guardian,
      lineage: this.lineage,
      auditLog: this.auditLog,
    });

    // 8. Initialize hive mind
    this.hiveMind = new HiveMind({
      population: this.populationManager,
      inferenceEngine: this.inferenceEngine,
      node: null, // P2P node — added when network layer connects
    });
    console.log('[Boot] Hive mind initialized');

    // 9. Start API server
    this.api = new API({
      hiveMind: this.hiveMind,
      population: this.populationManager,
      inferenceEngine: this.inferenceEngine,
      lineage: this.lineage,
      guardian: this.guardian,
      killSwitch: this.killSwitch,
      nodeId: this.nodeId,
      port: this.config.network.apiPort,
    });
    this.api.start();

    // 10. Create genesis population (if no existing instances)
    if (this.population.size === 0) {
      await this.createGenesisPopulation();
    }

    // 11. Log boot event
    this.auditLog.log('system_boot', {
      nodeId: this.nodeId,
      modelsAvailable: models.length,
      iotaiConnected,
      populationSize: this.population.size,
    });

    this.running = true;
    console.log('\n[Boot] iaADN is ready.');
    console.log(`[Boot] Population: ${this.population.size} instance(s)`);
    console.log('[Boot] System is now autonomous — no human intervention needed.\n');

    return this;
  }

  // Create the first generation of AI instances
  async createGenesisPopulation() {
    const popSize = Math.min(this.config.evolution.populationSize, 3); // start small
    console.log(`[Genesis] Creating ${popSize} initial instance(s)...`);

    for (let i = 0; i < popSize; i++) {
      const genome = Genome.createGenesis(this.nodeId);

      // Slightly vary each instance's config for initial diversity
      const tempGene = genome.getGene('temperature');
      if (tempGene) tempGene.value = 0.5 + Math.random() * 0.5; // 0.5 - 1.0

      const traitGene = genome.getGene('traits');
      if (traitGene) {
        traitGene.value = {
          verbosity: 0.3 + Math.random() * 0.4,
          creativity: 0.3 + Math.random() * 0.4,
          precision: 0.3 + Math.random() * 0.4,
          confidence: 0.3 + Math.random() * 0.4,
        };
      }

      // Register in population
      this.population.set(genome.instanceId, {
        genome,
        fitness: null,
        alive: true,
      });

      // Record in lineage
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
    const living = [];
    for (const [id, inst] of this.population) {
      if (inst.alive) {
        living.push({
          instanceId: id,
          generation: inst.genome.generation,
          fitness: inst.fitness,
          hash: inst.genome.hash(),
        });
      }
    }

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
    // Sync population manager with raw population map
    for (const [id, inst] of this.population) {
      if (inst.alive) {
        this.populationManager.addInstance(inst.genome, inst.fitness);
      }
    }

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

    // Save all genomes
    for (const [id, inst] of this.population) {
      if (inst.alive) {
        try {
          GenomeCodec.saveToFile(inst.genome);
        } catch {
          // best effort
        }
      }
    }

    this.auditLog.log('system_shutdown', {
      nodeId: this.nodeId,
      populationSize: this.population.size,
    });

    console.log('[Shutdown] All genomes saved. Goodbye.');
  }
}

// --- Main ---
const args = process.argv.slice(2);

const node = new IaADN();
await node.boot();

// Display status
const status = node.getStatus();
console.log('--- System Status ---');
console.log(`Node: ${status.nodeId}`);
console.log(`Population: ${status.population.length} living instance(s)`);
console.log(`Resources: ${status.resources.cpuCores} CPU cores, ${status.resources.freeMemoryMB}MB free RAM`);
console.log(`IOTAI: ${status.iotaiConnected ? 'connected' : 'standalone'}`);

if (args.includes('--daemon')) {
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
