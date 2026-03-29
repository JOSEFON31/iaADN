// iaADN - Router: routes queries to the best handler
// Decides whether to handle locally, decompose, or forward to peers

export class QueryRouter {
  constructor({ hiveMind, population, node }) {
    this.hiveMind = hiveMind;
    this.population = population;
    this.node = node;
  }

  // Route a query to the best handler
  async route(query) {
    const complexity = this._estimateComplexity(query);
    const localCapability = this._assessLocalCapability(query);

    // Simple query + good local instance = handle directly
    if (complexity < 0.3 && localCapability > 0.5) {
      return { strategy: 'direct', handler: 'local' };
    }

    // Complex query = decompose via hive mind
    if (complexity > 0.5) {
      return { strategy: 'hive_mind', handler: 'decompose' };
    }

    // Medium complexity + peers available = check if a peer is better
    if (this.node?.peers?.size > 0) {
      const peers = this.node.getPeers();
      const queryType = this._classifyType(query);
      const bestPeer = peers.find(p => p.capabilities?.specializations?.includes(queryType));

      if (bestPeer) {
        return { strategy: 'delegate', handler: 'peer', peerId: bestPeer.peerId };
      }
    }

    // Default: handle locally via hive mind
    return { strategy: 'hive_mind', handler: 'local' };
  }

  // Estimate query complexity (0 = simple, 1 = very complex)
  _estimateComplexity(query) {
    let score = 0;

    // Length
    if (query.length > 200) score += 0.2;
    if (query.length > 500) score += 0.2;

    // Multiple questions
    const questionMarks = (query.match(/\?/g) || []).length;
    score += Math.min(0.3, questionMarks * 0.1);

    // Multi-step indicators
    const multiStepWords = ['and then', 'after that', 'also', 'additionally', 'first', 'second', 'finally'];
    for (const word of multiStepWords) {
      if (query.toLowerCase().includes(word)) score += 0.1;
    }

    return Math.min(1, score);
  }

  // Assess local capability for this query
  _assessLocalCapability(query) {
    const living = this.population.getLiving();
    if (living.length === 0) return 0;

    const queryType = this._classifyType(query);
    let bestMatch = 0;

    for (const inst of living) {
      const spec = inst.genome.getSpecialization();
      const match = spec[queryType] || spec.general || 0.5;
      const fitness = inst.fitness ?? 0.5;
      bestMatch = Math.max(bestMatch, match * 0.7 + fitness * 0.3);
    }

    return bestMatch;
  }

  _classifyType(query) {
    const lower = query.toLowerCase();
    if (/code|function|program|debug|api/i.test(lower)) return 'code';
    if (/analyze|compare|evaluate/i.test(lower)) return 'analysis';
    if (/research|find|search/i.test(lower)) return 'research';
    if (/write|create|design|story/i.test(lower)) return 'creative';
    return 'general';
  }
}
