// iaADN - Auto Replicate: autonomous replication of the best instances
// Creates improved copies and deploys them
// NO HUMAN INTERVENTION NEEDED

import { GenomeCodec } from '../genome/codec.js';
import { MutationEngine } from '../evolution/mutation.js';

export class AutoReplicate {
  constructor({ population, guardian, lineage, iotaiBridge, auditLog }) {
    this.population = population;
    this.guardian = guardian;
    this.lineage = lineage;
    this.iotaiBridge = iotaiBridge;
    this.auditLog = auditLog;
    this.mutationEngine = new MutationEngine({ mutationRate: 0.1, maxMagnitude: 0.15 });
  }

  // Run one autonomous replication cycle
  async run() {
    const best = this.population.getBest();
    if (!best) {
      console.log('[AutoReplicate] No instances to replicate');
      return { skipped: true };
    }

    // Check if we can spawn more instances
    const spawnCheck = this.guardian.canSpawn();
    if (!spawnCheck.allowed) {
      console.log(`[AutoReplicate] Cannot spawn: ${spawnCheck.reason}`);
      return { skipped: true, reason: spawnCheck.reason };
    }

    console.log(`[AutoReplicate] Replicating best instance: ${best.genome.instanceId} (fitness: ${best.fitness})`);

    // 1. Create an improved copy
    const child = best.genome.replicate();

    // 2. Apply targeted mutations (small improvements)
    const mutations = this.mutationEngine.mutate(child);

    // 3. Validate with guardian
    const validation = this.guardian.validateMutation(best.genome, child);
    if (!validation.valid) {
      console.log(`[AutoReplicate] Child rejected: ${validation.errors.join(', ')}`);
      return { success: false, reason: 'guardian_rejected' };
    }

    // 4. Register the child
    this.population.addInstance(child);
    this.lineage.recordBirth(child);
    this.guardian.resourceLimits.registerInstance();
    this.auditLog.logBirth(child);

    // 5. Save genome
    GenomeCodec.saveToFile(child);

    // 6. Record on IOTAI DAG
    const wallet = await this.iotaiBridge.createWallet();
    await this.iotaiBridge.recordBirth(wallet, child);

    console.log(`[AutoReplicate] New instance: ${child.instanceId} (gen ${child.generation}, ${mutations.length} mutations)`);

    return {
      success: true,
      parentId: best.genome.instanceId,
      childId: child.instanceId,
      generation: child.generation,
      mutations: mutations.length,
    };
  }
}
