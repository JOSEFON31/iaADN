// iaADN - Distributor: assigns sub-queries to the best AI instances
// Matches each sub-query to the instance best suited to handle it

export class QueryDistributor {
  constructor({ population, node }) {
    this.population = population;
    this.node = node;
  }

  // Distribute sub-queries to instances
  async distribute(subQueries) {
    const assignments = [];

    for (const sq of subQueries) {
      const instance = this._findBestInstance(sq.type);
      assignments.push({
        subQuery: sq,
        instanceId: instance?.genome?.instanceId || null,
        nodeId: this.node?.nodeId || 'local',
        local: true, // for now, all local. P2P distribution in future
      });
    }

    // Also check remote peers for better matches
    if (this.node?.peers?.size > 0) {
      for (const assignment of assignments) {
        if (!assignment.instanceId) {
          const peer = this._findBestPeer(assignment.subQuery.type);
          if (peer) {
            assignment.nodeId = peer.peerId;
            assignment.local = false;
          }
        }
      }
    }

    return assignments;
  }

  // Find the best local instance for a query type
  _findBestInstance(queryType) {
    const living = this.population.getLiving();
    if (living.length === 0) return null;

    let bestInstance = null;
    let bestScore = -1;

    for (const inst of living) {
      const spec = inst.genome.getSpecialization();
      const matchScore = spec[queryType] || spec.general || 0.5;
      const fitnessBonus = (inst.fitness ?? 0.5) * 0.3;
      const totalScore = matchScore + fitnessBonus;

      if (totalScore > bestScore) {
        bestScore = totalScore;
        bestInstance = inst;
      }
    }

    return bestInstance;
  }

  // Find the best remote peer for a query type
  _findBestPeer(queryType) {
    const peers = this.node.getPeers();
    if (peers.length === 0) return null;

    // Pick peer with relevant specialization (from gossip state)
    for (const peer of peers) {
      if (peer.capabilities?.specializations?.includes(queryType)) {
        return peer;
      }
    }

    // Fallback: pick least loaded peer
    return peers.sort((a, b) => (a.population || 0) - (b.population || 0))[0];
  }
}
