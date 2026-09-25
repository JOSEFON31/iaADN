// iaADN - Sync: synchronize genomes and population state across nodes

import { GenomeCodec } from '../genome/codec.js';

export class GenomeSync {
  constructor({ node, population, lineage }) {
    this.node = node;
    this.population = population;
    this.lineage = lineage;
  }

  // Sync local state to all peers (gossip)
  async gossipState() {
    const stats = this.population.getStats();
    const living = this.population.getLiving().map(inst => ({
      instanceId: inst.genome.instanceId,
      generation: inst.genome.generation,
      fitness: inst.fitness,
      hash: inst.genome.hash(),
      specialization: inst.genome.getSpecialization(),
    }));

    await this.node.broadcast('/iaADN/gossip/1.0.0', {
      type: 'gossip_state',
      data: {
        population: living.length,
        stats,
        instances: living,
      },
      senderId: this.node.nodeId,
      timestamp: Date.now(),
    });
  }

  // Request a genome from a peer
  async requestGenome(peerId, instanceId) {
    await this.node.sendToPeer(peerId, '/iaADN/genome/1.0.0', {
      type: 'genome_request',
      data: { instanceId },
      senderId: this.node.nodeId,
    });
  }

  // Announce birth to network, including the full signed genome (not just
  // the lightweight birth record) so a receiving node can adopt it directly
  // without a follow-up request. See docs/PLAN_EVOLUCION.md Fase 4.
  async announceBirth(genome) {
    await this.node.broadcast('/iaADN/evolution/1.0.0', {
      type: 'birth_announcement',
      data: {
        ...GenomeCodec.createBirthRecord(genome),
        envelope: GenomeCodec.toTransferFormat(genome, this.node.identity),
      },
      senderId: this.node.nodeId,
    });
  }

  // Announce death to network
  async announceDeath(instanceId, reason) {
    await this.node.broadcast('/iaADN/evolution/1.0.0', {
      type: 'death_announcement',
      data: { instanceId, reason },
      senderId: this.node.nodeId,
    });
  }
}
