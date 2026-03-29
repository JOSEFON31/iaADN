// iaADN - Lifecycle: the autonomous daemon that runs 24/7
// This is the heart of the system — once started, it never stops
// ZERO human dependency after the initial boot
//
// Cycle schedule:
//   heartbeat    — every 1 minute
//   auto-prune   — every 30 minutes
//   auto-evolve  — every 30 minutes
//   auto-program — every 1 hour
//   auto-replicate — every 1 hour
//   auto-learn   — every 2 hours
//   recovery     — every 30 seconds

import { CronScheduler } from './cron.js';
import { AutoEvolve } from './auto-evolve.js';
import { AutoProgram } from './auto-program.js';
import { AutoReplicate } from './auto-replicate.js';
import { AutoPrune } from './auto-prune.js';
import { AutoLearn } from './auto-learn.js';
import { Heartbeat } from './heartbeat.js';
import { Recovery } from './recovery.js';
import { getConfig } from '../config.js';

export class Lifecycle {
  constructor({ population, inferenceEngine, guardian, lineage, killSwitch, iotaiBridge, auditLog, nodeId }) {
    this.population = population;
    this.inferenceEngine = inferenceEngine;
    this.guardian = guardian;
    this.killSwitch = killSwitch;
    this.auditLog = auditLog;
    this.running = false;

    // Deferred promise — resolves when initial fitness evaluation completes
    this._evalReadyResolve = null;
    this._evalReady = new Promise(resolve => { this._evalReadyResolve = resolve; });

    const config = getConfig().daemon;

    // Initialize all autonomous modules
    this.autoEvolve = new AutoEvolve({ population, inferenceEngine, auditLog });
    this.autoProgram = new AutoProgram({ population, inferenceEngine, guardian, auditLog });
    this.autoReplicate = new AutoReplicate({ population, guardian, lineage, iotaiBridge, auditLog });
    this.autoPrune = new AutoPrune({ population, guardian, auditLog });
    this.autoLearn = new AutoLearn({ population, inferenceEngine, auditLog });
    this.heartbeat = new Heartbeat({ guardian, population, killSwitch });
    this.recovery = new Recovery({ population, guardian, lineage, auditLog, nodeId });

    // Set up cron scheduler
    this.cron = new CronScheduler();

    // Heartbeat and recovery start immediately — they don't depend on fitness
    this.cron.register('heartbeat', config.heartbeatInterval, () => this.heartbeat.run());
    this.cron.register('recovery', config.recoveryCheckInterval, () => this.recovery.run());

    // All fitness-dependent cycles wait for initial evaluation to complete
    this.cron.register('auto-prune', config.autoPruneInterval, () => this.autoPrune.run(), { gate: this._evalReady });
    this.cron.register('auto-evolve', config.autoEvolveInterval, () => this.autoEvolve.run(), { gate: this._evalReady });
    this.cron.register('auto-replicate', config.autoReplicateInterval, () => this.autoReplicate.run(), { gate: this._evalReady });
    this.cron.register('auto-program', config.autoProgramInterval, () => this.autoProgram.run(), { gate: this._evalReady });
    this.cron.register('auto-learn', config.autoLearnInterval, () => this.autoLearn.run(), { gate: this._evalReady });
  }

  // Start the daemon — from this point on, the system is fully autonomous
  start() {
    if (this.running) return;

    console.log('\n╔══════════════════════════════════════════════╗');
    console.log('║      iaADN DAEMON — AUTONOMOUS MODE          ║');
    console.log('║      No human intervention required           ║');
    console.log('║      The system will evolve on its own        ║');
    console.log('╚══════════════════════════════════════════════╝\n');

    this.running = true;

    // Listen for kill switch
    this.killSwitch.on('activated', () => {
      console.log('[Lifecycle] Kill switch activated, stopping daemon...');
      this.stop();
    });

    // Run initial fitness evaluation — gated cycles wait for this to complete
    this._initialEval().then(() => {
      console.log('[Lifecycle] Initial fitness evaluation complete');
    }).catch(err => {
      console.warn(`[Lifecycle] Initial eval failed: ${err.message}`);
    }).finally(() => {
      this._evalReadyResolve();
    });

    // Start all autonomous cycles
    this.cron.startAll();

    this.auditLog.log('daemon_started', {
      cycles: Object.keys(this.cron.getStatus()),
    });

    console.log('[Lifecycle] All autonomous cycles running:');
    const status = this.cron.getStatus();
    for (const [name, info] of Object.entries(status)) {
      console.log(`  ${name}: every ${Math.round(info.interval / 1000)}s`);
    }
    console.log('');
  }

  // Stop the daemon
  stop() {
    this.running = false;
    this.cron.stopAll();
    this.auditLog.log('daemon_stopped', {});
    console.log('[Lifecycle] Daemon stopped.');
  }

  // Evaluate fitness for all instances that haven't been evaluated yet
  async _initialEval() {
    const living = this.population.getLiving();
    const unevaluated = living.filter(i => i.fitness == null);
    if (unevaluated.length === 0) return;

    console.log(`[Lifecycle] Evaluating ${unevaluated.length} unevaluated instance(s)...`);
    await this.population.evaluateAll(this.inferenceEngine);
    const stats = this.population.getStats();
    console.log(`[Lifecycle] Avg fitness: ${stats.avgFitness}, Best: ${stats.bestFitness}`);
  }

  // Get full daemon status
  getStatus() {
    return {
      running: this.running,
      cycles: this.cron.getStatus(),
      health: this.heartbeat.getHealth(),
      population: this.population.getStats(),
      recoveries: this.recovery.recoveryCount,
    };
  }
}
