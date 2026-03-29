// iaADN - Recovery: auto-recovery when things go wrong
// If a cycle fails, restart it. If population dies, recreate genesis.

import { Genome } from '../genome/genome.js';
import { GenomeCodec } from '../genome/codec.js';

export class Recovery {
  constructor({ population, guardian, lineage, auditLog, nodeId }) {
    this.population = population;
    this.guardian = guardian;
    this.lineage = lineage;
    this.auditLog = auditLog;
    this.nodeId = nodeId;
    this.recoveryCount = 0;
  }

  // Check if recovery is needed and execute it
  async run() {
    const living = this.population.getLiving();

    // If population is extinct, create new genesis
    if (living.length === 0) {
      console.log('[Recovery] Population extinct! Creating new genesis...');
      await this._recreateGenesis();
      this.recoveryCount++;
      return { action: 'genesis_recreation', newInstances: this.population.getLiving().length };
    }

    // If population is critically low (only 1), replicate to ensure diversity
    if (living.length === 1) {
      console.log('[Recovery] Population critically low, creating diversity...');
      await this._createDiversity(living[0]);
      this.recoveryCount++;
      return { action: 'diversity_creation', newInstances: this.population.getLiving().length };
    }

    return { action: 'none', healthy: true };
  }

  async _recreateGenesis() {
    const count = 3;
    for (let i = 0; i < count; i++) {
      const genome = Genome.createGenesis(this.nodeId);

      // Add variation
      const tempGene = genome.getGene('temperature');
      if (tempGene) tempGene.value = 0.4 + Math.random() * 0.6;

      this.population.addInstance(genome);
      this.lineage.recordBirth(genome);
      this.guardian.resourceLimits.registerInstance();
      GenomeCodec.saveToFile(genome);
      this.auditLog.logBirth(genome);
    }

    this.auditLog.log('recovery', { type: 'genesis_recreation', count });
  }

  async _createDiversity(survivor) {
    const child = survivor.genome.replicate();

    // Apply strong mutations for diversity
    const tempGene = child.getGene('temperature');
    if (tempGene) tempGene.value = Math.random() * 1.5 + 0.2;

    const traitGene = child.getGene('traits');
    if (traitGene) {
      for (const key of Object.keys(traitGene.value)) {
        traitGene.value[key] = Math.random();
      }
    }

    this.population.addInstance(child);
    this.lineage.recordBirth(child);
    this.guardian.resourceLimits.registerInstance();
    GenomeCodec.saveToFile(child);
    this.auditLog.logBirth(child);
    this.auditLog.log('recovery', { type: 'diversity_creation', parentId: survivor.genome.instanceId });
  }
}
